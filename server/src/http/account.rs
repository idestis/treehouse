//! /api/me: profile, password, two-step setup, devices.

use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use totp_rs::Secret;

use crate::{
    auth::{self, Authed, AuthedAny, MeOut},
    error::{AppError, AppResult},
    events,
    http::{
        AppState,
        session::{check_color, clean_display_name, totp, totp_step},
    },
    util,
};

pub async fn me(AuthedAny(user): AuthedAny) -> Json<MeOut> {
    Json(user.me())
}

#[derive(Deserialize)]
pub struct MePatch {
    display_name: Option<String>,
    color: Option<String>,
    /// online | away | busy | brb
    status: Option<String>,
    /// Custom status; send both as "" (or null) to clear.
    status_emoji: Option<String>,
    status_text: Option<String>,
    /// From JOIN_SOUNDS / LEAVE_SOUNDS, heard by others when you join / leave a voice room.
    join_sound: Option<String>,
    leave_sound: Option<String>,
}

const STATUSES: [&str; 4] = ["online", "away", "busy", "brb"];
const JOIN_SOUNDS: [&str; 7] = [
    "ding", "doink", "fart", "quack", "hewya", "yeah-boy", "none",
];
const LEAVE_SOUNDS: [&str; 5] = ["female-bye", "kiddo-bye", "mmbye", "fart", "none"];

pub async fn update_me(
    State(st): State<AppState>,
    Authed(user): Authed,
    Json(p): Json<MePatch>,
) -> AppResult<Json<MeOut>> {
    let name = p
        .display_name
        .as_deref()
        .map(clean_display_name)
        .transpose()?;
    if let Some(c) = p.color.as_deref() {
        check_color(c)?;
    }
    if let Some(s) = p.status.as_deref()
        && !STATUSES.contains(&s)
    {
        return Err(AppError::bad(
            "bad_status",
            "Pick online, away, busy or be right back.",
        ));
    }
    if p.join_sound
        .as_deref()
        .is_some_and(|s| !JOIN_SOUNDS.contains(&s))
        || p.leave_sound
            .as_deref()
            .is_some_and(|s| !LEAVE_SOUNDS.contains(&s))
    {
        return Err(AppError::bad("bad_sound", "Pick one of the sounds."));
    }
    // Custom status is set or cleared as a pair.
    let custom = p.status_emoji.is_some() || p.status_text.is_some();
    let emoji = p
        .status_emoji
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string);
    let text: Option<String> = p
        .status_text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(60).collect());
    if emoji.as_deref().is_some_and(|e| e.chars().count() > 16) {
        return Err(AppError::bad(
            "bad_status_emoji",
            "Use one emoji for your status.",
        ));
    }
    let mut tx = st.db.begin().await?;
    sqlx::query!(
        "UPDATE users SET display_name = COALESCE($2, display_name), color = COALESCE($3, color),
                          status = COALESCE($4, status), join_sound = COALESCE($8, join_sound), leave_sound = COALESCE($9, leave_sound),
                          status_emoji = CASE WHEN $5 THEN $6 ELSE status_emoji END,
                          status_text = CASE WHEN $5 THEN $7 ELSE status_text END
         WHERE id = $1",
        user.id,
        name,
        p.color,
        p.status,
        custom,
        emoji,
        text,
        p.join_sound,
        p.leave_sound
    )
    .execute(&mut *tx)
    .await?;
    events::emit(&mut tx, events::TREEHOUSE, "people", json!({})).await?;
    let me = auth::load_user_by_token_id(&mut tx, user.session_id).await?;
    tx.commit().await?;
    Ok(Json(me.me()))
}

#[derive(Deserialize)]
pub struct PasswordIn {
    current: String,
    new: String,
}

