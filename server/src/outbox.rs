//! Side effects after commit (CLAUDE.md): rows written in the same transaction
//! as the change, run here with retries. One replica at a time (advisory lock).

use std::time::Duration;

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;

use crate::{config::LiveKit, livekit};

const LOCK_KEY: i64 = 0x6f75_7462; // "outb"
const BATCH: i64 = 20;

pub async fn run(db: PgPool, lk: Option<LiveKit>) {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        if let Err(e) = once(&db, lk.as_ref(), &http).await {
            tracing::warn!(error = %e, "outbox pass failed");
        }
    }
}

async fn once(db: &PgPool, lk: Option<&LiveKit>, http: &reqwest::Client) -> anyhow::Result<()> {
    let mut conn = db.acquire().await?;
    if !sqlx::query_scalar!(r#"SELECT pg_try_advisory_lock($1) AS "l!""#, LOCK_KEY)
        .fetch_one(&mut *conn)
        .await?
    {
        return Ok(());
    }
    let result = async {
        // Claim due rows with a lease, commit, then call out (never inside a transaction).
        let due = sqlx::query!(
            "UPDATE outbox SET next_try_at = now() + interval '60 seconds', attempts = attempts + 1
             WHERE id IN (SELECT id FROM outbox WHERE done_at IS NULL AND next_try_at <= now()
                          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
             RETURNING id, kind, payload, attempts",
            BATCH
        )
        .fetch_all(db)
        .await?;
        for job in due {
            match perform(lk, http, &job.kind, &job.payload).await {
                Ok(()) => {
                    sqlx::query!("UPDATE outbox SET done_at = now(), last_error = NULL WHERE id = $1", job.id)
                        .execute(db)
                        .await?;
                }
                Err(e) => {
                    // Exponential backoff, capped at 5 minutes.
                    let wait = 2f64.powi(job.attempts.min(8)).min(300.0);
                    tracing::warn!(id = job.id, kind = %job.kind, attempts = job.attempts, error = %e, "outbox job failed");
                    sqlx::query!(
                        "UPDATE outbox SET last_error = $2, next_try_at = now() + make_interval(secs => $3) WHERE id = $1",
                        job.id,
                        e.to_string(),
                        wait
                    )
                    .execute(db)
                    .await?;
                }
            }
        }
        anyhow::Ok(())
    }
    .await;
    sqlx::query_scalar!("SELECT pg_advisory_unlock($1)", LOCK_KEY)
        .fetch_one(&mut *conn)
        .await?;
    result
}

async fn perform(
    lk: Option<&LiveKit>,
    http: &reqwest::Client,
    kind: &str,
    payload: &Value,
) -> anyhow::Result<()> {
    let Some(lk) = lk else { return Ok(()) }; // voice is off: nothing to enforce
    match kind {
        "delete_room" => {
            let room = payload["room"].as_str().unwrap_or_default();
            room_service(lk, http, "DeleteRoom", json!({ "room": room })).await
        }
        other => anyhow::bail!("unknown outbox kind {other:?}"),
    }
}

/// LiveKit RoomService (Twirp over HTTP) with a short admin token.
async fn room_service(
    lk: &LiveKit,
    http: &reqwest::Client,
    method: &str,
    body: Value,
) -> anyhow::Result<()> {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let token = livekit::sign_hs256(
        &lk.api_secret,
        &json!({ "iss": lk.api_key, "sub": "treehouse-server", "nbf": now, "exp": now + 60, "video": { "roomAdmin": true, "roomCreate": true, "roomList": true } }),
    )?;
    let base = lk
        .url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1);
    let res = http
        .post(format!(
            "{}/twirp/livekit.RoomService/{method}",
            base.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
    // A room that's already gone is the outcome we wanted.
    if res.status().is_success() || res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    anyhow::bail!("LiveKit {method} answered {}", res.status())
}
