//! People admin (spec §2, §9.3): change someone's role, block, unblock.
//! Admins only, and only the owner acts on other admins.
//!
//! Each action is one transaction: lock the treehouse row (rules here span
//! rows, like "at least one admin"), re-read the actor and lock the target,
//! check, write, log to `mod_log`, emit `people`.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgConnection;

use crate::{
    auth::{Authed, User},
    error::{AppError, AppResult},
    events,
    http::{AppState, voice},
    livekit,
    perms::{self, Actor, Role},
};

struct Target {
    id: i64,
    display_name: String,
    role: Role,
    is_owner: bool,
    blocked: bool,
}

/// Lock the treehouse row, then load the actor as they are now (their role
/// may have changed since the request was authenticated) and lock the target.
async fn begin(conn: &mut PgConnection, user: &User, target_id: i64) -> AppResult<(Actor, Target)> {
    sqlx::query!("SELECT id FROM treehouse FOR UPDATE")
        .fetch_one(&mut *conn)
        .await?;
    let a = sqlx::query!(
        "SELECT role, is_owner FROM users WHERE id = $1 AND blocked_at IS NULL",
        user.id
    )
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::from(perms::Denied))?;
    let actor = Actor {
        id: user.id,
        role: a.role.parse()?,
        is_owner: a.is_owner,
    };
    let t = sqlx::query!(
        r#"SELECT id, display_name, role, is_owner, (blocked_at IS NOT NULL) AS "blocked!"
           FROM users WHERE id = $1 FOR UPDATE"#,
        target_id
    )
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::not_found("person_gone", "That person isn't here anymore."))?;
    Ok((
        actor,
        Target {
            id: t.id,
            display_name: t.display_name,
            role: t.role.parse()?,
            is_owner: t.is_owner,
            blocked: t.blocked,
        },
    ))
}

/// Admins who can still sign in. Called with the treehouse row locked.
async fn active_admins(conn: &mut PgConnection) -> AppResult<i64> {
    Ok(sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM users WHERE role = 'admin' AND blocked_at IS NULL"#
    )
    .fetch_one(conn)
    .await?)
}

