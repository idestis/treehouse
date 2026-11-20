//! Messages, reactions and GIF search.

use axum::{
    Json,
    extract::{Path, Query, State},
};
use rand::Rng;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    auth::{Authed, User},
    error::{AppError, AppResult},
    events,
    http::AppState,
    perms::{self, Role},
};

const PAGE: i64 = 200;
const MAX_BODY: usize = 2000;
const MAX_EMOJI_KINDS: i64 = 20;
const RATE_COUNT: i64 = 5;
const RATE_SECS: f64 = 5.0;
const GIF_PER_MINUTE: i64 = 10;
const MAX_GIF_QUERY: usize = 50;

/// The room, if this user may read and post in it: everyone in The Deck,
/// only the people inside for a voice room's chat.
async fn channel_for(conn: &mut PgConnection, user_id: i64, room_id: i64) -> AppResult<()> {
    let r = sqlx::query!(
        r#"SELECT r.kind, EXISTS (SELECT 1 FROM voice_members v WHERE v.room_id = r.id AND v.user_id = $2) AS "inside!"
           FROM rooms r WHERE r.id = $1"#,
        room_id,
        user_id
    )
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::not_found("room_gone", "That room is gone."))?;
    if r.kind == "voice" && !r.inside {
        return Err(AppError::forbidden(
            "room_chat_members_only",
            "Room chat is only for people in the room. Join it first.",
        ));
    }
    Ok(())
}

pub async fn list(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(room): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut conn = st.db.acquire().await?;
    channel_for(&mut conn, user.id, room).await?;
    // Newest page, oldest first; nothing past the message lifetime.
    let list = sqlx::query_scalar!(
        r#"SELECT COALESCE(jsonb_agg(j ORDER BY id), '[]'::jsonb) AS "list!" FROM (
               SELECT m.id, message_json(m) AS j FROM messages m, treehouse t
               WHERE m.channel_id = $1 AND m.created_at > now() - make_interval(hours => t.message_ttl_hours)
               ORDER BY m.id DESC LIMIT $2) page"#,
        room,
        PAGE
    )
    .fetch_one(&mut *conn)
    .await?;
    Ok(Json(list))
}

#[derive(Deserialize)]
pub struct SendIn {
    client_id: Uuid,
    text: Option<String>,
    gif_id: Option<String>,
    gif_query: Option<String>,
}

struct Draft {
    kind: &'static str,
    body: Option<String>,
    gif: Option<Value>,
    roll: Option<Value>,
}

fn draft(inp: &SendIn, gif: Option<Value>) -> AppResult<Draft> {
    if let Some(g) = gif {
        return Ok(Draft {
            kind: "gif",
            body: None,
            gif: Some(g),
            roll: None,
        });
    }
    let text = inp.text.as_deref().unwrap_or("").trim();
    if text.is_empty() {
        return Err(AppError::bad("empty", "Type a message first."));
    }
    if text.chars().count() > MAX_BODY {
        return Err(AppError::bad(
            "too_long",
            "Messages can be up to 2,000 characters.",
        ));
    }
    let (cmd, rest) = match text.strip_prefix('/') {
        Some(t) => {
            let mut it = t.splitn(2, char::is_whitespace);
            (
                Some(it.next().unwrap_or("").to_lowercase()),
                it.next().unwrap_or("").trim(),
            )
        }
        None => (None, text),
    };
    let text_draft = |body: String| Draft {
        kind: "text",
        body: Some(body),
        gif: None,
        roll: None,
    };
    match cmd.as_deref() {
        None => Ok(text_draft(text.to_string())),
        Some("shrug") => Ok(text_draft(format!("{rest} ¯\\_(ツ)_/¯").trim().to_string())),
        Some("roll") => {
            let value: u32 = rand::rng().random_range(1..=100);
            Ok(Draft {
                kind: "roll",
                body: None,
                gif: None,
                roll: Some(json!({ "value": value, "max": 100 })),
            })
        }
        Some("me") if !rest.is_empty() => Ok(Draft {
            kind: "action",
            body: Some(rest.to_string()),
            gif: None,
            roll: None,
        }),
        Some("me") => Err(AppError::bad(
            "empty_me",
            "Say what you're doing, like “/me grabs snacks”.",
        )),
        Some("giphy") => Err(AppError::bad(
            "pick_gif",
            "Pick a GIF from the list to send it.",
        )),
        Some(_) => Err(AppError::bad(
            "unknown_command",
            "That command doesn't exist. Try /giphy, /shrug, /roll or /me.",
        )),
    }
}

