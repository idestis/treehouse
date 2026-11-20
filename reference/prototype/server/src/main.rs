mod api;
mod auth;
mod livekit;
mod util;
mod web;

use std::sync::Arc;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tower_http::trace::TraceLayer;

pub struct Config {
    pub bind_addr: String,
    pub database_url: String,
    /// Where people open the website, e.g. https://chat.example.com
    pub public_url: String,
    /// What the desktop app connects to for voice, e.g. wss://voice.example.com
    pub livekit_url: String,
    pub livekit_api_key: String,
    pub livekit_api_secret: String,
    /// How this server reaches LiveKit directly (not through Caddy).
    pub livekit_api_url: String,
    pub rooms: Vec<RoomDef>,
    pub cookie_secure: bool,
}

impl Config {
    fn from_env() -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).map_err(|_| anyhow::anyhow!("missing env var {k}"));
        let opt = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        Ok(Config {
            bind_addr: opt("BIND_ADDR", "127.0.0.1:8080"),
            database_url: opt("DATABASE_URL", "sqlite://data/treehouse.db"),
            public_url: var("PUBLIC_URL")?,
            livekit_url: var("LIVEKIT_URL")?,
            livekit_api_key: var("LIVEKIT_API_KEY")?,
            livekit_api_secret: var("LIVEKIT_API_SECRET")?,
            livekit_api_url: opt("LIVEKIT_API_URL", "http://127.0.0.1:7880"),
            rooms: parse_rooms(&opt("ROOMS", "deck:The Deck,loft:Gaming Loft,nook:Quiet Nook")),
            cookie_secure: opt("COOKIE_SECURE", "true") != "false",
        })
    }
}

#[derive(Clone)]
pub struct RoomDef {
    pub id: String,
    pub name: String,
}

/// `deck:The Deck,loft:Gaming Loft` -> rooms. Ids are letters, digits, - and _.
fn parse_rooms(spec: &str) -> Vec<RoomDef> {
    let rooms: Vec<RoomDef> = spec
        .split(',')
        .filter_map(|part| {
            let (id, name) = part.split_once(':').unwrap_or((part, part));
            let id: String = id
                .trim()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            let name = name.trim();
            (!id.is_empty()).then(|| RoomDef { id, name: if name.is_empty() { "Room".into() } else { name.into() } })
        })
        .collect();
    if rooms.is_empty() {
        vec![RoomDef { id: "deck".into(), name: "The Deck".into() }]
    } else {
        rooms
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<Config>,
    pub http: reqwest::Client,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "treehouse_server=info,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env()?;

    let opts: SqliteConnectOptions = config.database_url.parse::<SqliteConnectOptions>()?
        .create_if_missing(true)
        .foreign_keys(true);
    let db = SqlitePoolOptions::new().max_connections(5).connect_with(opts).await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    let state = AppState { db, config: Arc::new(config), http: reqwest::Client::new() };
    bootstrap_admin_invite(&state).await?;

    let app = web::routes()
        .merge(api::routes())
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(&state.config.bind_addr).await?;
    tracing::info!("listening on {}", state.config.bind_addr);
    axum::serve(listener, app).await?;
    Ok(())
}

/// On a fresh install there are no users, so print a one-time admin invite.
async fn bootstrap_admin_invite(state: &AppState) -> anyhow::Result<()> {
    let (users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(&state.db).await?;
    if users > 0 {
        return Ok(());
    }
    let existing: Option<(String,)> = sqlx::query_as(
        "SELECT code FROM invites WHERE make_admin = 1 AND used_by IS NULL AND expires_at > ?",
    )
    .bind(util::now())
    .fetch_optional(&state.db)
    .await?;
    let code = match existing {
        Some((code,)) => code,
        None => {
            let code = util::normalize_code(&util::human_code(2, 5));
            sqlx::query(
                "INSERT INTO invites (code, note, make_admin, created_at, expires_at) VALUES (?, 'First admin', 1, ?, ?)",
            )
            .bind(&code)
            .bind(util::now())
            .bind(util::now() + 7 * 86_400)
            .execute(&state.db)
            .await?;
            code
        }
    };
    tracing::warn!(
        "No accounts yet. Create the admin account here: {}/join?code={}",
        state.config.public_url.trim_end_matches('/'),
        code
    );
    Ok(())
}
