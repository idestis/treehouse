//! Passwords (argon2), sessions, and the extractors that turn a bearer token
//! into the signed-in user.

use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{extract::FromRequestParts, http::request::Parts};
use serde::Serialize;
use sqlx::PgConnection;
use std::sync::Arc;
use tokio::sync::Semaphore;

use crate::{
    error::{AppError, AppResult},
    http::AppState,
    perms::{self, Actor, Role},
    util,
};

pub const MIN_PASSWORD: usize = 10;
const REMEMBER_DAYS: i64 = 90;
const SESSION_HOURS: i64 = 24;

pub fn hash_password(pw: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hashing password: {e}"))?
        .to_string())
}

pub fn verify_password(hash: &str, pw: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// A real hash to verify against when the username doesn't exist, so a
/// wrong username takes as long as a wrong password.
pub fn dummy_verify(pw: &str) {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let h = DUMMY.get_or_init(|| hash_password("not-a-real-password").unwrap_or_default());
    let _ = verify_password(h, pw);
}

/// How many argon2/zxcvbn jobs run at once: one per CPU, at least 2. The
/// work runs on the blocking pool, so async workers stay free, and the
/// semaphore keeps a flood of sign-in attempts from queueing unbounded CPU
/// work. In-memory and throwaway, like the other caches.
pub fn hashing_limit() -> Arc<Semaphore> {
    let n = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(2)
        .max(2);
    Arc::new(Semaphore::new(n))
}

/// Run CPU-heavy password work off the async workers, one permit at a time.
async fn blocking<T, F>(limit: &Arc<Semaphore>, f: F) -> AppResult<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let permit = Arc::clone(limit)
        .acquire_owned()
        .await
        .map_err(|e| anyhow::anyhow!("hashing semaphore closed: {e}"))?;
    tokio::task::spawn_blocking(move || {
        let out = f();
        drop(permit);
        out
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("hashing task failed: {e}")))
}

/// `verify_password` on the blocking pool.
pub async fn verify_password_async(
    limit: &Arc<Semaphore>,
    hash: String,
    pw: String,
) -> AppResult<bool> {
    blocking(limit, move || verify_password(&hash, &pw)).await
}

/// `dummy_verify` on the blocking pool (same cost as a real verify).
pub async fn dummy_verify_async(limit: &Arc<Semaphore>, pw: String) -> AppResult<()> {
    blocking(limit, move || dummy_verify(&pw)).await
}

/// Strength check and hash of a new password, together on the blocking pool.
pub async fn check_and_hash_async(
    limit: &Arc<Semaphore>,
    pw: String,
    avoid: Vec<String>,
) -> AppResult<String> {
    blocking(limit, move || {
        let avoid: Vec<&str> = avoid.iter().map(String::as_str).collect();
        check_new_password(&pw, &avoid)?;
        hash_password(&pw)
    })
    .await?
}

/// `password_strength` on the blocking pool.
pub async fn password_strength_async(
    limit: &Arc<Semaphore>,
    pw: String,
    avoid: Vec<String>,
) -> AppResult<Strength> {
    blocking(limit, move || {
        let avoid: Vec<&str> = avoid.iter().map(String::as_str).collect();
        password_strength(&pw, &avoid)
    })
    .await
}

/// How guessable a new password is (zxcvbn), judged against common
/// passwords, words, names, keyboard runs, dates and repeats, plus the
/// person's own username, name and the treehouse name.
#[derive(Debug, Serialize)]
pub struct Strength {
    /// 0 (guessed instantly) to 4 (very hard to guess).
    pub score: u8,
    pub ok: bool,
    /// password_short, password_long, password_weak, password_good or
    /// password_strong: the app translates by this code.
    pub code: &'static str,
    /// Shortest allowed length, for the password_short sentence.
    pub min: usize,
    pub message: String,
}

/// zxcvbn score needed: 3 means about 10^10 guesses.
const MIN_SCORE: u8 = 3;
const MAX_PASSWORD: usize = 200;

