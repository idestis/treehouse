//! Treehouse server. One binary, configured only by environment variables.
//!
//! Usage:
//!   treehouse                        run the server
//!   treehouse setup-invite           new setup invite (only while no admin exists)
//!   treehouse admin promote <user>   recovery: make an admin
//!   treehouse admin reset-mfa <user> recovery: turn off two-step sign-in
//!   treehouse admin unblock <user>   recovery: unblock and unlock
//!   treehouse healthcheck            exit 0 if this container's server answers /healthz
//!                                    (for Docker HEALTHCHECK; the image has no curl)

mod auth;
mod config;
mod error;
mod events;
mod gifs;
mod http;
mod jobs;
mod perms;
mod setup;
mod util;

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    process::ExitCode,
    time::Duration,
};

use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::config::{Config, LogFormat};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("serve") => report(serve()),
        Some("setup-invite") => report(cli(|db, cfg| async move {
            setup::new_setup_invite(&db, &cfg.public_url, cfg.setup_invite_ttl).await
        })),
        Some("admin") => match (args.get(1), args.get(2)) {
            (Some(action), Some(user)) => {
                let (action, user) = (action.clone(), user.clone());
                report(cli(|db, _| async move {
                    setup::admin(&db, &action, &user).await
                }))
            }
            _ => {
                eprintln!("usage: treehouse admin <promote|reset-mfa|unblock> <username>");
                ExitCode::from(2)
            }
        },
        Some("healthcheck") => healthcheck(),
        Some("version" | "--version" | "-V") => {
            println!("treehouse {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!(
                "treehouse: unknown command {other:?}. Commands: serve, healthcheck, version"
            );
            ExitCode::from(2)
        }
    }
}

fn report(r: Result<()>) -> ExitCode {
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("treehouse: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Run a one-off command against the database (migrations first).
#[tokio::main]
async fn cli<F, Fut>(f: F) -> Result<()>
where
    F: FnOnce(sqlx::PgPool, Config) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let cfg = Config::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(2)
        .connect(&cfg.database_url)
        .await
        .context("can't connect to Postgres (check DATABASE_URL)")?;
    sqlx::migrate!("./migrations")
        .run(&db)
        .await
        .context("migrations failed")?;
    f(db, cfg).await
}

#[tokio::main]
async fn serve() -> Result<()> {
    let cfg = Config::from_env()?;
    init_tracing(cfg.log_format);
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        bind = %cfg.bind_addr,
        public_url = %cfg.public_url,
        setup_invite_ttl_min = cfg.setup_invite_ttl.as_secs() / 60,
        max_voice_rooms = cfg.max_voice_rooms,
        gifs = cfg.giphy_api_key.is_some(),
        "starting"
    );

    let db = PgPoolOptions::new()
        .max_connections(cfg.db_max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&cfg.database_url)
        .await
        .context("can't connect to Postgres (check DATABASE_URL)")?;

    if cfg.run_migrations {
        // Takes a Postgres advisory lock, so replicas starting together don't race.
        sqlx::migrate!("./migrations")
            .run(&db)
            .await
            .context("migrations failed")?;
        tracing::info!("migrations up to date");
    }

    setup::ensure_setup_invite(&db, &cfg.public_url, cfg.setup_invite_ttl).await?;

    let (events_tx, _) = tokio::sync::broadcast::channel(1024);
    tokio::spawn(events::run_listener(db.clone(), events_tx.clone()));
    tokio::spawn(jobs::run(db.clone()));

    let state = http::AppState {
        db: db.clone(),
        cfg: std::sync::Arc::new(cfg.clone()),
        events: events_tx,
        gifs: std::sync::Arc::new(gifs::Gifs::new(cfg.giphy_api_key.clone())),
    };
    let app = http::router(state);
    let listener = TcpListener::bind(cfg.bind_addr)
        .await
        .with_context(|| format!("can't listen on {}", cfg.bind_addr))?;
    tracing::info!(addr = %cfg.bind_addr, "listening");

    let grace = cfg.shutdown_grace;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(grace))
        .await?;
    db.close().await;
    tracing::info!("stopped");
    Ok(())
}

/// Resolves on SIGTERM or Ctrl+C. Open connections then get `grace` to finish
/// before the process exits anyway.
async fn shutdown_signal(grace: Duration) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!(grace_secs = grace.as_secs(), "shutting down");
    tokio::spawn(async move {
        tokio::time::sleep(grace).await;
        tracing::warn!("grace period over, exiting");
        std::process::exit(0);
    });
}

fn init_tracing(format: LogFormat) {
    let filter = EnvFilter::try_from_env("LOG_LEVEL")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info,sqlx=warn"));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    match format {
        LogFormat::Json => builder.json().flatten_event(true).init(),
        LogFormat::Pretty => builder.init(),
    }
}

/// Plain HTTP/1.0 GET to our own /healthz. Blocking std only, no runtime.
fn healthcheck() -> ExitCode {
    let port = std::env::var("BIND_ADDR")
        .ok()
        .and_then(|a| a.parse::<SocketAddr>().ok())
        .map_or(8080, |a| a.port());
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let ok = (|| -> std::io::Result<bool> {
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
        s.set_read_timeout(Some(Duration::from_secs(2)))?;
        s.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut buf = [0u8; 32];
        let n = s.read(&mut buf)?;
        Ok(buf[..n].starts_with(b"HTTP/1.0 200") || buf[..n].starts_with(b"HTTP/1.1 200"))
    })()
    .unwrap_or(false);
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
