//! Live events. A change writes its event in the same transaction
//! (`emit`), numbered per channel, and `NOTIFY events` is delivered by Postgres
//! only on commit. Every replica LISTENs and fans events out to its WebSocket
//! clients; a client that reconnects sends the last seq it saw per channel.
//!
//! Channels: `treehouse` (people, presence, rooms, voice occupancy) and
//! `room:<id>` (messages and reactions in that room's chat). Voice room chat
//! goes only to people in that room.
//!
//! A socket is authenticated once, at hello, and then re-checked: a deleted
//! session or a blocked user is announced by database triggers (`NOTIFY
//! session_revoked` / `user_blocked`, migration 0010) and every heartbeat checks
//! the session again, so a revoked socket gets `signed_out` and is closed.

use std::{collections::HashMap, time::Duration};

use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message as WsMessage, WebSocket},
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool, postgres::PgListener};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{auth, error::AppResult, http::AppState};

pub const TREEHOUSE: &str = "treehouse";

/// The only frame the server reads is the hello (later frames are ignored):
/// a token and a short `since` map. Anything bigger is refused by the
/// WebSocket layer before it's buffered or parsed.
const MAX_INBOUND_MESSAGE: usize = 16 * 1024;
/// At most this many `since` channels are replayed. The treehouse channel
/// comes first, then rooms newest first; the rest are dropped (they're
/// almost always rooms that were deleted while the client was away).
const MAX_SINCE_CHANNELS: usize = 64;

/// Internal, never-sent channel used to fan revocations out to this
/// replica's sockets through the same broadcast as events.
const REVOKED: &str = "!revoked";
const KIND_SESSION: &str = "session";
const KIND_USER: &str = "user";

pub fn room_channel(room_id: i64) -> String {
    format!("room:{room_id}")
}

#[derive(Debug, Clone)]
pub struct Event {
    pub channel: String,
    pub seq: i64,
    pub kind: String,
    pub payload: Value,
}

impl Event {
    fn to_json(&self) -> String {
        let mut v = json!({ "channel": self.channel, "seq": self.seq, "type": self.kind });
        if let (Some(o), Some(p)) = (v.as_object_mut(), self.payload.as_object()) {
            for (k, val) in p {
                o.insert(k.clone(), val.clone());
            }
        }
        v.to_string()
    }
}