pub fn password_strength(pw: &str, avoid: &[&str]) -> Strength {
    let len = pw.chars().count();
    if len < MIN_PASSWORD {
        return Strength {
            score: 0,
            ok: false,
            code: "password_short",
            min: MIN_PASSWORD,
            message: format!("Use at least {MIN_PASSWORD} characters."),
        };
    }
    if len > MAX_PASSWORD {
        return Strength {
            score: 0,
            ok: false,
            code: "password_long",
            min: MIN_PASSWORD,
            message: "That password is too long.".into(),
        };
    }
    let avoid: Vec<&str> = avoid
        .iter()
        .copied()
        .filter(|w| !w.trim().is_empty())
        .chain(["treehouse"])
        .collect();
    let e = zxcvbn::zxcvbn(pw, &avoid);
    let score = u8::from(e.score());
    if score >= MIN_SCORE {
        let (code, message) = if score == 4 {
            ("password_strong", "Strong password.")
        } else {
            ("password_good", "Good password.")
        };
        return Strength {
            score,
            ok: true,
            code,
            min: MIN_PASSWORD,
            message: message.into(),
        };
    }
    let warning = e
        .feedback()
        .and_then(|f| f.warning())
        .map(|w| format!("{w} "))
        .unwrap_or_default();
    Strength {
        score,
        ok: false,
        code: "password_weak",
        min: MIN_PASSWORD,
        message: format!(
            "{warning}Add another word or two. A few unrelated words make a strong password."
        )
        .trim()
        .to_string(),
    }
}

pub fn check_new_password(pw: &str, avoid: &[&str]) -> AppResult<()> {
    let s = password_strength(pw, avoid);
    if !s.ok {
        return Err(AppError::bad(s.code, s.message).with(serde_json::json!({ "min": s.min })));
    }
    Ok(())
}

/// Create a device session and return its token (only the hash is stored).
pub async fn create_session(
    conn: &mut PgConnection,
    user_id: i64,
    device_name: &str,
    remember: bool,
) -> AppResult<String> {
    let token = util::new_token();
    let hours = if remember {
        REMEMBER_DAYS * 24
    } else {
        SESSION_HOURS
    };
    let device: String = device_name.trim().chars().take(60).collect();
    let device = if device.is_empty() {
        "Computer".to_string()
    } else {
        device
    };
    sqlx::query!(
        "INSERT INTO sessions (token_hash, user_id, device_name, remember, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))",
        util::sha256(&token),
        user_id,
        device,
        remember,
        hours as i32,
    )
    .execute(conn)
    .await?;
    Ok(token)
}

/// The signed-in user behind a request.
#[derive(Debug, Clone)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub color: String,
    pub role: Role,
    pub is_owner: bool,
    pub session_id: i64,
    pub mfa_enabled: bool,
    pub mods_require_mfa: bool,
    pub avatar: Option<i32>,
    pub status: String,
    pub status_emoji: Option<String>,
    pub status_text: Option<String>,
    pub join_sound: String,
    pub leave_sound: String,
}

impl User {
    pub fn actor(&self) -> Actor {
        Actor {
            id: self.id,
            role: self.role,
            is_owner: self.is_owner,
        }
    }
    pub fn mfa_setup_needed(&self) -> bool {
        !self.mfa_enabled && perms::mfa_required(self.role, self.mods_require_mfa)
    }
    pub fn me(&self) -> MeOut {
        MeOut {
            id: self.id,
            username: self.username.clone(),
            display_name: self.display_name.clone(),
            color: self.color.clone(),
            role: self.role,
            is_owner: self.is_owner,
            mfa_enabled: self.mfa_enabled,
            mfa_setup_needed: self.mfa_setup_needed(),
            avatar: self.avatar,
            status: self.status.clone(),
            status_emoji: self.status_emoji.clone(),
            status_text: self.status_text.clone(),
            join_sound: self.join_sound.clone(),
            leave_sound: self.leave_sound.clone(),
        }
    }
}

/// A signed-in user for tests that call handler bodies directly.
#[cfg(test)]
pub fn test_user(id: i64) -> User {
    User {
        id,
        username: format!("user{id}"),
        display_name: format!("User {id}"),
        color: "#63D69E".into(),
        role: Role::Member,
        is_owner: false,
        session_id: 0,
        mfa_enabled: false,
        mods_require_mfa: false,
        avatar: None,
        status: "online".into(),
        status_emoji: None,
        status_text: None,
        join_sound: "none".into(),
        leave_sound: "none".into(),
    }
}

#[derive(Debug, Serialize)]
pub struct MeOut {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub color: String,
    pub role: Role,
    pub is_owner: bool,
    pub mfa_enabled: bool,
    /// Admins (and moderators, if required) must turn on two-step sign-in first.
    pub mfa_setup_needed: bool,
    /// Avatar version, or null for initials. Fetch with GET /api/avatars/{id}.
    pub avatar: Option<i32>,
    pub status: String,
    pub status_emoji: Option<String>,
    pub status_text: Option<String>,
    /// Sound others hear when you join a voice room.
    pub join_sound: String,
    /// Sound others hear when you leave a voice room.
    pub leave_sound: String,
}

