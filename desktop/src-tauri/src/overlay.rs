//! The people overlay: a small always-on-top window that shows who is in your
//! voice call while you share your screen (say, a game in full screen).
//!
//! It is the same UI bundle opened at `index.html#overlay=<room id>`. Web
//! views can't hand media to each other, so the page makes its own hidden,
//! watch-only LiveKit connection. Its API calls go through the shared
//! `Client`, so the device token stays in Rust like everywhere else.
//!
//! The window is excluded from screen capture (`content_protected`) so your
//! share doesn't show it, never takes focus from the game when it opens, and
//! remembers where you put it on this computer.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, Window};

pub const LABEL: &str = "overlay";
const WIDTH: f64 = 260.0;
const HEIGHT: f64 = 440.0;
const MARGIN: f64 = 24.0;

/// Logical position and size of the window, saved when it closes.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn geometry_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("overlay.json"))
}

/// The saved place, if the screen it was on is still connected.
fn saved<R: Runtime>(app: &AppHandle<R>) -> Option<Geometry> {
    let g: Geometry = serde_json::from_slice(&std::fs::read(geometry_file(app)?).ok()?).ok()?;
    let usable = g.width >= 120.0 && g.height >= 100.0 && g.width < 4000.0 && g.height < 4000.0;
    let on_screen = app.available_monitors().ok()?.iter().any(|m| {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        // The title bar area (top-left) must be on this screen to drag it back.
        g.x + 40.0 >= pos.x
            && g.x + 40.0 <= pos.x + size.width
            && g.y >= pos.y
            && g.y + 20.0 <= pos.y + size.height
    });
    (usable && on_screen).then_some(g)
}

/// Top-right of the screen the main window is on.
fn default_place<R: Runtime>(app: &AppHandle<R>) -> Geometry {
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (x, y) = match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let area = m.work_area();
            let pos = area.position.to_logical::<f64>(scale);
            let size = area.size.to_logical::<f64>(scale);
            (pos.x + size.width - WIDTH - MARGIN, pos.y + MARGIN)
        }
        None => (MARGIN, MARGIN),
    };
    Geometry {
        x,
        y,
        width: WIDTH,
        height: HEIGHT,
    }
}

/// Save where the overlay is (called as it closes).
pub fn remember<R: Runtime>(window: &Window<R>) {
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let g = Geometry {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    };
    let Some(p) = geometry_file(window.app_handle()) else {
        return;
    };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(b) = serde_json::to_vec(&g) {
        let _ = std::fs::write(p, b);
    }
}

/// Open the overlay for a voice room. If it's already open, it just
/// switches rooms; it never takes focus. `title` is the window title in the
/// app's language (the UI translates it).
// Async: creating a window from a sync command can deadlock on Windows.
#[tauri::command]
pub async fn overlay_open(
    app: AppHandle,
    room_id: i64,
    title: Option<String>,
) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return app
            .emit_to(LABEL, "overlay-room", room_id)
            .map_err(|e| e.to_string());
    }
    let g = saved(&app).unwrap_or_else(|| default_place(&app));
    let url = WebviewUrl::App(format!("index.html#overlay={room_id}").into());
    WebviewWindowBuilder::new(&app, LABEL, url)
        .title(title.as_deref().unwrap_or("Treehouse: people"))
        .inner_size(g.width, g.height)
        .min_inner_size(200.0, 220.0)
        .position(g.x, g.y)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .decorations(false)
        // Rounded corners are drawn by the page; the window itself is clear.
        .transparent(true)
        .shadow(true)
        .resizable(true)
        // A double-click on the drag area would otherwise fill the screen.
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        // Leave out of screen sharing and recordings (macOS and Windows).
        .content_protected(true)
        // Don't pull focus from the game; a click on × still works first time.
        .focused(false)
        .accept_first_mouse(true)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(0x0E, 0x13, 0x22, 0xFF))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the overlay if it's open (its place is saved on the way out).
#[tauri::command]
pub async fn overlay_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_round_trips() {
        let g = Geometry {
            x: 1200.5,
            y: 40.0,
            width: 240.0,
            height: 400.0,
        };
        let s = serde_json::to_string(&g).unwrap();
        assert_eq!(serde_json::from_str::<Geometry>(&s).unwrap(), g);
    }
}
