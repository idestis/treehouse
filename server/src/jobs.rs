//! Background cleanup, every minute. Takes an advisory lock so only one
//! replica runs it at a time. Deletion is real and batched.

use std::time::Duration;

use serde_json::json;
use sqlx::PgPool;

use crate::{error::AppResult, events};

const LOCK_KEY: i64 = 0x7472_6565; // "tree"
const BATCH: i64 = 1000;

pub async fn run(db: PgPool) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        if let Err(e) = once(&db).await {
            tracing::warn!(error = ?e, "cleanup failed");
        }
    }
}

pub async fn once(db: &PgPool) -> AppResult<()> {
    let mut conn = db.acquire().await?;
    let got = sqlx::query_scalar!(r#"SELECT pg_try_advisory_lock($1) AS "l!""#, LOCK_KEY)
        .fetch_one(&mut *conn)
        .await?;
    if !got {
        return Ok(());
    }
    let result = cleanup(db).await;
    sqlx::query_scalar!("SELECT pg_advisory_unlock($1)", LOCK_KEY)
        .fetch_one(&mut *conn)
        .await?;
    result
}

async fn cleanup(db: &PgPool) -> AppResult<()> {
    // Messages past the lifetime (reactions go with them).
    loop {
        let n = sqlx::query!(
            "DELETE FROM messages WHERE id IN (
                 SELECT m.id FROM messages m, treehouse t
                 WHERE m.created_at < now() - make_interval(hours => t.message_ttl_hours) LIMIT $1)",
            BATCH
        )
        .execute(db)
        .await?
        .rows_affected();
        if n < BATCH as u64 {
            break;
        }
    }
    sqlx::query!("DELETE FROM events WHERE created_at < now() - interval '2 days'")
        .execute(db)
        .await?;
    sqlx::query!("DELETE FROM sessions WHERE expires_at < now()")
        .execute(db)
        .await?;
    sqlx::query!("DELETE FROM mfa_challenges WHERE expires_at < now()")
        .execute(db)
        .await?;
    sqlx::query!("DELETE FROM mod_log WHERE at < now() - interval '90 days'")
        .execute(db)
        .await?;
    // LiveKit webhook tombstones only need to outlive a late retry.
    sqlx::query!("DELETE FROM voice_left WHERE left_at < now() - interval '1 day'")
        .execute(db)
        .await?;

    // Connections of a replica that died without saying goodbye.
    let stale = sqlx::query!(
        "DELETE FROM connections WHERE last_ping < now() - interval '2 minutes' RETURNING user_id"
    )
    .fetch_all(db)
    .await?;
    for r in stale {
        let mut tx = db.begin().await?;
        sqlx::query!("SELECT id FROM users WHERE id = $1 FOR UPDATE", r.user_id)
            .fetch_one(&mut *tx)
            .await?;
        let online = sqlx::query_scalar!(
            r#"SELECT EXISTS (SELECT 1 FROM connections WHERE user_id = $1) AS "e!""#,
            r.user_id
        )
        .fetch_one(&mut *tx)
        .await?;
        if !online {
            events::emit(
                &mut tx,
                events::TREEHOUSE,
                "presence",
                json!({ "user_id": r.user_id, "online": false }),
            )
            .await?;
        }
        tx.commit().await?;
    }
    Ok(())
}
