mod account;
mod avatars;
mod chat;
mod invites;
mod people;
mod rooms;
mod session;
mod treehouse;
mod voice;

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::{delete, get, patch, post, put},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::broadcast;
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};

use crate::{config::Config, error::AppError, events, gifs::Gifs};

pub use invites::join_link as invites_link;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cfg: Arc<Config>,
    pub events: broadcast::Sender<events::Event>,
    pub gifs: Arc<Gifs>,
    /// Limits concurrent argon2/zxcvbn work (see `auth::hashing_limit`).
    pub hashing: Arc<tokio::sync::Semaphore>,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/server-info", get(treehouse::server_info))
        .route("/login", post(session::login))
        .route("/login/mfa", post(session::login_mfa))
        .route("/join", post(session::join))
        .route("/password-check", post(session::password_check))
        .route("/logout", post(session::logout))
        .route("/me", get(account::me).patch(account::update_me))
        .route("/me/password", post(account::change_password))
        .route(
            "/me/avatar",
            put(avatars::upload)
                .delete(avatars::remove)
                .layer(DefaultBodyLimit::max(5 * 1024 * 1024)),
        )
        .route("/avatars/{id}", get(avatars::get))
        .route("/me/mfa/setup", post(account::mfa_setup))
        .route("/me/mfa/confirm", post(account::mfa_confirm))
        .route("/me/devices", get(account::devices))
        .route("/me/devices/{id}", delete(account::sign_out_device))
        .route("/people", get(treehouse::people))
        .route("/people/{id}/role", patch(people::set_role))
        .route("/people/{id}/block", post(people::block))
        .route("/people/{id}/unblock", post(people::unblock))
        .route("/rooms", get(treehouse::rooms).post(rooms::create))
        .route("/rooms/{id}", patch(rooms::update).delete(rooms::delete))
        .route("/rooms/{id}/voice-token", post(voice::voice_token))
        .route("/rooms/{id}/voice-state", post(voice::voice_state))
        .route("/livekit/webhook", post(voice::webhook))
        .route("/channels/{id}/messages", get(chat::list).post(chat::send))
        .route("/messages/{id}", delete(chat::delete))
        .route(
            "/messages/{id}/reactions/{emoji}",
            put(chat::react).delete(chat::unreact),
        )
        .route("/gifs", get(chat::gifs))
        .route("/invites", get(invites::list).post(invites::create))
        .route("/invites/{id}", delete(invites::cancel))
        .route("/events", get(events::ws));

    // WebSockets live long: no request timeout on /api/events.
    let timed = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ));

    Router::new()
        .nest("/api", api)
        .merge(timed)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Liveness: the process is up. Never touches the database, so a Postgres
/// blip doesn't get every replica restarted at once.
async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

/// Readiness: this replica can serve requests (Postgres answers).
async fn readyz(State(st): State<AppState>) -> Result<Json<Value>, AppError> {
    sqlx::query("SELECT 1").execute(&st.db).await.map_err(|_| {
        AppError::unavailable(
            "unavailable",
            "The database isn't answering. Try again soon.",
        )
    })?;
    Ok(Json(json!({ "status": "ready" })))
}
