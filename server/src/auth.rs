//! Passwords (argon2), sessions, and the extractors that turn a bearer token
//! into the signed-in user.

use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{extract::FromRequestParts, http::request::Parts};
use serde::Serialize;
use sqlx::PgConnection;

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

/// How guessable a new password is (zxcvbn), judged against common
/// passwords, words, names, keyboard runs, dates and repeats, plus the
/// person's own username, name and the treehouse name.
#[derive(Debug, Serialize)]
pub struct Strength {
    /// 0 (guessed instantly) to 4 (very hard to guess).
    pub score: u8,
    pub ok: bool,
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
            message: format!("Use at least {MIN_PASSWORD} characters."),
        };
    }
    if len > MAX_PASSWORD {
        return Strength {
            score: 0,
            ok: false,
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
        let message = if score == 4 {
            "Strong password."
        } else {
            "Good password."
        };
        return Strength {
            score,
            ok: true,
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
        return Err(AppError::bad("weak_password", s.message));
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
        }
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
}

pub async fn load_user_by_token(conn: &mut PgConnection, token: &str) -> AppResult<Option<User>> {
    let row = sqlx::query!(
        r#"SELECT u.id, u.username::text AS "username!", u.display_name, u.color, u.role, u.is_owner,
                  s.id AS session_id, (m.confirmed_at IS NOT NULL) AS "mfa_enabled!", t.mods_require_mfa,
                  (SELECT a.version FROM avatars a WHERE a.user_id = u.id) AS avatar
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN mfa m ON m.user_id = u.id
           CROSS JOIN treehouse t
           WHERE s.token_hash = $1 AND s.expires_at > now() AND u.blocked_at IS NULL"#,
        util::sha256(token),
    )
    .fetch_optional(&mut *conn)
    .await?;
    let Some(r) = row else { return Ok(None) };
    sqlx::query!(
        "UPDATE sessions SET last_seen = now() WHERE id = $1 AND last_seen < now() - interval '5 minutes'",
        r.session_id
    )
    .execute(&mut *conn)
    .await?;
    Ok(Some(User {
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
    }))
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
