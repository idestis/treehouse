//! Server info, people, rooms.

use axum::{Json, extract::State};
use serde_json::{Value, json};

use crate::{auth::Authed, error::AppResult, http::AppState};

/// Public: what a client shows before signing in, and the header copy after.
pub async fn server_info(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let t = sqlx::query!("SELECT name, message_ttl_hours, max_voice_rooms FROM treehouse")
        .fetch_one(&st.db)
        .await?;
    Ok(Json(json!({
        "name": t.name,
        "version": env!("CARGO_PKG_VERSION"),
        "message_ttl_hours": t.message_ttl_hours,
        "max_voice_rooms": t.max_voice_rooms,
        "gifs": st.gifs.enabled(),
    })))
}

pub async fn people(State(st): State<AppState>, Authed(_): Authed) -> AppResult<Json<Value>> {
    let list = sqlx::query_scalar!(
        r#"SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', u.id, 'username', u.username::text, 'display_name', u.display_name, 'color', u.color, 'role', u.role,
               'avatar', (SELECT a.version FROM avatars a WHERE a.user_id = u.id),
               'status', u.status, 'status_emoji', u.status_emoji, 'status_text', u.status_text, 'join_sound', u.join_sound,
               'online', EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id AND c.last_ping > now() - interval '90 seconds')
           ) ORDER BY lower(u.display_name)), '[]'::jsonb) AS "list!"
           FROM users u WHERE u.blocked_at IS NULL"#
    )
    .fetch_one(&st.db)
    .await?;
    Ok(Json(list))
}

pub async fn rooms(State(st): State<AppState>, Authed(_): Authed) -> AppResult<Json<Value>> {
    let list = sqlx::query_scalar!(r#"SELECT rooms_json() AS "list!""#)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(list))
}
