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

pub async fn login(State(st): State<AppState>, Json(inp): Json<LoginIn>) -> AppResult<Json<Value>> {
    let wrong = || AppError::unauthorized("bad_login", "Wrong username or password.");
    let mut tx = st.db.begin().await?;
    let user = sqlx::query!(
        r#"SELECT u.id, u.password_hash, u.blocked_at IS NOT NULL AS "blocked!",
                  (u.locked_until IS NOT NULL AND u.locked_until > now()) AS "locked!",
                  (m.confirmed_at IS NOT NULL) AS "mfa!"
           FROM users u LEFT JOIN mfa m ON m.user_id = u.id
           WHERE u.username = $1::text::citext FOR UPDATE OF u"#,
        inp.username.trim()
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(user) = user else {
        auth::dummy_verify(&inp.password);
        return Err(wrong());
    };
    if user.locked {
        return Err(AppError::too_many(
            "locked",
            "Too many wrong tries. Wait 15 minutes.",
        ));
    }
    if !auth::verify_password(&user.password_hash, &inp.password) {
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

pub async fn login_mfa(
    State(st): State<AppState>,
    Json(inp): Json<MfaIn>,
) -> AppResult<Json<Value>> {
    let expired =
        || AppError::unauthorized("mfa_expired", "That sign-in took too long. Start again.");
    let mut tx = st.db.begin().await?;
    let ch = sqlx::query!(
        r#"SELECT c.user_id, c.device_name, c.remember, c.attempts, c.expires_at > now() AS "fresh!",
                  m.totp_secret, m.backup_code_hashes, u.username::text AS "username!"
           FROM mfa_challenges c
           JOIN mfa m ON m.user_id = c.user_id
           JOIN users u ON u.id = c.user_id
           WHERE c.token_hash = $1 FOR UPDATE OF c"#,
        util::sha256(&inp.mfa_token)
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(expired)?;
    if !ch.fresh || ch.attempts >= MAX_TRIES {
        sqlx::query!(
            "DELETE FROM mfa_challenges WHERE token_hash = $1",
            util::sha256(&inp.mfa_token)
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(if ch.fresh {
            AppError::too_many("locked", "Too many wrong codes. Sign in again.")
        } else {
            expired()
        });
    }

    let ok = if let Some(code) = inp.backup_code.as_deref() {
        let hash = util::sha256(&code.trim().to_lowercase());
        let found = ch.backup_code_hashes.contains(&hash);
        if found {
            sqlx::query!(
                "UPDATE mfa SET backup_code_hashes = array_remove(backup_code_hashes, $2) WHERE user_id = $1",
                ch.user_id,
                hash
            )
            .execute(&mut *tx)
            .await?;
        }
        found
    } else {
        let code: String = inp
            .code
            .unwrap_or_default()
            .chars()
            .filter(char::is_ascii_digit)
            .collect();
        totp(&ch.totp_secret, &ch.username, "Treehouse")?
            .check_current(&code)
            .unwrap_or(false)
    };

    if !ok {
        sqlx::query!(
            "UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1",
            util::sha256(&inp.mfa_token)
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(AppError::unauthorized(
            "bad_code",
            "That code didn't work. Check your app and try the newest one.",
        ));
    }

    sqlx::query!(
        "DELETE FROM mfa_challenges WHERE token_hash = $1",
        util::sha256(&inp.mfa_token)
    )
    .execute(&mut *tx)
    .await?;
    let token = auth::create_session(&mut tx, ch.user_id, &ch.device_name, ch.remember).await?;
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
    auth::check_new_password(&inp.password, &[username, &display_name, &treehouse])?;
    let hash = auth::hash_password(&inp.password)?;
    let code = util::normalize_code(&inp.code, 5);

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
    .ok_or_else(|| {
        AppError::bad(
            "bad_invite",
            "That invite doesn't work. It may have expired or been used. Ask for a new one.",
        )
    })?;

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
    Ok(Json(auth::password_strength(
        &inp.password,
        &[&inp.username, &inp.display_name, &treehouse],
    )))
}
