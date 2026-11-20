//! Self-update through `tauri-plugin-updater`.
//!
//! The feed (`latest.json` on R2) is baked in at build time from
//! `TREEHOUSE_UPDATE_URL`, which the release tasks set from `R2_PUBLIC_URL`.
//! Dev and local builds don't set it, so they never check for updates.
//! macOS replaces the .app in place and we restart; on Windows the NSIS
//! installer runs (passive) and the app exits by itself.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const FEED: Option<&str> = option_env!("TREEHOUSE_UPDATE_URL");

type CmdResult<T> = Result<T, String>;

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Update>>,
}

#[derive(Serialize)]
pub struct UpdateStatus {
    enabled: bool,
    current: String,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

fn feed() -> Option<&'static str> {
    FEED.filter(|f| !f.is_empty())
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    UpdateStatus {
        enabled: feed().is_some(),
        current: app.package_info().version.to_string(),
    }
}

/// Ask the feed for a newer version. `None` when Treehouse is up to date.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    st: State<'_, UpdateState>,
) -> CmdResult<Option<UpdateInfo>> {
    let feed = feed().ok_or("Updates are off in this build.")?;
    let url = feed
        .parse()
        .map_err(|e| format!("Bad update feed {feed}: {e}"))?;
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *st.pending.lock().map_err(|e| e.to_string())? = update;
    Ok(info)
}

/// Download, verify (minisign) and install the update found by `update_check`, then restart.
#[tauri::command]
pub async fn update_install(app: AppHandle, st: State<'_, UpdateState>) -> CmdResult<()> {
    let update = st
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("No update to install. Check for updates first.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
