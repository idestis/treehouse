//! Configuration, read from environment variables only (see deploy/.env.example).
//! Every variable has a default except secrets.

use std::{env, net::SocketAddr, str::FromStr, time::Duration};

use anyhow::{Context, Result, bail};

#[derive(Debug, Clone)]
pub struct Config {
    /// `BIND_ADDR`: where the HTTP server listens.
    pub bind_addr: SocketAddr,
    /// `DATABASE_URL`: Postgres connection string. Required (it holds the password).
    pub database_url: String,
    /// `PUBLIC_URL`: how clients reach this server, used in invite links.
    pub public_url: String,
    /// `DB_MAX_CONNECTIONS`: pool size per replica.
    pub db_max_connections: u32,
    /// `RUN_MIGRATIONS`: apply pending migrations at startup. Safe with several
    /// replicas: sqlx holds a Postgres advisory lock while migrating.
    pub run_migrations: bool,
    /// `LOG_FORMAT`: `json` (default, for containers) or `pretty`.
    pub log_format: LogFormat,
    /// `SETUP_INVITE_TTL`: setup invite lifetime in minutes (15..=1440).
    pub setup_invite_ttl: Duration,
    /// `MAX_VOICE_ROOMS`: default voice room limit for a new treehouse (1..=6).
    pub max_voice_rooms: u16,
    /// `SHUTDOWN_GRACE_SECS`: how long to drain requests after SIGTERM.
    pub shutdown_grace: Duration,
    /// `GIPHY_API_KEY`: GIF search; GIFs are off without it.
    pub giphy_api_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Json,
    Pretty,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let setup_ttl_min: u64 = var_or("SETUP_INVITE_TTL", 120)?;
        if !(15..=1440).contains(&setup_ttl_min) {
            bail!("SETUP_INVITE_TTL must be 15 to 1440 minutes, got {setup_ttl_min}");
        }
        let max_voice_rooms: u16 = var_or("MAX_VOICE_ROOMS", 3)?;
        if !(1..=6).contains(&max_voice_rooms) {
            bail!("MAX_VOICE_ROOMS must be 1 to 6, got {max_voice_rooms}");
        }
        let log_format = match env::var("LOG_FORMAT").as_deref() {
            Ok("pretty") => LogFormat::Pretty,
            Ok("json") | Err(_) => LogFormat::Json,
            Ok(other) => bail!("LOG_FORMAT must be json or pretty, got {other}"),
        };
        Ok(Self {
            bind_addr: var_or("BIND_ADDR", SocketAddr::from(([0, 0, 0, 0], 8080)))?,
            database_url: env::var("DATABASE_URL").context("DATABASE_URL is not set")?,
            public_url: env::var("PUBLIC_URL")
                .unwrap_or_else(|_| "http://localhost:8080".into())
                .trim_end_matches('/')
                .to_string(),
            db_max_connections: var_or("DB_MAX_CONNECTIONS", 10)?,
            run_migrations: var_or("RUN_MIGRATIONS", true)?,
            log_format,
            setup_invite_ttl: Duration::from_secs(setup_ttl_min * 60),
            max_voice_rooms,
            shutdown_grace: Duration::from_secs(var_or("SHUTDOWN_GRACE_SECS", 10)?),
            giphy_api_key: env::var("GIPHY_API_KEY")
                .ok()
                .filter(|k| !k.trim().is_empty()),
        })
    }
}

fn var_or<T>(name: &str, default: T) -> Result<T>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Ok(v) if !v.trim().is_empty() => v
            .trim()
            .parse()
            .map_err(|e| anyhow::anyhow!("{name}={v:?} is invalid: {e}")),
        _ => Ok(default),
    }
}
