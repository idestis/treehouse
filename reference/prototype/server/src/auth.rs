use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use totp_rs::{Algorithm, Secret, TOTP};

use crate::util::{hash_token, now, random_token};
use crate::AppState;

pub const SESSION_COOKIE: &str = "treehouse_session";
const SESSION_DAYS: i64 = 30;
const LOCKOUT_WINDOW: i64 = 15 * 60;
const LOCKOUT_ATTEMPTS: i64 = 5;

#[derive(sqlx::FromRow, Clone, Debug)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub color: String,
    pub password_hash: String,
    pub totp_secret: Option<String>,
    pub totp_pending: Option<String>,
    pub is_admin: bool,
    pub disabled: bool,
    #[allow(dead_code)]
    pub created_at: i64,
}

impl User {
    pub fn mfa_enabled(&self) -> bool {
        self.totp_secret.is_some()
    }
}

// ---------- passwords ----------

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hash failed: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

/// Spend the same time on unknown usernames so they can't be probed by timing.
pub fn dummy_verify(password: &str) {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let hash = DUMMY.get_or_init(|| hash_password("not-a-real-password").unwrap_or_default());
    let _ = verify_password(password, hash);
}

pub fn password_problem(password: &str) -> Option<&'static str> {
    if password.chars().count() < 10 {
        Some("Use at least 10 characters for the password.")
    } else if password.len() > 256 {
        Some("That password is too long.")
    } else {
        None
    }
}

// ---------- TOTP (authenticator app) ----------

pub fn new_totp_secret() -> String {
    Secret::generate_secret().to_encoded().to_string()
}

pub fn totp_for(secret_b32: &str, username: &str, issuer: &str) -> anyhow::Result<TOTP> {
    let bytes = Secret::Encoded(secret_b32.to_string())
        .to_bytes()
        .map_err(|e| anyhow::anyhow!("bad secret: {e:?}"))?;
    TOTP::new(Algorithm::SHA1, 6, 1, 30, bytes, Some(issuer.to_string()), username.to_string())
        .map_err(|e| anyhow::anyhow!("totp: {e}"))
}

pub fn check_totp(secret_b32: &str, username: &str, issuer: &str, code: &str) -> bool {
    let code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    totp_for(secret_b32, username, issuer)
        .ok()
        .and_then(|t| t.check_current(&code).ok())
        .unwrap_or(false)
}

// ---------- lockout ----------

pub async fn is_locked_out(state: &AppState, username: &str) -> anyhow::Result<bool> {
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM login_failures WHERE username = ? AND at > ?")
            .bind(username)
            .bind(now() - LOCKOUT_WINDOW)
            .fetch_one(&state.db)
            .await?;
    Ok(count >= LOCKOUT_ATTEMPTS)
}

pub async fn record_failure(state: &AppState, username: &str) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO login_failures (username, at) VALUES (?, ?)")
        .bind(username)
        .bind(now())
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM login_failures WHERE at < ?")
        .bind(now() - 86_400)
        .execute(&state.db)
        .await?;
    Ok(())
}

pub async fn clear_failures(state: &AppState, username: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM login_failures WHERE username = ?")
        .bind(username)
        .execute(&state.db)
        .await?;
    Ok(())
}

// ---------- web sessions ----------

pub async fn start_session(
    state: &AppState,
    jar: CookieJar,
    user_id: i64,
    mfa_ok: bool,
) -> anyhow::Result<CookieJar> {
    let token = random_token();
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, mfa_ok, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(mfa_ok)
    .bind(now())
    .bind(now() + SESSION_DAYS * 86_400)
    .execute(&state.db)
    .await?;

    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .secure(state.config.cookie_secure)
        .same_site(SameSite::Lax)
        .max_age(time_days(SESSION_DAYS))
        .build();
    Ok(jar.add(cookie))
}

fn time_days(days: i64) -> time::Duration {
    time::Duration::days(days)
}

pub async fn end_session(state: &AppState, jar: CookieJar) -> anyhow::Result<CookieJar> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(hash_token(c.value()))
            .execute(&state.db)
            .await?;
    }
    Ok(jar.remove(Cookie::build(SESSION_COOKIE).path("/")))
}

async fn session_user(state: &AppState, parts: &Parts) -> Option<(User, bool, String)> {
    let jar = CookieJar::from_headers(&parts.headers);
    let token = jar.get(SESSION_COOKIE)?.value().to_string();
    let token_hash = hash_token(&token);
    let row: Option<(i64, bool)> = sqlx::query_as(
        "SELECT user_id, mfa_ok FROM sessions WHERE token_hash = ? AND expires_at > ?",
    )
    .bind(&token_hash)
    .bind(now())
    .fetch_optional(&state.db)
    .await
    .ok()?;
    let (user_id, mfa_ok) = row?;
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ? AND disabled = 0")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .ok()??;
    Some((user, mfa_ok, token_hash))
}

/// A fully signed-in web user (password + MFA if enabled).
pub struct WebUser(pub User);

impl FromRequestParts<AppState> for WebUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        match session_user(state, parts).await {
            Some((user, true, _)) => Ok(WebUser(user)),
            Some((_, false, _)) => Err(Redirect::to("/login/mfa").into_response()),
            None => Err(Redirect::to("/login").into_response()),
        }
    }
}

/// Signed in with a password but still needs the authenticator code.
pub struct PendingMfaUser {
    pub user: User,
    pub session_hash: String,
}

impl FromRequestParts<AppState> for PendingMfaUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        match session_user(state, parts).await {
            Some((user, false, session_hash)) => Ok(PendingMfaUser { user, session_hash }),
            Some((_, true, _)) => Err(Redirect::to("/account").into_response()),
            None => Err(Redirect::to("/login").into_response()),
        }
    }
}

/// Signed-in web user who is also an admin.
pub struct AdminUser(pub User);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let WebUser(user) = WebUser::from_request_parts(parts, state).await?;
        if user.is_admin {
            Ok(AdminUser(user))
        } else {
            Err((StatusCode::FORBIDDEN, "Only the admin can open this page.").into_response())
        }
    }
}

// ---------- desktop app devices ----------

/// A desktop app authenticated with its device token (`Authorization: Bearer ...`).
pub struct DeviceUser {
    pub user: User,
    pub device_id: i64,
}

impl FromRequestParts<AppState> for DeviceUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let unauthorized = || (StatusCode::UNAUTHORIZED, "This device is not paired.").into_response();
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(unauthorized)?;
        let row: Option<(i64, i64)> =
            sqlx::query_as("SELECT id, user_id FROM devices WHERE token_hash = ?")
                .bind(hash_token(token))
                .fetch_optional(&state.db)
                .await
                .map_err(|_| unauthorized())?;
        let (device_id, user_id) = row.ok_or_else(unauthorized)?;
        let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ? AND disabled = 0")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| unauthorized())?
            .ok_or_else(unauthorized)?;
        let _ = sqlx::query("UPDATE devices SET last_seen = ? WHERE id = ?")
            .bind(now())
            .bind(device_id)
            .execute(&state.db)
            .await;
        Ok(DeviceUser { user, device_id })
    }
}

/// Log the user out everywhere: web sessions and paired apps.
pub async fn revoke_everything(state: &AppState, user_id: i64) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(user_id).execute(&state.db).await?;
    sqlx::query("DELETE FROM devices WHERE user_id = ?").bind(user_id).execute(&state.db).await?;
    Ok(())
}
