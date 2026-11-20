//! First boot: a single-use setup invite for the owner. Plus the recovery
//! commands that only work from a server shell.

use std::time::Duration;

use anyhow::{Result, bail};
use qrcode::{QrCode, render::unicode};
use sqlx::PgPool;

use crate::{http::invites_link, util};

/// On startup: if nobody is an admin yet and no setup invite is waiting, make one.
pub async fn ensure_setup_invite(db: &PgPool, public_url: &str, ttl: Duration) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query!("SELECT id FROM treehouse FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let has_admin =
        sqlx::query_scalar!(r#"SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin') AS "e!""#)
            .fetch_one(&mut *tx)
            .await?;
    if has_admin {
        return Ok(());
    }
    let waiting = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM invites WHERE is_setup AND uses = 0 AND expires_at > now()) AS "e!""#
    )
    .fetch_one(&mut *tx)
    .await?;
    if waiting {
        tracing::warn!(
            "a setup invite is waiting; lost it? run `treehouse setup-invite` for a new one"
        );
        return Ok(());
    }
    let code = create(&mut tx, ttl).await?;
    tx.commit().await?;
    print_invite(public_url, &code, ttl);
    Ok(())
}

/// `treehouse setup-invite`: replace the setup invite. Only while no admin exists.
pub async fn new_setup_invite(db: &PgPool, public_url: &str, ttl: Duration) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query!("SELECT id FROM treehouse FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    let has_admin =
        sqlx::query_scalar!(r#"SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin') AS "e!""#)
            .fetch_one(&mut *tx)
            .await?;
    if has_admin {
        bail!("this treehouse already has an admin; they can make invites in the app");
    }
    sqlx::query!("UPDATE invites SET expires_at = now() WHERE is_setup AND expires_at > now()")
        .execute(&mut *tx)
        .await?;
    let code = create(&mut tx, ttl).await?;
    tx.commit().await?;
    print_invite(public_url, &code, ttl);
    Ok(())
}

async fn create(conn: &mut sqlx::PgConnection, ttl: Duration) -> Result<String> {
    let code = util::invite_code();
    sqlx::query!(
        "INSERT INTO invites (code_hash, label, role, is_setup, max_uses, expires_at)
         VALUES ($1, 'Owner', 'admin', true, 1, now() + make_interval(secs => $2))",
        util::sha256(&code),
        ttl.as_secs_f64()
    )
    .execute(conn)
    .await?;
    Ok(code)
}

fn print_invite(public_url: &str, code: &str, ttl: Duration) {
    let link = invites_link(public_url, code);
    let qr = QrCode::new(link.as_bytes())
        .map(|q| q.render::<unicode::Dense1x2>().quiet_zone(true).build())
        .unwrap_or_default();
    tracing::info!(link = %link, valid_minutes = ttl.as_secs() / 60, "setup invite created");
    // Plain stdout so it reads well in `docker compose logs`.
    println!(
        "\n  Your treehouse is ready. Open this link, or type the server address in the app\n  and choose \"I have an invite code\":\n\n    {link}\n    code: {code}   (works once, for {} minutes)\n\n{qr}\n",
        ttl.as_secs() / 60
    );
}

/// `treehouse admin <promote|reset-mfa|unblock> <username>`.
pub async fn admin(db: &PgPool, action: &str, username: &str) -> Result<()> {
    let mut tx = db.begin().await?;
    let id = sqlx::query_scalar!(
        "SELECT id FROM users WHERE username = $1::text::citext FOR UPDATE",
        username
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else {
        bail!("no user called {username:?}")
    };
    match action {
        "promote" => {
            sqlx::query!("UPDATE users SET role = 'admin' WHERE id = $1", id)
                .execute(&mut *tx)
                .await?;
        }
        "reset-mfa" => {
            sqlx::query!("DELETE FROM mfa WHERE user_id = $1", id)
                .execute(&mut *tx)
                .await?;
            sqlx::query!("DELETE FROM sessions WHERE user_id = $1", id)
                .execute(&mut *tx)
                .await?;
        }
        "unblock" => {
            sqlx::query!("UPDATE users SET blocked_at = NULL, blocked_reason = NULL, locked_until = NULL, failed_logins = 0 WHERE id = $1", id)
                .execute(&mut *tx)
                .await?;
        }
        other => bail!("unknown admin action {other:?}; use promote, reset-mfa or unblock"),
    }
    sqlx::query!(
        "INSERT INTO mod_log (action, actor_name, target_id, target_name, details) VALUES ($1, 'server shell', $2, $3, '{}')",
        format!("cli_{}", action.replace('-', "_")),
        id,
        username
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    println!("done: {action} {username}");
    Ok(())
}
