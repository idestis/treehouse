//! Treehouse desktop backend.
//!
//! The Rust side owns everything secret: it talks to the Treehouse server,
//! keeps the device token in the OS keychain, and only hands the UI a
//! short-lived voice token when it is time to join the room.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "app.treehouse.desktop";
const KEYRING_USER: &str = "device-token";

#[derive(Serialize, Deserialize, Clone)]
struct Me {
    username: String,
    display_name: String,
    color: String,
}

/// Non-secret settings, stored as JSON in the app's config folder.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Settings {
    server: Option<String>,
    me: Option<Me>,
}

#[derive(Serialize)]
struct Session {
    server: String,
    me: Me,
    /// True when the server couldn't be reached and `me` is from the last visit.
    offline: bool,
}

#[derive(Serialize, Deserialize)]
struct VoiceToken {
    url: String,
    token: String,
    room: String,
    room_name: String,
}

// ---------- storage ----------

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(app)?, bytes).map_err(|e| e.to_string())
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn load_token() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

fn save_token(token: &str) -> Result<(), String> {
    keyring_entry()?
        .set_password(token)
        .map_err(|e| format!("Couldn’t save the sign-in to this computer’s keychain: {e}"))
}

fn forget_token() {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
}

// ---------- http ----------

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("Treehouse/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

/// Accepts `chat.example.com`, `https://chat.example.com/`, etc.
fn normalize_server(input: &str) -> Result<String, String> {
    let s = input.trim().trim_end_matches('/');
    if s.is_empty() {
        return Err("Type the server address, like chat.example.com".into());
    }
    let s = if s.starts_with("http://") || s.starts_with("https://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    // Plain http is only allowed for local testing.
    if s.starts_with("http://") && !(s.contains("://localhost") || s.contains("://127.0.0.1")) {
        return Err("The server address must start with https://".into());
    }
    Ok(s)
}

fn friendly(e: reqwest::Error) -> String {
    if e.is_timeout() || e.is_connect() {
        "Can’t reach the server. Check the address and your internet connection.".into()
    } else {
        format!("Network problem: {e}")
    }
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| match std::env::consts::OS {
            "macos" => "Mac".into(),
            "windows" => "Windows PC".into(),
            _ => "Linux PC".into(),
        })
}

// ---------- commands ----------

/// Called on startup: are we paired, and who are we?
#[tauri::command]
async fn session(app: AppHandle) -> Result<Option<Session>, String> {
    let settings = load_settings(&app);
    let (Some(server), Some(token)) = (settings.server.clone(), load_token()) else {
        return Ok(None);
    };

    match client().get(format!("{server}/api/me")).bearer_auth(&token).send().await {
        Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED => {
            // Removed on the website or account paused: start over.
            forget_token();
            save_settings(&app, &Settings { server: Some(server), me: None })?;
            Ok(None)
        }
        Ok(resp) if resp.status().is_success() => {
            let me: Me = resp.json().await.map_err(|e| e.to_string())?;
            save_settings(&app, &Settings { server: Some(server.clone()), me: Some(me.clone()) })?;
            Ok(Some(Session { server, me, offline: false }))
        }
        _ => Ok(settings.me.map(|me| Session { server, me, offline: true })),
    }
}

#[tauri::command]
fn last_server(app: AppHandle) -> Option<String> {
    load_settings(&app).server
}

#[derive(Serialize)]
struct PairBody {
    code: String,
    device_name: String,
}

#[derive(Deserialize)]
struct PairReply {
    token: String,
    me: Me,
}

#[tauri::command]
async fn pair(app: AppHandle, server: String, code: String) -> Result<Session, String> {
    let server = normalize_server(&server)?;
    let resp = client()
        .post(format!("{server}/api/pair"))
        .json(&PairBody { code, device_name: device_name() })
        .send()
        .await
        .map_err(friendly)?;
    if !resp.status().is_success() {
        let msg = resp.text().await.unwrap_or_default();
        return Err(if msg.is_empty() { "Pairing didn’t work. Make a new code on the website.".into() } else { msg });
    }
    let reply: PairReply = resp
        .json()
        .await
        .map_err(|_| "That address doesn’t look like a Treehouse server.".to_string())?;
    save_token(&reply.token)?;
    save_settings(&app, &Settings { server: Some(server.clone()), me: Some(reply.me.clone()) })?;
    Ok(Session { server, me: reply.me, offline: false })
}

/// Rooms and who's in them (the server asks LiveKit). Passed through as JSON.
#[tauri::command]
async fn rooms(app: AppHandle) -> Result<serde_json::Value, String> {
    let server = load_settings(&app).server.ok_or("This computer isn’t paired.")?;
    let token = load_token().ok_or("This computer isn’t paired.")?;
    let resp = client()
        .get(format!("{server}/api/rooms"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(friendly)?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        forget_token();
        return Err("This computer was removed from your account. Pair it again.".into());
    }
    resp.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn voice_token(app: AppHandle, room: String) -> Result<VoiceToken, String> {
    let server = load_settings(&app).server.ok_or("This computer isn’t paired.")?;
    let token = load_token().ok_or("This computer isn’t paired.")?;
    let resp = client()
        .post(format!("{server}/api/voice-token"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "room": room }))
        .send()
        .await
        .map_err(friendly)?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        forget_token();
        return Err("This computer was removed from your account. Pair it again.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("The server said no ({}).", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn unpair(app: AppHandle) -> Result<(), String> {
    let settings = load_settings(&app);
    if let (Some(server), Some(token)) = (settings.server.clone(), load_token()) {
        // Best effort: also remove it from the account on the server.
        let _ = client().post(format!("{server}/api/unpair")).bearer_auth(token).send().await;
    }
    forget_token();
    save_settings(&app, &Settings { server: settings.server, me: None })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![session, last_server, pair, rooms, voice_token, unpair])
        .run(tauri::generate_context!())
        .expect("error while running Treehouse");
}
