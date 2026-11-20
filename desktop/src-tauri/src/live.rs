//! Live events: one WebSocket to the current server, opened here so the
//! token stays in Rust. Events go to the web view as `live` events. On a
//! drop it reconnects and resumes each channel from the last seq it saw.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State, async_runtime::JoinHandle};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::client::{ApiError, Client};

#[derive(Default)]
pub struct Live {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Live {
    pub fn stop(&self) {
        if let Some(t) = self.task.lock().ok().and_then(|mut t| t.take()) {
            t.abort();
        }
    }
}

#[tauri::command]
pub fn events_start(
    app: AppHandle,
    client: State<'_, Client>,
    live: State<'_, Live>,
) -> Result<(), ApiError> {
    live.stop();
    let (server, token) = client.server_and_token()?;
    let mut url = server
        .join("api/events")
        .map_err(|_| ApiError::local("bad_path", "Bad server address."))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    let _ = url.set_scheme(scheme);
    let task = tauri::async_runtime::spawn(async move {
        let mut since: HashMap<String, i64> = HashMap::new();
        let mut backoff = 1u64;
        loop {
            match run(&app, url.as_str(), &token, &mut since).await {
                Ok(Stop::SignedOut) => {
                    let _ = app.emit("live", json!({ "type": "signed_out" }));
                    return;
                }
                Ok(Stop::Dropped) => backoff = 1,
                Err(_) => {}
            }
            let _ = app.emit("live", json!({ "type": "offline" }));
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
    if let Ok(mut t) = live.task.lock() {
        *t = Some(task);
    }
    Ok(())
}

#[tauri::command]
pub fn events_stop(live: State<'_, Live>) {
    live.stop();
}

enum Stop {
    SignedOut,
    Dropped,
}

async fn run(
    app: &AppHandle,
    url: &str,
    token: &str,
    since: &mut HashMap<String, i64>,
) -> anyhow::Result<Stop> {
    let (mut ws, _) = connect_async(url).await?;
    ws.send(Message::Text(
        json!({ "token": token, "since": since }).to_string().into(),
    ))
    .await?;
    while let Some(msg) = ws.next().await {
        let Message::Text(text) = msg? else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        match v["type"].as_str() {
            Some("signed_out") => return Ok(Stop::SignedOut),
            Some("ready") => {
                if let Some(seqs) = v["seqs"].as_object() {
                    for (ch, s) in seqs {
                        let s = s.as_i64().unwrap_or(0);
                        since
                            .entry(ch.clone())
                            .and_modify(|x| *x = (*x).max(s))
                            .or_insert(s);
                    }
                }
            }
            _ => {
                if let (Some(ch), Some(seq)) = (v["channel"].as_str(), v["seq"].as_i64()) {
                    since.insert(ch.to_string(), seq);
                }
            }
        }
        app.emit("live", v)?;
    }
    Ok(Stop::Dropped)
}
