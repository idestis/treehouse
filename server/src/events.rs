//! Live events. A change writes its event in the same transaction
//! (`emit`), numbered per channel, and `NOTIFY events` is delivered by Postgres
//! only on commit. Every replica LISTENs and fans events out to its WebSocket
//! clients; a client that reconnects sends the last seq it saw per channel.
//!
//! Channels: `treehouse` (people, presence, rooms, voice occupancy) and
//! `room:<id>` (messages and reactions in that room's chat). Voice room chat
//! goes only to people in that room.

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
    listener.listen("events").await?;
    loop {
        let n = listener.recv().await?;
        let Ok(id) = n.payload().parse::<i64>() else {
            continue;
        };
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
    upgrade.on_upgrade(move |socket| async move {
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
        let _ = out
            .send(WsMessage::Text(
                json!({ "type": "signed_out" }).to_string().into(),
            ))
            .await;
        return Ok(());
    };

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
        for (channel, since) in &hello.since {
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
        let mut beat = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                e = live.recv() => match e {
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
