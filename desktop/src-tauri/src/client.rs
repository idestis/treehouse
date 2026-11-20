//! HTTP client for the treehouse server. The web view never sees the device
//! token: it's kept in the OS keychain, added to requests here, and stripped
//! from login/join responses before they reach the UI.

use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};
use url::Url;

const KEYCHAIN_SERVICE: &str = "app.treehouse.desktop";
/// Responses to these carry `token`; it goes to the keychain, not the UI.
const TOKEN_PATHS: [&str; 3] = ["/api/login", "/api/login/mfa", "/api/join"];

#[derive(Default)]
pub struct Client {
    http: reqwest::Client,
    server: Mutex<Option<Url>>,
    /// Keychain reads, cached per server (also "no token"). Every keychain
    /// read can show a macOS prompt for unsigned dev builds, so read once.
    tokens: Mutex<HashMap<String, Option<String>>>,
}

impl Client {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("Treehouse/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Self {
            http,
            server: Mutex::new(None),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    pub fn token(&self, server: &Url) -> Option<String> {
        let key = display_address(server);
        let mut cache = self.tokens.lock().ok()?;
        cache
            .entry(key)
            .or_insert_with(|| keychain(server).ok()?.get_password().ok())
            .clone()
    }

    fn set_token(&self, server: &Url, token: &str) -> Result<(), ApiError> {
        keychain(server)?.set_password(token).map_err(|_| {
            ApiError::local(
                "keychain_save",
                "Couldn't save your login in the system keychain.",
            )
        })?;
        if let Ok(mut c) = self.tokens.lock() {
            c.insert(display_address(server), Some(token.to_string()));
        }
        Ok(())
    }

    fn clear_token(&self, server: &Url) {
        if let Ok(k) = keychain(server) {
            let _ = k.delete_credential();
        }
        if let Ok(mut c) = self.tokens.lock() {
            c.insert(display_address(server), None);
        }
    }

    /// Current server and its stored token (for the events socket).
    pub fn server_and_token(&self) -> Result<(Url, String), ApiError> {
        let server = self.server()?;
        let t = self
            .token(&server)
            .ok_or_else(|| ApiError::local("signed_out", "You're signed out. Sign in again."))?;
        Ok((server, t))
    }

    fn server(&self) -> Result<Url, ApiError> {
        self.server
            .lock()
            .ok()
            .and_then(|s| s.clone())
            .ok_or_else(|| ApiError::local("no_server", "Pick a treehouse first."))
    }
}

/// Errors in the server's shape, so the UI handles one kind.
#[derive(Debug, Serialize)]
pub struct ApiError {
    error: String,
    message: String,
    status: u16,
    /// Values for the translated sentence (passed through from the server).
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

impl ApiError {
    pub fn local(error: &str, message: &str) -> Self {
        Self {
            error: error.into(),
            message: message.into(),
            status: 0,
            params: None,
        }
    }
    fn offline() -> Self {
        Self::local(
            "offline",
            "Can't reach the treehouse. Check the address and your connection.",
        )
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct KnownServer {
    pub address: String,
    pub name: String,
}

/// "owls.example.net" → https://owls.example.net/. Plain http only for local addresses.
fn parse_address(input: &str) -> Result<Url, ApiError> {
    let bad = || ApiError::local("bad_address", "That doesn't look like a server address.");
    let s = input.trim().trim_end_matches('/');
    if s.is_empty() {
        return Err(bad());
    }
    // Local dev servers speak plain http; everything else must be https.
    let bare_host = s.split(['/', ':']).next().unwrap_or_default();
    let local_host =
        bare_host == "localhost" || bare_host == "127.0.0.1" || bare_host.ends_with(".local");
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else if local_host {
        format!("http://{s}")
    } else {
        format!("https://{s}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| bad())?;
    let host = url.host_str().ok_or_else(bad)?;
    let local = host == "localhost" || host == "127.0.0.1" || host.ends_with(".local");
    match url.scheme() {
        "https" => Ok(url),
        "http" if local => Ok(url),
        _ => Err(bad()),
    }
}

fn display_address(url: &Url) -> String {
    let s = url.as_str().trim_end_matches('/');
    s.strip_prefix("https://").unwrap_or(s).to_string()
}

fn keychain(server: &Url) -> Result<keyring::Entry, ApiError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &display_address(server))
        .map_err(|_| ApiError::local("keychain", "Couldn't open the system keychain."))
}

fn servers_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("servers.json"))
}

fn load_servers(app: &AppHandle) -> Vec<KnownServer> {
    servers_file(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn remember_server(app: &AppHandle, server: KnownServer) {
    let mut list = load_servers(app);
    list.retain(|s| s.address != server.address);
    list.insert(0, server);
    list.truncate(8);
    let Some(p) = servers_file(app) else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(b) = serde_json::to_vec_pretty(&list) {
        let _ = std::fs::write(p, b);
    }
}

async fn send(
    client: &Client,
    server: &Url,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ApiError> {
    let url = server
        .join(path.trim_start_matches('/'))
        .map_err(|_| ApiError::local("bad_path", "Bad request path."))?;
    let mut req = client.http.request(method, url);
    if let Some(t) = client.token(server) {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|_| ApiError::offline())?;
    let status = res.status().as_u16();
    let value: Value = if status == 204 {
        Value::Null
    } else {
        res.json().await.unwrap_or(Value::Null)
    };
    if (200..300).contains(&status) {
        return Ok(value);
    }
    Err(ApiError {
        error: value["error"].as_str().unwrap_or("http_error").into(),
        message: value["message"]
            .as_str()
            .unwrap_or("The treehouse answered with an error. Try again.")
            .into(),
        status,
        params: value.get("params").filter(|p| p.is_object()).cloned(),
    })
}

/// Look up a server by address: returns its info and remembers it as current.
#[tauri::command]
pub async fn server_probe(
    app: AppHandle,
    client: State<'_, Client>,
    address: String,
) -> Result<Value, ApiError> {
    let server = parse_address(&address)?;
    let info = send(&client, &server, Method::GET, "/api/server-info", None).await?;
    let name = info["name"].as_str().unwrap_or("Treehouse").to_string();
    let address = display_address(&server);
    remember_server(
        &app,
        KnownServer {
            address: address.clone(),
            name: name.clone(),
        },
    );
    if let Ok(mut s) = client.server.lock() {
        *s = Some(server.clone());
    }
    Ok(
        json!({ "address": address, "name": name, "signed_in": client.token(&server).is_some(), "info": info }),
    )
}

#[tauri::command]
pub fn servers_list(app: AppHandle) -> Vec<KnownServer> {
    load_servers(&app)
}

/// One API call to the current server. Login/join tokens are moved to the keychain.
#[tauri::command]
pub async fn api_request(
    client: State<'_, Client>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, ApiError> {
    let server = client.server()?;
    let method = Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| ApiError::local("bad_method", "Bad request method."))?;
    let path_only = path.split('?').next().unwrap_or_default();
    let is_token_path = TOKEN_PATHS.contains(&path_only);
    let body = match body {
        // The server names the session after this computer.
        Some(Value::Object(mut m)) if is_token_path => {
            let device = whoami::fallible::devicename().unwrap_or_else(|_| "Computer".into());
            m.insert("device_name".into(), Value::String(device));
            Some(Value::Object(m))
        }
        other => other,
    };
    let mut value = send(&client, &server, method, &path, body).await?;
    if is_token_path
        && let Some(t) = value.as_object_mut().and_then(|o| o.remove("token"))
        && let Some(t) = t.as_str()
    {
        client.set_token(&server, t)?;
    }
    if path_only == "/api/logout" {
        client.clear_token(&server);
    }
    Ok(value)
}

/// Forget this computer's login for the current server (no network needed).
#[tauri::command]
pub fn session_clear(client: State<'_, Client>) -> Result<(), ApiError> {
    let server = client.server()?;
    client.clear_token(&server);
    Ok(())
}