/// The cheap checks every send must pass: returns the stored message for a
/// retried `client_id`, otherwise checks the channel, timeout and message rate.
async fn pre_checks(
    conn: &mut PgConnection,
    user: &User,
    room: i64,
    client_id: Uuid,
) -> AppResult<Option<Value>> {
    if let Some(existing) = sqlx::query_scalar!(
        r#"SELECT message_json(m) AS "j!" FROM messages m WHERE author_id = $1 AND client_id = $2"#,
        user.id,
        client_id
    )
    .fetch_optional(&mut *conn)
    .await?
    {
        return Ok(Some(existing));
    }
    channel_for(conn, user.id, room).await?;
    check_not_timed_out(conn, user).await?;
    let recent = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM messages WHERE author_id = $1 AND created_at > now() - make_interval(secs => $2)"#,
        user.id,
        RATE_SECS
    )
    .fetch_one(&mut *conn)
    .await?;
    if recent >= RATE_COUNT {
        return Err(AppError::too_many(
            "slow_down",
            "You're sending fast. Wait a few seconds.",
        ));
    }
    Ok(None)
}

/// Spend one of the user's GIF requests for the last minute (searches, cache
/// hits included, and GIF sends share it). The user row lock makes the
/// prune-count-insert atomic across parallel requests and server copies.
async fn take_gif_slot(db: &sqlx::PgPool, user_id: i64) -> AppResult<()> {
    let mut tx = db.begin().await?;
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user_id)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query!(
        "DELETE FROM gif_requests WHERE user_id = $1 AND at < now() - interval '1 minute'",
        user_id
    )
    .execute(&mut *tx)
    .await?;
    let n = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM gif_requests WHERE user_id = $1"#,
        user_id
    )
    .fetch_one(&mut *tx)
    .await?;
    if n >= GIF_PER_MINUTE {
        return Err(AppError::too_many(
            "too_many_gifs",
            "Too many GIFs. Wait a minute.",
        ));
    }
    sqlx::query!("INSERT INTO gif_requests (user_id) VALUES ($1)", user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn send(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(room): Path<i64>,
    Json(inp): Json<SendIn>,
) -> AppResult<Json<Value>> {
    // GIPHY is called before the write transaction, never inside it, but only
    // after the cheap checks pass, so a rejected send never spends GIPHY quota.
    // The write transaction below repeats those checks under the author lock.
    let gif = match inp.gif_id.as_deref() {
        Some(id) => {
            {
                let mut conn = st.db.acquire().await?;
                if let Some(existing) = pre_checks(&mut conn, &user, room, inp.client_id).await? {
                    return Ok(Json(existing));
                }
            }
            take_gif_slot(&st.db, user.id).await?;
            let rating = sqlx::query_scalar!("SELECT gif_rating FROM treehouse")
                .fetch_one(&st.db)
                .await?;
            let mut g = st.gifs.by_id(id, &rating).await?;
            if let (Some(o), Some(q)) = (g.as_object_mut(), inp.gif_query.as_deref()) {
                o.insert("query".into(), Value::String(q.chars().take(60).collect()));
            }
            Some(g)
        }
        None => None,
    };
    let d = draft(&inp, gif)?;

    let mut tx = st.db.begin().await?;
    // Lock the author: rate limit and timeout checks can't race their own sends.
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user.id)
        .fetch_one(&mut *tx)
        .await?;
    if let Some(existing) = pre_checks(&mut tx, &user, room, inp.client_id).await? {
        return Ok(Json(existing)); // a retry of something already sent
    }
    let mentions = match d.body.as_deref() {
        Some(b) if d.kind == "text" => mentioned_ids(&mut tx, b).await?,
        _ => Vec::new(),
    };
    let msg = sqlx::query_scalar!(
        r#"WITH m AS (
               INSERT INTO messages (channel_id, author_id, client_id, kind, body, gif, roll, mentions)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (author_id, client_id) DO NOTHING
               RETURNING *)
           SELECT message_json(m) AS "j!" FROM m"#,
        room,
        user.id,
        inp.client_id,
        d.kind,
        d.body,
        d.gif,
        d.roll,
        &mentions
    )
    .fetch_one(&mut *tx)
    .await?;
    events::emit(
        &mut tx,
        &events::room_channel(room),
        "message_new",
        json!({ "message": msg }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(msg))
}

async fn check_not_timed_out(conn: &mut PgConnection, user: &User) -> AppResult<()> {
    let until = sqlx::query_scalar!(
        "SELECT max(ends_at) FROM sanctions WHERE target_id = $1 AND kind = 'timeout_all' AND lifted_at IS NULL AND ends_at > now()",
        user.id
    )
    .fetch_one(conn)
    .await?;
    if until.is_some() {
        return Err(AppError::forbidden(
            "timed_out",
            "You're timed out, so you can read but not post for now.",
        ));
    }
    Ok(())
}

