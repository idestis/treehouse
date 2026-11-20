//! Room admin: create, rename, resize, delete (spec §5). Admins only.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;

use crate::{
    auth::Authed,
    error::{AppError, AppResult},
    events,
    http::AppState,
    livekit, perms,
};

const DEFAULT_CAPACITY: i32 = 10;

fn clean_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 40 {
        return Err(AppError::bad(
            "bad_name",
            "Room names are 1 to 40 characters.",
        ));
    }
    Ok(n.to_string())
}

fn check_capacity(c: i32) -> AppResult<()> {
    if !(2..=10).contains(&c) {
        return Err(AppError::bad(
            "bad_capacity",
            "A room holds 2 to 10 people.",
        ));
    }
    Ok(())
}

/// "Gaming Loft" → "gaming-loft", unique among rooms (the #room link).
async fn unique_slug(
    conn: &mut PgConnection,
    name: &str,
    except: Option<i64>,
) -> AppResult<String> {
    let mut base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    base.truncate(32);
    if base.is_empty() {
        base = "room".into();
    }
    for n in 1..100 {
        let slug = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        let taken = sqlx::query_scalar!(
            r#"SELECT EXISTS (SELECT 1 FROM rooms WHERE slug = $1::text::citext AND id IS DISTINCT FROM $2) AS "e!""#,
            slug,
            except
        )
        .fetch_one(&mut *conn)
        .await?;
        if !taken {
            return Ok(slug);
        }
    }
    Err(AppError::conflict(
        "slug_taken",
        "Pick a different room name.",
    ))
}

#[derive(Deserialize)]
pub struct CreateIn {
    name: String,
    capacity: Option<i32>,
}

pub async fn create(
    State(st): State<AppState>,
    Authed(user): Authed,
    Json(inp): Json<CreateIn>,
) -> AppResult<Json<Value>> {
    perms::can_manage_rooms(user.actor())?;
    let name = clean_name(&inp.name)?;
    let capacity = inp.capacity.unwrap_or(DEFAULT_CAPACITY);
    check_capacity(capacity)?;
    let mut tx = st.db.begin().await?;
    // The room limit spans rows: lock the treehouse row, then count and write.
    let max = sqlx::query_scalar!("SELECT max_voice_rooms FROM treehouse FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let count = sqlx::query_scalar!(r#"SELECT count(*) AS "n!" FROM rooms WHERE kind = 'voice'"#)
        .fetch_one(&mut *tx)
        .await?;
    if count >= i64::from(max) {
        return Err(AppError::conflict(
            "room_limit",
            format!("You have {count} rooms. Delete one to add another."),
        ));
    }
    let slug = unique_slug(&mut tx, &name, None).await?;
    let id = sqlx::query_scalar!(
        "INSERT INTO rooms (kind, name, slug, position, capacity)
         VALUES ('voice', $1, $2::text::citext, (SELECT COALESCE(max(position), 0) + 1 FROM rooms), $3)
         RETURNING id",
        name,
        slug,
        capacity
    )
    .fetch_one(&mut *tx)
    .await?;
    events::emit(&mut tx, events::TREEHOUSE, "rooms", json!({})).await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id, "slug": slug })))
}

#[derive(Deserialize)]
pub struct UpdateIn {
    name: Option<String>,
    capacity: Option<i32>,
}

pub async fn update(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(inp): Json<UpdateIn>,
) -> AppResult<StatusCode> {
    perms::can_manage_rooms(user.actor())?;
    let mut tx = st.db.begin().await?;
    let kind = sqlx::query_scalar!("SELECT kind FROM rooms WHERE id = $1 FOR UPDATE", id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::not_found("That room is gone."))?;
    if let Some(n) = inp.name.as_deref() {
        let name = clean_name(n)?;
        let slug = unique_slug(&mut tx, &name, Some(id)).await?;
        sqlx::query!(
            "UPDATE rooms SET name = $2, slug = $3::text::citext WHERE id = $1",
            id,
            name,
            slug
        )
        .execute(&mut *tx)
        .await?;
    }
    if let Some(c) = inp.capacity {
        if kind != "voice" {
            return Err(AppError::bad("not_voice", "The Deck has no size limit."));
        }
        check_capacity(c)?;
        sqlx::query!("UPDATE rooms SET capacity = $2 WHERE id = $1", id, c)
            .execute(&mut *tx)
            .await?;
    }
    events::emit(&mut tx, events::TREEHOUSE, "rooms", json!({})).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    /// Move everyone out (back to The Deck) and delete anyway.
    #[serde(default)]
    everyone: bool,
}

pub async fn delete(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Query(q): Query<DeleteQuery>,
) -> AppResult<StatusCode> {
    perms::can_manage_rooms(user.actor())?;
    let mut tx = st.db.begin().await?;
    sqlx::query!("SELECT id FROM treehouse FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let room = sqlx::query!("SELECT kind, name FROM rooms WHERE id = $1 FOR UPDATE", id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::not_found("That room is gone."))?;
    if room.kind == "deck" {
        return Err(AppError::bad("deck", "The Deck can't be deleted."));
    }
    let inside = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM voice_members WHERE room_id = $1"#,
        id
    )
    .fetch_one(&mut *tx)
    .await?;
    if inside > 0 && !q.everyone {
        return Err(AppError::conflict(
            "room_occupied",
            format!(
                "{} has people in it. Move everyone to The Deck first.",
                room.name
            ),
        ));
    }
    sqlx::query!("DELETE FROM voice_members WHERE room_id = $1", id)
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM rooms WHERE id = $1", id)
        .execute(&mut *tx)
        .await?;
    if inside > 0 {
        // Disconnecting people happens in LiveKit, after commit, with retries.
        sqlx::query!(
            "INSERT INTO outbox (kind, payload) VALUES ('delete_room', $1)",
            json!({ "room": livekit::room_name(id) })
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query!(
            "INSERT INTO mod_log (action, actor_id, actor_name, details) VALUES ('delete_room_with_people', $1, $2, $3)",
            user.id,
            user.display_name,
            json!({ "room_id": id, "room": room.name, "people": inside })
        )
        .execute(&mut *tx)
        .await?;
    }
    events::emit(
        &mut tx,
        events::TREEHOUSE,
        "voice",
        json!({ "room_id": id, "members": [] }),
    )
    .await?;
    events::emit(&mut tx, events::TREEHOUSE, "rooms", json!({})).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