pub async fn load_user_by_token(conn: &mut PgConnection, token: &str) -> AppResult<Option<User>> {
    let session_id = sqlx::query_scalar!(
        "SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.blocked_at IS NULL",
        util::sha256(token),
    )
    .fetch_optional(&mut *conn)
    .await?;
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    sqlx::query!(
        "UPDATE sessions SET last_seen = now() WHERE id = $1 AND last_seen < now() - interval '5 minutes'",
        session_id
    )
    .execute(&mut *conn)
    .await?;
    Ok(Some(load_user_by_token_id(conn, session_id).await?))
}

/// The user behind a session id (already authenticated).
pub async fn load_user_by_token_id(conn: &mut PgConnection, session_id: i64) -> AppResult<User> {
    let r = sqlx::query!(
        r#"SELECT u.id, u.username::text AS "username!", u.display_name, u.color, u.role, u.is_owner,
                  s.id AS session_id, (m.confirmed_at IS NOT NULL) AS "mfa_enabled!", t.mods_require_mfa,
                  (SELECT a.version FROM avatars a WHERE a.user_id = u.id) AS avatar,
                  u.status, u.status_emoji, u.status_text, u.join_sound, u.leave_sound
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN mfa m ON m.user_id = u.id
           CROSS JOIN treehouse t
           WHERE s.id = $1"#,
        session_id,
    )
    .fetch_one(&mut *conn)
    .await?;
    Ok(User {
        id: r.id,
        username: r.username,
        display_name: r.display_name,
        color: r.color,
        role: r.role.parse()?,
        is_owner: r.is_owner,
        session_id: r.session_id,
        mfa_enabled: r.mfa_enabled,
        mods_require_mfa: r.mods_require_mfa,
        avatar: r.avatar,
        status: r.status,
        status_emoji: r.status_emoji,
        status_text: r.status_text,
        join_sound: r.join_sound,
        leave_sound: r.leave_sound,
    })
}

fn bearer(parts: &Parts) -> Option<&str> {
    parts
        .headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn signed_out() -> AppError {
    AppError::unauthorized("signed_out", "You're signed out. Sign in again.")
}

/// Signed in, possibly still owing two-step setup. Only for /api/me, the
/// two-step setup endpoints and logout.
pub struct AuthedAny(pub User);

/// Signed in with everything their role requires.
pub struct Authed(pub User);

impl FromRequestParts<AppState> for AuthedAny {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(parts).ok_or_else(signed_out)?;
        let mut conn = st.db.acquire().await?;
        let user = load_user_by_token(&mut conn, token)
            .await?
            .ok_or_else(signed_out)?;
        Ok(AuthedAny(user))
    }
}

impl FromRequestParts<AppState> for Authed {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let AuthedAny(user) = AuthedAny::from_request_parts(parts, st).await?;
        if user.mfa_setup_needed() {
            return Err(AppError::forbidden(
                "mfa_setup_needed",
                "Turn on two-step sign-in first. Your role needs it.",
            ));
        }
        Ok(Authed(user))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weak_passwords_fail() {
        for pw in [
            "short",
            "aaaaaaaaaaaa",
            "password123",
            "qwertyuiop",
            "1234567890",
            "max2026max2026",
            "Password1!x",
        ] {
            assert!(
                !password_strength(pw, &["max", "Max"]).ok,
                "{pw} should be weak"
            );
        }
        // Their own name or the treehouse name doesn't make a password strong.
        assert!(!password_strength("nightowls2026", &["max", "Night Owls", "nightowls"]).ok);
    }

    #[tokio::test]
    async fn hashing_runs_off_the_async_workers() {
        let limit = hashing_limit();
        assert!(limit.available_permits() >= 2);
        let pw = "lantern pickle orbit sofa".to_string();
        let hash = check_and_hash_async(&limit, pw.clone(), vec!["max".into()])
            .await
            .unwrap();
        assert!(
            verify_password_async(&limit, hash.clone(), pw)
                .await
                .unwrap()
        );
        assert!(
            !verify_password_async(&limit, hash, "wrong".into())
                .await
                .unwrap()
        );
        dummy_verify_async(&limit, "x".into()).await.unwrap();
        assert!(
            check_and_hash_async(&limit, "password123".into(), vec![])
                .await
                .is_err()
        );
        // Every permit comes back.
        assert_eq!(
            limit.available_permits(),
            hashing_limit().available_permits()
        );
    }

    #[test]
    fn strong_passwords_pass() {
        for pw in [
            "lantern pickle orbit sofa",
            "Purple-Tractor-Melts-42",
            "my cat hates jazz on tuesdays",
        ] {
            assert!(password_strength(pw, &["max"]).ok, "{pw} should be strong");
        }
    }
}