async fn log(
    conn: &mut PgConnection,
    action: &str,
    user: &User,
    target: &Target,
    reason: Option<&str>,
    details: serde_json::Value,
) -> AppResult<()> {
    sqlx::query!(
        "INSERT INTO mod_log (action, actor_id, actor_name, target_id, target_name, reason, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        action,
        user.id,
        user.display_name,
        target.id,
        target.display_name,
        reason,
        details
    )
    .execute(conn)
    .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct RoleIn {
    role: Role,
}

/// `PATCH /api/people/{id}/role`.
pub async fn set_role(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    Json(inp): Json<RoleIn>,
) -> AppResult<StatusCode> {
    let mut tx = st.db.begin().await?;
    change_role(&mut tx, &user, id, inp.role).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The whole role change, inside the caller's transaction.
async fn change_role(conn: &mut PgConnection, user: &User, id: i64, role: Role) -> AppResult<()> {
    let (actor, target) = begin(conn, user, id).await?;
    perms::can_change_role(actor, target.id, target.role, role)?;
    if target.role == role {
        return Ok(());
    }
    if target.is_owner {
        return Err(AppError::conflict(
            "owner_stays_admin",
            "The owner always stays an admin.",
        ));
    }
    if target.role == Role::Admin && !target.blocked && active_admins(conn).await? <= 1 {
        return Err(AppError::conflict(
            "last_admin",
            "There must be at least one admin. Make someone else an admin first.",
        ));
    }
    sqlx::query!(
        "UPDATE users SET role = $1 WHERE id = $2",
        role.as_str(),
        target.id
    )
    .execute(&mut *conn)
    .await?;
    log(
        conn,
        "set_role",
        user,
        &target,
        None,
        json!({ "from": target.role, "to": role }),
    )
    .await?;
    events::emit(conn, events::TREEHOUSE, "people", json!({})).await?;
    tracing::info!(actor = user.id, target = target.id, from = %target.role, to = %role, "role changed");
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct BlockIn {
    reason: Option<String>,
}

/// `POST /api/people/{id}/block`: signs them out everywhere and removes them
/// from voice. Their messages stay until they expire.
pub async fn block(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
    inp: Option<Json<BlockIn>>,
) -> AppResult<StatusCode> {
    let reason = inp
        .and_then(|Json(b)| b.reason)
        .map(|r| r.trim().chars().take(200).collect::<String>())
        .filter(|r| !r.is_empty());
    let mut tx = st.db.begin().await?;
    block_person(&mut tx, &user, id, reason.as_deref()).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The whole block, inside the caller's transaction.
async fn block_person(
    conn: &mut PgConnection,
    user: &User,
    id: i64,
    reason: Option<&str>,
) -> AppResult<()> {
    let (actor, target) = begin(conn, user, id).await?;
    perms::can_block(actor, target.id, target.role)?;
    if target.blocked {
        return Ok(());
    }
    if target.role == Role::Admin && active_admins(conn).await? <= 1 {
        return Err(AppError::conflict(
            "last_admin",
            "The last admin can't be blocked.",
        ));
    }
    // The blocked_at trigger closes their live connections on commit.
    sqlx::query!(
        "UPDATE users SET blocked_at = now(), blocked_reason = $1 WHERE id = $2",
        reason,
        target.id
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query!("DELETE FROM sessions WHERE user_id = $1", target.id)
        .execute(&mut *conn)
        .await?;
    let room = sqlx::query_scalar!(
        "DELETE FROM voice_members WHERE user_id = $1 RETURNING room_id",
        target.id
    )
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(room) = room {
        // LiveKit is told after commit, by the outbox worker.
        for identity in [target.id.to_string(), livekit::overlay_identity(target.id)] {
            sqlx::query!(
                "INSERT INTO outbox (kind, payload) VALUES ('remove_participant', $1)",
                livekit::remove_participant_payload(room, &identity)
            )
            .execute(&mut *conn)
            .await?;
        }
        voice::after_leave(conn, room).await?;
    }
    log(conn, "block", user, &target, reason, json!({})).await?;
    events::emit(conn, events::TREEHOUSE, "people", json!({})).await?;
    tracing::info!(actor = user.id, target = target.id, "blocked");
    Ok(())
}

/// `POST /api/people/{id}/unblock`.
pub async fn unblock(
    State(st): State<AppState>,
    Authed(user): Authed,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    let mut tx = st.db.begin().await?;
    let (actor, target) = begin(&mut tx, &user, id).await?;
    perms::can_block(actor, target.id, target.role)?;
    if !target.blocked {
        return Ok(StatusCode::NO_CONTENT);
    }
    sqlx::query!(
        "UPDATE users SET blocked_at = NULL, blocked_reason = NULL, locked_until = NULL, failed_logins = 0
         WHERE id = $1",
        target.id
    )
    .execute(&mut *tx)
    .await?;
    log(&mut tx, "unblock", &user, &target, None, json!({})).await?;
    events::emit(&mut tx, events::TREEHOUSE, "people", json!({})).await?;
    tx.commit().await?;
    tracing::info!(actor = user.id, target = target.id, "unblocked");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    //! Concurrency: the "at least one admin" rule under parallel requests.
    //! Runs against the dev Postgres (`task db`); `sqlx::test` makes a fresh
    //! database per test and applies the migrations.

    use super::*;
    use sqlx::PgPool;

    async fn add_user(db: &PgPool, name: &str, role: &str, owner: bool) -> i64 {
        sqlx::query_scalar!(
            "INSERT INTO users (username, display_name, password_hash, role, is_owner)
             VALUES ($1::text::citext, $1, 'x', $2, $3) RETURNING id",
            name,
            role,
            owner
        )
        .fetch_one(db)
        .await
        .unwrap()
    }

    async fn demote(db: &PgPool, actor_id: i64, target_id: i64) -> AppResult<()> {
        let mut tx = db.begin().await?;
        change_role(
            &mut tx,
            &crate::auth::test_user(actor_id),
            target_id,
            Role::Member,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn admins_stepping_down_at_once_leave_one(db: PgPool) {
        // 20 non-owner admins all step down at the same moment: exactly one stays.
        let mut ids = Vec::new();
        for i in 0..20 {
            ids.push(add_user(&db, &format!("admin{i}"), "admin", false).await);
        }
        let tasks: Vec<_> = ids
            .iter()
            .map(|&id| {
                let db = db.clone();
                tokio::spawn(async move { demote(&db, id, id).await.is_ok() })
            })
            .collect();
        let mut ok = 0;
        for t in tasks {
            if t.await.unwrap() {
                ok += 1;
            }
        }
        assert_eq!(ok, 19);
        let left: i64 =
            sqlx::query_scalar!(r#"SELECT count(*) AS "n!" FROM users WHERE role = 'admin'"#)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(left, 1);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn owner_and_admin_demoting_each_other_leave_an_admin(db: PgPool) {
        // Two admins demote each other at the same moment, 10 times each.
        // Only the owner may act on another admin, and the owner can't be
        // demoted, so the owner always remains.
        let owner = add_user(&db, "owner", "admin", true).await;
        let other = add_user(&db, "other", "admin", false).await;
        let tasks: Vec<_> = (0..20)
            .map(|i| {
                let db = db.clone();
                let (a, t) = if i % 2 == 0 {
                    (owner, other)
                } else {
                    (other, owner)
                };
                tokio::spawn(async move { (a, demote(&db, a, t).await.is_ok()) })
            })
            .collect();
        for t in tasks {
            let (actor, ok) = t.await.unwrap();
            assert_eq!(ok, actor == owner, "actor {actor}");
        }
        let roles: Vec<(i64, String)> = sqlx::query_as("SELECT id, role FROM users ORDER BY id")
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(
            roles,
            vec![(owner, "admin".into()), (other, "member".into())]
        );
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn blocking_signs_out_and_leaves_voice(db: PgPool) {
        let owner = add_user(&db, "owner", "admin", true).await;
        let admin = add_user(&db, "admin", "admin", false).await;
        let kid = add_user(&db, "kid", "member", false).await;
        let room: i64 = sqlx::query_scalar("SELECT id FROM rooms WHERE kind = 'voice' LIMIT 1")
            .fetch_one(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions (token_hash, user_id, device_name, expires_at) VALUES ('h', $1, 'pc', now() + interval '1 day')")
            .bind(kid)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO voice_members (room_id, user_id) VALUES ($1, $2)")
            .bind(room)
            .bind(kid)
            .execute(&db)
            .await
            .unwrap();

        let block = |actor: i64, target: i64| {
            let db = db.clone();
            async move {
                let mut tx = db.begin().await?;
                block_person(
                    &mut tx,
                    &crate::auth::test_user(actor),
                    target,
                    Some("rude"),
                )
                .await?;
                tx.commit().await?;
                AppResult::Ok(())
            }
        };
        // A non-owner admin can't block another admin; nobody blocks themselves.
        assert!(block(admin, owner).await.is_err());
        assert!(block(owner, owner).await.is_err());
        block(admin, kid).await.unwrap();

        let n = |sql: &'static str| {
            let db = db.clone();
            async move {
                sqlx::query_scalar::<_, i64>(sql)
                    .bind(kid)
                    .fetch_one(&db)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(
            n("SELECT count(*) FROM users WHERE id = $1 AND blocked_at IS NOT NULL").await,
            1
        );
        assert_eq!(
            n("SELECT count(*) FROM sessions WHERE user_id = $1").await,
            0
        );
        assert_eq!(
            n("SELECT count(*) FROM voice_members WHERE user_id = $1").await,
            0
        );
        assert_eq!(n("SELECT count(*) FROM mod_log WHERE action = 'block' AND target_id = $1 AND reason = 'rude'").await, 1);
        assert_eq!(
            n("SELECT count(*) FROM outbox WHERE kind = 'remove_participant' AND $1 > 0").await,
            2
        );
    }
}
