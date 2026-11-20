//! JSON API for the desktop app. Every route except /api/pair needs
//! `Authorization: Bearer <device token>`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::{DeviceUser, User};
use crate::util::{hash_token, normalize_code, now, random_token, AppResult};
use crate::{livekit, AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/pair", post(pair))
        .route("/api/me", get(me))
        .route("/api/rooms", get(rooms))
        .route("/api/voice-token", post(voice_token))
        .route("/api/unpair", post(unpair))
}

#[derive(Serialize)]
struct Me {
    username: String,
    display_name: String,
    color: String,
}

impl From<&User> for Me {
    fn from(u: &User) -> Self {
        Me { username: u.username.clone(), display_name: u.display_name.clone(), color: u.color.clone() }
    }
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    device_name: String,
}

#[derive(Serialize)]
struct PairResponse {
    token: String,
    me: Me,
}

async fn pair(State(state): State<AppState>, Json(req): Json<PairRequest>) -> AppResult<Response> {
    let code_hash = hash_token(&normalize_code(&req.code));
    let row: Option<(i64,)> = sqlx::query_as(
        "DELETE FROM pair_codes WHERE code_hash = ? AND expires_at > ? RETURNING user_id",
    )
    .bind(&code_hash)
    .bind(now())
    .fetch_optional(&state.db)
    .await?;

    let Some((user_id,)) = row else {
        // Small delay makes guessing codes slow.
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        return Ok((StatusCode::BAD_REQUEST, "That pairing code is wrong or has expired. Make a new one on the website.")
            .into_response());
    };

    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ? AND disabled = 0")
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;

    let token = random_token();
    let name: String = req.device_name.trim().chars().take(60).collect();
    sqlx::query("INSERT INTO devices (user_id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)")
        .bind(user.id)
        .bind(if name.is_empty() { "Computer".to_string() } else { name })
        .bind(hash_token(&token))
        .bind(now())
        .bind(now())
        .execute(&state.db)
        .await?;

    Ok(Json(PairResponse { token, me: Me::from(&user) }).into_response())
}

async fn me(device: DeviceUser) -> Json<Me> {
    Json(Me::from(&device.user))
}

#[derive(Serialize)]
struct RoomInfo {
    id: String,
    name: String,
    people: Vec<livekit::Occupant>,
}

/// Every room with who's in it right now, for the sidebar.
async fn rooms(State(state): State<AppState>, _device: DeviceUser) -> Json<Vec<RoomInfo>> {
    let lookups = state
        .config
        .rooms
        .iter()
        .map(|r| {
            let (config, http, id) = (state.config.clone(), state.http.clone(), r.id.clone());
            async move { livekit::occupants(&config, &http, &id).await }
        });
    let people = futures_join(lookups).await;
    Json(
        state
            .config
            .rooms
            .iter()
            .zip(people)
            .map(|(r, people)| RoomInfo { id: r.id.clone(), name: r.name.clone(), people })
            .collect(),
    )
}

/// Run the lookups at the same time without pulling in another crate.
async fn futures_join<F: std::future::Future<Output = T> + Send + 'static, T: Send + 'static>(
    futs: impl Iterator<Item = F>,
) -> Vec<T> {
    let handles: Vec<_> = futs.map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(h.await.expect("room lookup task"));
    }
    out
}

#[derive(Deserialize, Default)]
struct VoiceTokenRequest {
    room: Option<String>,
}

#[derive(Serialize)]
struct VoiceToken {
    url: String,
    token: String,
    room: String,
    room_name: String,
}

async fn voice_token(
    State(state): State<AppState>,
    device: DeviceUser,
    body: Option<Json<VoiceTokenRequest>>,
) -> AppResult<Response> {
    let wanted = body.and_then(|Json(b)| b.room);
    let room = match wanted {
        Some(id) => match state.config.rooms.iter().find(|r| r.id == id) {
            Some(r) => r,
            None => return Ok((StatusCode::NOT_FOUND, "That room doesn’t exist.").into_response()),
        },
        None => &state.config.rooms[0],
    };
    let token = livekit::voice_token(&state.config, &device.user, room)?;
    Ok(Json(VoiceToken {
        url: state.config.livekit_url.clone(),
        token,
        room: room.id.clone(),
        room_name: room.name.clone(),
    })
    .into_response())
}

async fn unpair(State(state): State<AppState>, device: DeviceUser) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM devices WHERE id = ?")
        .bind(device.device_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