async fn mentioned_ids(conn: &mut PgConnection, body: &str) -> AppResult<Vec<i64>> {
    let names: Vec<String> = body
        .split(|c: char| !(c.is_ascii_alphanumeric() || "@_.-".contains(c)))
        .filter_map(|w| w.strip_prefix('@'))
        .map(|w| w.trim_end_matches(['.', '-']).to_lowercase())
        .filter(|w| !w.is_empty())
        .take(20)
        .collect();
    if names.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_scalar!(
        "SELECT id FROM users WHERE lower(username::text) = ANY($1) AND blocked_at IS NULL",
        &names
    )
    .fetch_all(conn)
    .await?)
}

pub async fn delete(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let mut tx = st.db.begin().await?;
    let m = sqlx::query!(
        "SELECT m.channel_id, m.author_id, u.role, u.display_name FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.id = $1 FOR UPDATE OF m",
        id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("message_gone", "That message is gone."))?;
    perms::can_delete_message(user.actor(), m.author_id, m.role.parse::<Role>()?)?;
    sqlx::query!("DELETE FROM messages WHERE id = $1", id)
        .execute(&mut *tx)
        .await?;
    // Replaying the event log must not bring the body back.
    sqlx::query!(
        "DELETE FROM events
         WHERE (kind = 'message_new' AND (payload -> 'message' ->> 'id')::bigint = $1)
            OR (kind = 'reactions' AND (payload ->> 'id')::bigint = $1)",
        id
    )
    .execute(&mut *tx)
    .await?;
    if m.author_id != user.id {
        sqlx::query!(
            "INSERT INTO mod_log (action, actor_id, actor_name, target_id, target_name, details)
             VALUES ('delete_message', $1, $2, $3, $4, $5)",
            user.id,
            user.display_name,
            m.author_id,
            m.display_name,
            json!({ "message_id": id, "room_id": m.channel_id })
        )
        .execute(&mut *tx)
        .await?;
    }
    events::emit(
        &mut tx,
        &events::room_channel(m.channel_id),
        "message_deleted",
        json!({ "channel_id": m.channel_id, "id": id }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({})))
}

fn check_emoji(e: &str) -> AppResult<()> {
    let n = e.chars().count();
    if n == 0
        || n > 16
        || e.chars()
            .any(|c| c.is_whitespace() || c.is_ascii_alphanumeric())
    {
        return Err(AppError::bad("bad_emoji", "That isn't an emoji."));
    }
    Ok(())
}

pub async fn react(
    st: State<AppState>,
    user: Authed,
    Path((id, emoji)): Path<(i64, String)>,
) -> AppResult<Json<Value>> {
    set_reaction(st, user, id, emoji, true).await
}

pub async fn unreact(
    st: State<AppState>,
    user: Authed,
    Path((id, emoji)): Path<(i64, String)>,
) -> AppResult<Json<Value>> {
    set_reaction(st, user, id, emoji, false).await
}

async fn set_reaction(
    State(st): State<AppState>,
    Authed(user): Authed,
    id: i64,
    emoji: String,
    on: bool,
) -> AppResult<Json<Value>> {
    check_emoji(&emoji)?;
    let mut tx = st.db.begin().await?;
    let channel = sqlx::query_scalar!(
        "SELECT channel_id FROM messages WHERE id = $1 FOR UPDATE",
        id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("message_gone", "That message is gone."))?;
    channel_for(&mut tx, user.id, channel).await?;
    if on {
        let s = sqlx::query!(
            r#"SELECT count(DISTINCT emoji) AS "kinds!", COALESCE(bool_or(emoji = $2), false) AS "has!" FROM reactions WHERE message_id = $1"#,
            id,
            emoji
        )
        .fetch_one(&mut *tx)
        .await?;
        if !s.has && s.kinds >= MAX_EMOJI_KINDS {
            return Err(AppError::bad(
                "too_many_reactions",
                "That message has 20 different emoji already.",
            ));
        }
        sqlx::query!(
            "INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            id,
            user.id,
            emoji
        )
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query!(
            "DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
            id,
            user.id,
            emoji
        )
        .execute(&mut *tx)
        .await?;
    }
    let reactions = sqlx::query_scalar!(r#"SELECT reactions_json($1) AS "r!""#, id)
        .fetch_one(&mut *tx)
        .await?;
    events::emit(
        &mut tx,
        &events::room_channel(channel),
        "reactions",
        json!({ "channel_id": channel, "id": id, "reactions": reactions }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(reactions))
}

#[derive(Deserialize)]
pub struct GifQuery {
    q: String,
}

pub async fn gifs(
    State(st): State<AppState>,
    Authed(user): Authed,
    Query(q): Query<GifQuery>,
) -> AppResult<Json<Value>> {
    let text: String = q.q.trim().chars().take(MAX_GIF_QUERY).collect();
    if text.is_empty() {
        return Ok(Json(json!([])));
    }
    take_gif_slot(&st.db, user.id).await?;
    let rating = sqlx::query_scalar!("SELECT gif_rating FROM treehouse")
        .fetch_one(&st.db)
        .await?;
    Ok(Json(st.gifs.search(&text, &rating).await?))
}
