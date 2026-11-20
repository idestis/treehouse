//! Sign in, two-step code, join with an invite, sign out.

use axum::{Json, extract::State};
use serde::Deserialize;
use serde_json::{Value, json};
use totp_rs::{Algorithm, Secret, TOTP};

use crate::{
    auth::{self, AuthedAny},
    error::{AppError, AppResult, is_unique_violation},
    events,
    http::AppState,
    util,
};

const MAX_TRIES: i32 = 5;

#[derive(Deserialize)]
pub struct LoginIn {
    username: String,
    password: String,
    #[serde(default)]
    remember: bool,
    #[serde(default)]
    device_name: String,
}

fn locked() -> AppError {
    AppError::too_many("locked", "Too many wrong tries. Wait 15 minutes.")
}

pub async fn login(State(st): State<AppState>, Json(inp): Json<LoginIn>) -> AppResult<Json<Value>> {
    let wrong = || AppError::unauthorized("bad_login", "Wrong username or password.");
    let username = inp.username.trim();
    // Read what the password check needs without holding a connection or a
    // transaction while argon2 runs. The rules are checked again below, under
    // the row lock, before anything is written.
    let pre = sqlx::query!(
        r#"SELECT password_hash, (locked_until IS NOT NULL AND locked_until > now()) AS "locked!"
           FROM users WHERE username = $1::text::citext"#,
        username
    )
    .fetch_optional(&st.db)
    .await?;
    let Some(pre) = pre else {
        // Same work as a real verify, so an unknown username isn't faster.
        auth::dummy_verify_async(&st.hashing, inp.password.clone()).await?;
        return Err(wrong());
    };
    if pre.locked {
        return Err(locked());
    }
    let password_ok =
        auth::verify_password_async(&st.hashing, pre.password_hash.clone(), inp.password.clone())
            .await?;

    let mut tx = st.db.begin().await?;
    let user = sqlx::query!(
        r#"SELECT u.id, u.password_hash, u.blocked_at IS NOT NULL AS "blocked!",
                  (u.locked_until IS NOT NULL AND u.locked_until > now()) AS "locked!",
                  (m.confirmed_at IS NOT NULL) AS "mfa!"
           FROM users u LEFT JOIN mfa m ON m.user_id = u.id
           WHERE u.username = $1::text::citext FOR UPDATE OF u"#,
        username
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(wrong)?;
    if user.locked {
        return Err(locked());
    }
    // The password changed while we were hashing: the answer we have is for
    // the old one. Ask again rather than count it either way.
    if user.password_hash != pre.password_hash {
        return Err(wrong());
    }
    if !password_ok {
        sqlx::query!(
            "UPDATE users SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                              locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
             WHERE id = $1",
            user.id,
            MAX_TRIES
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(wrong());
    }
    if user.blocked {
        return Err(AppError::forbidden(
            "blocked",
            "This account is blocked. Talk to your crew admin.",
        ));
    }
    // A correct password clears wrong-password tries only. Wrong two-step
    // codes (failed_mfa) are cleared only by a correct code.
    sqlx::query!(
        "UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1",
        user.id
    )
    .execute(&mut *tx)
    .await?;

    if user.mfa {
        let challenge = util::new_token();
        sqlx::query!(
            "INSERT INTO mfa_challenges (token_hash, user_id, device_name, remember, expires_at)
             VALUES ($1, $2, $3, $4, now() + interval '5 minutes')",
            util::sha256(&challenge),
            user.id,
            inp.device_name,
            inp.remember
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Json(
            json!({ "status": "mfa_required", "mfa_token": challenge }),
        ));
    }

    let token = auth::create_session(&mut tx, user.id, &inp.device_name, inp.remember).await?;
    let me = auth::load_user_by_token(&mut tx, &token)
        .await?
        .ok_or_else(wrong)?;
    tx.commit().await?;
    Ok(Json(
        json!({ "status": "ok", "token": token, "me": me.me() }),
    ))
}

#[derive(Deserialize)]
pub struct MfaIn {
    mfa_token: String,
    code: Option<String>,
    backup_code: Option<String>,
}

pub fn totp(secret_b32: &str, username: &str, issuer: &str) -> AppResult<TOTP> {
    let secret = Secret::Encoded(secret_b32.to_string())
        .to_bytes()
        .map_err(|e| anyhow::anyhow!("bad totp secret: {e:?}"))?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret,
        Some(issuer.to_string()),
        username.to_string(),
    )
    .map_err(|e| AppError::Internal(anyhow::anyhow!("totp: {e}")))
}

/// The TOTP time step `code` belongs to, if it is valid now (within the
/// TOTP's skew) and newer than `last_step`, the newest step already used.
/// Refusing steps at or before `last_step` stops the same code being used
/// twice inside its window.
pub fn totp_step(t: &TOTP, code: &str, now: u64, last_step: Option<i64>) -> Option<i64> {
    let current = now / t.step;
    let skew = u64::from(t.skew);
    (current.saturating_sub(skew)..=current + skew)
        .filter_map(|step| i64::try_from(step).ok().map(|s| (step, s)))
        .filter(|&(_, s)| last_step.is_none_or(|last| s > last))
        .find(|&(step, _)| constant_time_eq(t.generate(step * t.step).as_bytes(), code.as_bytes()))
        .map(|(_, s)| s)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub async fn login_mfa(
    State(st): State<AppState>,
    Json(inp): Json<MfaIn>,
) -> AppResult<Json<Value>> {
    let expired =
        || AppError::unauthorized("mfa_expired", "That sign-in took too long. Start again.");
    let token_hash = util::sha256(&inp.mfa_token);
    let mut tx = st.db.begin().await?;
    let user_id = sqlx::query_scalar!(
        "SELECT user_id FROM mfa_challenges WHERE token_hash = $1",
        token_hash
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(expired)?;
    // Lock the account first: every code attempt for this person, on any
    // challenge, runs one at a time, so the per-account count and the backup
    // code list can't race.
    let user = sqlx::query!(
        r#"SELECT username::text AS "username!",
                  (locked_until IS NOT NULL AND locked_until > now()) AS "locked!"
           FROM users WHERE id = $1 FOR UPDATE"#,
        user_id
    )
    .fetch_one(&mut *tx)
    .await?;
    let ch = sqlx::query!(
        r#"SELECT c.device_name, c.remember, c.attempts, c.expires_at > now() AS "fresh!",
                  m.totp_secret, m.last_totp_step
           FROM mfa_challenges c
           JOIN mfa m ON m.user_id = c.user_id
           WHERE c.token_hash = $1 FOR UPDATE OF c, m"#,
        token_hash
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(expired)?;
    if user.locked {
        sqlx::query!("DELETE FROM mfa_challenges WHERE user_id = $1", user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(locked());
    }
    if !ch.fresh || ch.attempts >= MAX_TRIES {
        sqlx::query!(
            "DELETE FROM mfa_challenges WHERE token_hash = $1",
            token_hash
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(if ch.fresh {
            AppError::too_many("mfa_locked", "Too many wrong codes. Sign in again.")
        } else {
            expired()
        });
    }

    let ok = if let Some(code) = inp.backup_code.as_deref() {
        // Remove the code only if it is still there: zero rows means it was
        // never valid or was just used.
        let hash = util::sha256(&code.trim().to_lowercase());
        sqlx::query_scalar!(
            "UPDATE mfa SET backup_code_hashes = array_remove(backup_code_hashes, $2)
             WHERE user_id = $1 AND $2 = ANY(backup_code_hashes) RETURNING user_id",
            user_id,
            hash
        )
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
    } else {
        let code: String = inp
            .code
            .unwrap_or_default()
            .chars()
            .filter(char::is_ascii_digit)
            .collect();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| anyhow::anyhow!("clock before 1970: {e}"))?
            .as_secs();
        let t = totp(&ch.totp_secret, &user.username, "Treehouse")?;
        match totp_step(&t, &code, now, ch.last_totp_step) {
            Some(step) => {
                sqlx::query!(
                    "UPDATE mfa SET last_totp_step = $2 WHERE user_id = $1",
                    user_id,
                    step
                )
                .execute(&mut *tx)
                .await?;
                true
            }
            None => false,
        }
    };

    if !ok {
        sqlx::query!(
            "UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1",
            token_hash
        )
        .execute(&mut *tx)
        .await?;
        // Wrong codes add up per account, across challenges. A correct
        // password doesn't clear this; reaching the limit locks sign-in.
        let now_locked = sqlx::query_scalar!(
            r#"UPDATE users SET failed_mfa = CASE WHEN failed_mfa + 1 >= $2 THEN 0 ELSE failed_mfa + 1 END,
                                locked_until = CASE WHEN failed_mfa + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
               WHERE id = $1
               RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS "locked!""#,
            user_id,
            MAX_TRIES
        )
        .fetch_one(&mut *tx)
        .await?;
        if now_locked {
            sqlx::query!("DELETE FROM mfa_challenges WHERE user_id = $1", user_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Err(locked());
        }
        tx.commit().await?;
        return Err(AppError::unauthorized(
            "bad_code",
            "That code didn't work. Check your app and try the newest one.",
        ));
    }

    sqlx::query!("UPDATE users SET failed_mfa = 0 WHERE id = $1", user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query!(
        "DELETE FROM mfa_challenges WHERE token_hash = $1",
        token_hash
    )
    .execute(&mut *tx)
    .await?;
    let token = auth::create_session(&mut tx, user_id, &ch.device_name, ch.remember).await?;
    let me = auth::load_user_by_token(&mut tx, &token)
        .await?
        .ok_or_else(expired)?;
    tx.commit().await?;
    Ok(Json(json!({ "token": token, "me": me.me() })))
}

#[derive(Deserialize)]
pub struct JoinIn {
    code: String,
    display_name: String,
    username: String,
    password: String,
    color: String,
    #[serde(default)]
    device_name: String,
}

fn valid_username(u: &str) -> bool {
    (2..=24).contains(&u.len())
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

pub fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

pub fn clean_display_name(n: &str) -> AppResult<String> {
    let n = n.trim();
    if n.is_empty() || n.chars().count() > 32 {
        return Err(AppError::bad(
            "bad_name",
            "Pick a name between 1 and 32 characters.",
        ));
    }
    Ok(n.to_string())
}

fn bad_invite() -> AppError {
    AppError::bad(
        "bad_invite",
        "That invite doesn't work. It may have expired or been used. Ask for a new one.",
    )
}

pub async fn join(State(st): State<AppState>, Json(inp): Json<JoinIn>) -> AppResult<Json<Value>> {
    let username = inp.username.trim();
    if !valid_username(username) {
        return Err(AppError::bad(
            "bad_username",
            "Usernames are 2 to 24 letters, numbers, dots, dashes or underscores.",
        ));
    }
    let display_name = clean_display_name(&inp.display_name)?;
    if !valid_color(&inp.color) {
        return Err(AppError::bad("bad_color", "Pick a color."));
    }
    let treehouse = sqlx::query_scalar!("SELECT name FROM treehouse")
        .fetch_one(&st.db)
        .await?;
    let code = util::normalize_code(&inp.code, 5);
    // Cheap early answer for a bad invite, before any hashing. The UPDATE
    // below is still the real gate.
    let invite_usable = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM invites
                          WHERE code_hash = $1 AND uses < max_uses AND expires_at > now()) AS "ok!""#,
        util::sha256(&code)
    )
    .fetch_one(&st.db)
    .await?;
    if !invite_usable {
        return Err(bad_invite());
    }
    let hash = auth::check_and_hash_async(
        &st.hashing,
        inp.password.clone(),
        vec![username.to_string(), display_name.clone(), treehouse],
    )
    .await?;

    let mut tx = st.db.begin().await?;
    // The invite rule in one statement: never used past max_uses, never after expiry.
    let invite = sqlx::query!(
        "UPDATE invites SET uses = uses + 1
         WHERE code_hash = $1 AND uses < max_uses AND expires_at > now()
         RETURNING id, role, is_setup",
        util::sha256(&code)
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(bad_invite)?;

    let user_id = sqlx::query_scalar!(
        "INSERT INTO users (username, display_name, color, password_hash, role, is_owner, invite_id)
         VALUES ($1::text::citext, $2, $3, $4, $5, $6, $7) RETURNING id",
        username,
        display_name,
        inp.color,
        hash,
        invite.role,
        invite.is_setup,
        invite.id
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if is_unique_violation(&e) {
            AppError::conflict("username_taken", "That username is taken. Try another.")
        } else {
            e.into()
        }
    })?;

    events::emit(&mut tx, events::TREEHOUSE, "people", json!({})).await?;
    let token = auth::create_session(&mut tx, user_id, &inp.device_name, true).await?;
    let me = auth::load_user_by_token(&mut tx, &token)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("new user missing")))?;
    tx.commit().await?;
    tracing::info!(user_id, role = %me.role, owner = me.is_owner, "joined");
    Ok(Json(json!({ "token": token, "me": me.me() })))
}

pub async fn logout(
    State(st): State<AppState>,
    AuthedAny(user): AuthedAny,
) -> AppResult<Json<Value>> {
    sqlx::query!("DELETE FROM sessions WHERE id = $1", user.session_id)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({})))
}

#[derive(Deserialize)]
pub struct StrengthIn {
    password: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    display_name: String,
}

/// Live strength meter for the join and change-password forms. The same
/// check runs again when the password is actually set.
pub async fn password_check(
    State(st): State<AppState>,
    Json(inp): Json<StrengthIn>,
) -> AppResult<Json<auth::Strength>> {
    let treehouse = sqlx::query_scalar!("SELECT name FROM treehouse")
        .fetch_one(&st.db)
        .await?;
    Ok(Json(
        auth::password_strength_async(
            &st.hashing,
            inp.password,
            vec![inp.username, inp.display_name, treehouse],
        )
        .await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_totp() -> TOTP {
        // RFC 6238 test secret ("12345678901234567890").
        totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "max", "Treehouse").unwrap()
    }

    #[test]
    fn totp_step_accepts_codes_within_skew() {
        let t = test_totp();
        let now = 1_700_000_015;
        let step = (now / 30) as i64;
        for off in [-1i64, 0, 1] {
            let s = step + off;
            let code = t.generate(s as u64 * 30);
            assert_eq!(totp_step(&t, &code, now, None), Some(s));
        }
        let old = t.generate((step - 2) as u64 * 30);
        assert_eq!(totp_step(&t, &old, now, None), None);
        assert_eq!(totp_step(&t, "", now, None), None);
    }

    #[test]
    fn totp_step_refuses_replays() {
        let t = test_totp();
        let now = 1_700_000_015;
        let step = (now / 30) as i64;
        let code = t.generate(step as u64 * 30);
        // Used once: the same code (or any older one) is refused afterwards.
        assert_eq!(totp_step(&t, &code, now, Some(step)), None);
        assert_eq!(totp_step(&t, &code, now + 20, Some(step)), None);
        let prev = t.generate((step - 1) as u64 * 30);
        assert_eq!(totp_step(&t, &prev, now, Some(step)), None);
        // The next code still works.
        let next = t.generate((step + 1) as u64 * 30);
        assert_eq!(totp_step(&t, &next, now, Some(step)), Some(step + 1));
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq(b"123456", b"123456"));
        assert!(!constant_time_eq(b"123456", b"123457"));
        assert!(!constant_time_eq(b"12345", b"123456"));
    }
}