/// Changing the password signs out every other device.
pub async fn change_password(
    State(st): State<AppState>,
    AuthedAny(user): AuthedAny,
    Json(p): Json<PasswordIn>,
) -> AppResult<Json<Value>> {
    let treehouse = sqlx::query_scalar!("SELECT name FROM treehouse")
        .fetch_one(&st.db)
        .await?;
    // Hashing runs on the blocking pool with no connection held; the write
    // transaction then re-checks that the hash we verified is still current.
    let new_hash = auth::check_and_hash_async(
        &st.hashing,
        p.new,
        vec![user.username.clone(), user.display_name.clone(), treehouse],
    )
    .await?;
    let hash = sqlx::query_scalar!("SELECT password_hash FROM users WHERE id = $1", user.id)
        .fetch_one(&st.db)
        .await?;
    if !auth::verify_password_async(&st.hashing, hash.clone(), p.current).await? {
        return Err(AppError::bad(
            "bad_password",
            "Your current password is wrong.",
        ));
    }
    let mut tx = st.db.begin().await?;
    let current = sqlx::query_scalar!(
        "SELECT password_hash FROM users WHERE id = $1 FOR UPDATE",
        user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    if current != hash {
        return Err(AppError::conflict(
            "password_changed",
            "Your password just changed. Try again.",
        ));
    }
    sqlx::query!(
        "UPDATE users SET password_hash = $2 WHERE id = $1",
        user.id,
        new_hash
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "DELETE FROM sessions WHERE user_id = $1 AND id <> $2",
        user.id,
        user.session_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({})))
}

/// Start two-step setup: a fresh secret, shown once as a QR code.
pub async fn mfa_setup(
    State(st): State<AppState>,
    AuthedAny(user): AuthedAny,
) -> AppResult<Json<Value>> {
    if user.mfa_enabled {
        return Err(AppError::conflict(
            "mfa_on",
            "Two-step sign-in is already on.",
        ));
    }
    let secret = Secret::generate_secret().to_encoded().to_string();
    let issuer = sqlx::query_scalar!("SELECT name FROM treehouse")
        .fetch_one(&st.db)
        .await?;
    let t = totp(&secret, &user.username, &format!("Treehouse {issuer}"))?;
    let qr = t.get_qr_base64().map_err(|e| anyhow::anyhow!("qr: {e}"))?;
    sqlx::query!(
        "INSERT INTO mfa (user_id, totp_secret) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET totp_secret = $2, backup_code_hashes = '{}', confirmed_at = NULL
         WHERE mfa.confirmed_at IS NULL",
        user.id,
        secret
    )
    .execute(&st.db)
    .await?;
    Ok(Json(json!({
        "secret": secret,
        "otpauth_url": t.get_url(),
        "qr": format!("data:image/png;base64,{qr}"),
    })))
}

#[derive(Deserialize)]
pub struct ConfirmIn {
    code: String,
}

/// Finish setup with a code from the app; returns backup codes, shown once.
pub async fn mfa_confirm(
    State(st): State<AppState>,
    AuthedAny(user): AuthedAny,
    Json(p): Json<ConfirmIn>,
) -> AppResult<Json<Value>> {
    let mut tx = st.db.begin().await?;
    let row = sqlx::query!(
        "SELECT totp_secret, confirmed_at FROM mfa WHERE user_id = $1 FOR UPDATE",
        user.id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::bad("no_setup", "Start two-step setup first."))?;
    if row.confirmed_at.is_some() {
        return Err(AppError::conflict(
            "mfa_on",
            "Two-step sign-in is already on.",
        ));
    }
    let code: String = p.code.chars().filter(char::is_ascii_digit).collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| anyhow::anyhow!("clock before 1970: {e}"))?
        .as_secs();
    let t = totp(&row.totp_secret, &user.username, "Treehouse")?;
    // Record the step so the setup code can't be used again to sign in.
    let Some(step) = totp_step(&t, &code, now, None) else {
        return Err(AppError::bad(
            "bad_code",
            "That code didn't work. Check your app and try the newest one.",
        ));
    };
    let codes: Vec<String> = (0..10).map(|_| util::backup_code()).collect();
    let hashes: Vec<Vec<u8>> = codes.iter().map(|c| util::sha256(c)).collect();
    sqlx::query!(
        "UPDATE mfa SET confirmed_at = now(), backup_code_hashes = $2, last_totp_step = $3 WHERE user_id = $1",
        user.id,
        &hashes,
        step
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "backup_codes": codes })))
}

pub async fn devices(State(st): State<AppState>, Authed(user): Authed) -> AppResult<Json<Value>> {
    let rows = sqlx::query!(
        "SELECT id, device_name, last_seen FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen DESC",
        user.id
    )
    .fetch_all(&st.db)
    .await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id.to_string(),
                "device_name": r.device_name,
                "last_seen": rfc3339(r.last_seen),
                "current": r.id == user.session_id,
            })
        })
        .collect();
    Ok(Json(Value::Array(list)))
}

pub async fn sign_out_device(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    sqlx::query!(
        "DELETE FROM sessions WHERE id = $1 AND user_id = $2",
        id,
        user.id
    )
    .execute(&st.db)
    .await?;
    Ok(Json(json!({})))
}

pub fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}