/// Record an event inside the caller's transaction. Clients see it only
/// after commit.
pub async fn emit(
    conn: &mut PgConnection,
    channel: &str,
    kind: &str,
    payload: Value,
) -> AppResult<()> {
    let seq = sqlx::query_scalar!(
        "INSERT INTO channel_seq (channel, seq) VALUES ($1, 1)
         ON CONFLICT (channel) DO UPDATE SET seq = channel_seq.seq + 1
         RETURNING seq",
        channel
    )
    .fetch_one(&mut *conn)
    .await?;
    let id = sqlx::query_scalar!(
        "INSERT INTO events (channel, seq, kind, payload) VALUES ($1, $2, $3, $4) RETURNING id",
        channel,
        seq,
        kind,
        payload
    )
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query!("SELECT pg_notify('events', $1)", id.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// One per replica: LISTEN and forward committed events to local sockets.
pub async fn run_listener(db: PgPool, tx: broadcast::Sender<Event>) {
    loop {
        if let Err(e) = listen(&db, &tx).await {
            tracing::warn!(error = %e, "event listener stopped, reconnecting");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn listen(db: &PgPool, tx: &broadcast::Sender<Event>) -> anyhow::Result<()> {
    let mut listener = PgListener::connect_with(db).await?;
    listener
        .listen_all(["events", "session_revoked", "user_blocked"])
        .await?;
    loop {
        let n = listener.recv().await?;
        let Ok(id) = n.payload().parse::<i64>() else {
            continue;
        };
        let revoked = match n.channel() {
            "session_revoked" => Some(KIND_SESSION),
            "user_blocked" => Some(KIND_USER),
            _ => None,
        };
        if let Some(kind) = revoked {
            let _ = tx.send(Event {
                channel: REVOKED.to_string(),
                seq: 0,
                kind: kind.to_string(),
                payload: json!({ "id": id }),
            });
            continue;
        }
        let row = sqlx::query!(
            "SELECT channel, seq, kind, payload FROM events WHERE id = $1",
            id
        )
        .fetch_optional(db)
        .await?;
        if let Some(r) = row {
            let _ = tx.send(Event {
                channel: r.channel,
                seq: r.seq,
                kind: r.kind,
                payload: r.payload,
            });
        }
    }
}

#[derive(Deserialize)]
struct Hello {
    token: String,
    #[serde(default)]
    since: HashMap<String, i64>,
}

/// `WS /api/events`. The first frame is `{"token": "...", "since": {"room:1": 41}}`
/// (a header can't be set on a browser WebSocket, and the token never goes in a URL).
pub async fn ws(State(st): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade
        .max_message_size(MAX_INBOUND_MESSAGE)
        .max_frame_size(MAX_INBOUND_MESSAGE)
        .on_upgrade(move |socket| async move {
            if let Err(e) = session(st, socket).await {
                tracing::debug!(error = %e, "websocket closed");
            }
        })
}

async fn session(st: AppState, socket: WebSocket) -> anyhow::Result<()> {
    let (mut out, mut inbox) = socket.split();
    let hello = tokio::time::timeout(Duration::from_secs(10), inbox.next()).await;
    let Ok(Some(Ok(WsMessage::Text(text)))) = hello else {
        return Ok(());
    };
    let Ok(hello) = serde_json::from_str::<Hello>(&text) else {
        return Ok(());
    };
    let user = {
        let mut conn = st.db.acquire().await?;
        auth::load_user_by_token(&mut conn, &hello.token)
            .await
            .ok()
            .flatten()
    };
    let Some(user) = user.filter(|u| !u.mfa_setup_needed()) else {
        let _ = out.send(signed_out()).await;
        return Ok(());
    };
    let resume = resume_channels(hello.since);

    // Subscribe before replaying, so nothing falls between the two.
    let mut live = st.events.subscribe();
    let conn_id = Uuid::new_v4();
    connect(&st.db, conn_id, user.id)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    // Where each visible channel is now, so the client can resume from here.
    let mut seqs = serde_json::Map::new();
    for r in sqlx::query!("SELECT channel, seq FROM channel_seq")
        .fetch_all(&st.db)
        .await?
    {
        if visible(&st.db, user.id, &r.channel).await? {
            seqs.insert(r.channel, json!(r.seq));
        }
    }
    out.send(WsMessage::Text(
        json!({ "type": "ready", "seqs": seqs }).to_string().into(),
    ))
    .await?;

    let result = async {
        for (channel, since) in &resume {
            if !visible(&st.db, user.id, channel).await? {
                continue;
            }
            let rows = sqlx::query!(
                "SELECT channel, seq, kind, payload FROM events WHERE channel = $1 AND seq > $2 ORDER BY seq LIMIT 1000",
                channel,
                since
            )
            .fetch_all(&st.db)
            .await?;
            for r in rows {
                let e = Event { channel: r.channel, seq: r.seq, kind: r.kind, payload: r.payload };
                out.send(WsMessage::Text(e.to_json().into())).await?;
            }
        }
        // A revocation between hello and subscribe wouldn't reach `live`.
        if !still_signed_in(&st.db, user.session_id).await? {
            let _ = out.send(signed_out()).await;
            return Ok(());
        }
        let mut beat = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                e = live.recv() => match e {
                    Ok(e) if e.channel == REVOKED => {
                        if revokes(&e, user.session_id, user.id) {
                            let _ = out.send(signed_out()).await;
                            return Ok(());
                        }
                    }
                    Ok(e) => {
                        if visible(&st.db, user.id, &e.channel).await? {
                            out.send(WsMessage::Text(e.to_json().into())).await?;
                        }
                    }
                    // Fell behind: close, and the client resumes with `since`.
                    Err(broadcast::error::RecvError::Lagged(_)) => return Ok(()),
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                },
                m = inbox.next() => match m {
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return Ok(()),
                    Some(Ok(_)) => {}
                },
                _ = beat.tick() => {
                    // Belt and braces for a missed NOTIFY (listener reconnecting)
                    // and for sessions that simply expired.
                    if !still_signed_in(&st.db, user.session_id).await? {
                        let _ = out.send(signed_out()).await;
                        return Ok(());
                    }
                    sqlx::query!("UPDATE connections SET last_ping = now() WHERE id = $1", conn_id)
                        .execute(&st.db)
                        .await?;
                    out.send(WsMessage::Ping(Vec::new().into())).await?;
                }
            }
        }
    }
    .await;
    disconnect(&st.db, conn_id, user.id)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    result
}

fn signed_out() -> WsMessage {
    WsMessage::Text(json!({ "type": "signed_out" }).to_string().into())
}

/// Whether a revocation fanned out by the listener ends this socket.
fn revokes(e: &Event, session_id: i64, user_id: i64) -> bool {
    let Some(id) = e.payload.get("id").and_then(Value::as_i64) else {
        return false;
    };
    match e.kind.as_str() {
        KIND_SESSION => id == session_id,
        KIND_USER => id == user_id,
        _ => false,
    }
}

/// The hello's identity checks, again: the session exists and hasn't
/// expired, the user isn't blocked, and two-step setup isn't now required.
async fn still_signed_in(db: &PgPool, session_id: i64) -> anyhow::Result<bool> {
    let mut conn = db.acquire().await?;
    let ok = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = $1 AND s.expires_at > now() AND u.blocked_at IS NULL) AS "ok!""#,
        session_id
    )
    .fetch_one(&mut *conn)
    .await?;
    if !ok {
        return Ok(false);
    }
    let user = auth::load_user_by_token_id(&mut conn, session_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(!user.mfa_setup_needed())
}

/// The canonical form of a channel name, exactly as the server emits it,
/// with the room id for ordering. Anything else (`room:01`, `room:+1`,
/// unknown names) is `None` and never reaches the database.
fn canonical_channel(channel: &str) -> Option<Option<i64>> {
    if channel == TREEHOUSE {
        return Some(None);
    }
    let id = channel.strip_prefix("room:")?.parse::<i64>().ok()?;
    (room_channel(id) == channel).then_some(Some(id))
}

/// Which `since` entries to replay: canonical names only, at most
/// `MAX_SINCE_CHANNELS`, treehouse first, then rooms newest (highest id)
/// first. Extra entries are dropped deterministically, not rejected, so a
/// long-lived client that remembers many deleted rooms still connects.
fn resume_channels(since: HashMap<String, i64>) -> Vec<(String, i64)> {
    let mut keep: Vec<(Option<i64>, String, i64)> = since
        .into_iter()
        .filter_map(|(ch, seq)| canonical_channel(&ch).map(|id| (id, ch, seq)))
        .collect();
    // None (treehouse) sorts before every room; rooms by id, descending.
    keep.sort_by_key(|(id, _, _)| id.map(std::cmp::Reverse));
    keep.truncate(MAX_SINCE_CHANNELS);
    keep.into_iter().map(|(_, ch, seq)| (ch, seq)).collect()
}

/// Room chat in voice rooms is only for the people in them.
async fn visible(db: &PgPool, user_id: i64, channel: &str) -> anyhow::Result<bool> {
    let Some(id) = channel
        .strip_prefix("room:")
        .and_then(|s| s.parse::<i64>().ok())
    else {
        return Ok(channel == TREEHOUSE);
    };
    Ok(sqlx::query_scalar!(
        r#"SELECT (r.kind = 'deck' OR EXISTS (SELECT 1 FROM voice_members v WHERE v.room_id = r.id AND v.user_id = $2)) AS "ok!"
           FROM rooms r WHERE r.id = $1"#,
        id,
        user_id
    )
    .fetch_optional(db)
    .await?
    .unwrap_or(false))
}

async fn connect(db: &PgPool, id: Uuid, user_id: i64) -> AppResult<()> {
    let mut tx = db.begin().await?;
    // Serialize presence changes per user.
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user_id)
        .fetch_one(&mut *tx)
        .await?;
    let was_online = online(&mut tx, user_id).await?;
    sqlx::query!(
        "INSERT INTO connections (id, user_id) VALUES ($1, $2)",
        id,
        user_id
    )
    .execute(&mut *tx)
    .await?;
    if !was_online {
        emit(
            &mut tx,
            TREEHOUSE,
            "presence",
            json!({ "user_id": user_id, "online": true }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn disconnect(db: &PgPool, id: Uuid, user_id: i64) -> AppResult<()> {
    let mut tx = db.begin().await?;
    sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", user_id)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM connections WHERE id = $1", id)
        .execute(&mut *tx)
        .await?;
    if !online(&mut tx, user_id).await? {
        emit(
            &mut tx,
            TREEHOUSE,
            "presence",
            json!({ "user_id": user_id, "online": false }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn online(conn: &mut PgConnection, user_id: i64) -> AppResult<bool> {
    Ok(sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM connections WHERE user_id = $1 AND last_ping > now() - interval '90 seconds') AS "e!""#,
        user_id
    )
    .fetch_one(conn)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_names_only() {
        assert_eq!(canonical_channel("treehouse"), Some(None));
        assert_eq!(canonical_channel("room:1"), Some(Some(1)));
        assert_eq!(canonical_channel("room:-3"), Some(Some(-3)));
        for bad in [
            "room:01",
            "room:+1",
            "room: 1",
            "room:",
            "room:1x",
            "Treehouse",
            "!revoked",
            "",
            "room:99999999999999999999",
        ] {
            assert_eq!(canonical_channel(bad), None, "{bad}");
        }
    }

    #[test]
    fn since_is_filtered_capped_and_ordered() {
        let mut since: HashMap<String, i64> = (1..=200).map(|i| (room_channel(i), i)).collect();
        since.insert("room:007".into(), 1);
        since.insert("nonsense".into(), 1);
        since.insert(TREEHOUSE.into(), 5);
        let out = resume_channels(since);
        assert_eq!(out.len(), MAX_SINCE_CHANNELS);
        assert_eq!(out[0], (TREEHOUSE.to_string(), 5));
        assert_eq!(out[1], (room_channel(200), 200));
        assert_eq!(out[MAX_SINCE_CHANNELS - 1].0, room_channel(200 - 62));
        assert!(out.iter().all(|(c, _)| canonical_channel(c).is_some()));
    }

    #[test]
    fn small_since_is_kept_whole() {
        let since = HashMap::from([(TREEHOUSE.to_string(), 3), (room_channel(2), 9)]);
        assert_eq!(
            resume_channels(since),
            vec![(TREEHOUSE.to_string(), 3), (room_channel(2), 9)]
        );
    }

    #[test]
    fn revocations_match_only_their_target() {
        let ev = |kind: &str, id: i64| Event {
            channel: REVOKED.into(),
            seq: 0,
            kind: kind.into(),
            payload: json!({ "id": id }),
        };
        assert!(revokes(&ev(KIND_SESSION, 7), 7, 1));
        assert!(!revokes(&ev(KIND_SESSION, 8), 7, 1));
        assert!(revokes(&ev(KIND_USER, 1), 7, 1));
        assert!(!revokes(&ev(KIND_USER, 2), 7, 1));
        assert!(!revokes(&ev("other", 7), 7, 7));
    }

    #[test]
    fn hello_fits_the_frame_limit() {
        // What the desktop client sends: a 43-char token and a since map.
        let since: HashMap<String, i64> = (1..=MAX_SINCE_CHANNELS as i64)
            .map(|i| (room_channel(i), i64::MAX))
            .collect();
        let hello = json!({ "token": "x".repeat(43), "since": since }).to_string();
        assert!(hello.len() < MAX_INBOUND_MESSAGE);
    }
}
