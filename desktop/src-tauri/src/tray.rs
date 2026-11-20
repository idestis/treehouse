//! Tray icon (menu bar on macOS, notification area on Windows) with a
//! Telegram-style badge for unread mentions. The UI reports the count;
//! closing the window hides it here instead of quitting.

use tauri::{
    AppHandle, Manager, Runtime,
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const TRAY_ID: &str = "treehouse-tray";
const N: usize = 36; // 18 pt at 2x
const LANTERN: [u8; 3] = [0xFF, 0xB3, 0x47];
const BADGE: [u8; 3] = [0xE5, 0x48, 0x4D];

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "tray.open", "Open Treehouse", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "tray.quit", "Quit Treehouse", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(0))
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Treehouse")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "tray.open" => show(app),
            "tray.quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Unread mentions, from the UI. 0 clears every badge.
#[tauri::command]
pub fn set_unread(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(icon(count)));
        // Template images are tinted by macOS, so the coloured badge needs a plain image.
        let _ = tray.set_icon_as_template(cfg!(target_os = "macos") && count == 0);
        let tip = match count {
            0 => "Treehouse".to_string(),
            1 => "Treehouse: 1 mention".to_string(),
            n => format!("Treehouse: {n} mentions"),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let _ = w.set_badge_count((count > 0).then_some(i64::from(count)));
        #[cfg(target_os = "windows")]
        let _ = w.set_overlay_icon((count > 0).then(|| badge_only(count)));
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        let _ = w;
    }
}

// ---------- drawing ----------

struct Canvas {
    px: Vec<u8>,
    n: usize,
}

impl Canvas {
    fn new(n: usize) -> Self {
        Self {
            px: vec![0; n * n * 4],
            n,
        }
    }

    /// Paint `rgb` with coverage `a` (0..1) over what's there.
    fn blend(&mut self, x: usize, y: usize, rgb: [u8; 3], a: f32) {
        if a <= 0.0 || x >= self.n || y >= self.n {
            return;
        }
        let i = (y * self.n + x) * 4;
        let a = a.min(1.0);
        let old_a = self.px[i + 3] as f32 / 255.0;
        let out_a = a + old_a * (1.0 - a);
        for (dst, src) in self.px[i..i + 3].iter_mut().zip(rgb) {
            let old = *dst as f32 * old_a;
            *dst = ((src as f32 * a + old * (1.0 - a)) / out_a.max(1e-6)) as u8;
        }
        self.px[i + 3] = (out_a * 255.0) as u8;
    }

    /// Anti-aliased round-capped line (a capsule), for the mark's strokes.
    fn capsule(&mut self, (ax, ay): (f32, f32), (bx, by): (f32, f32), r: f32, rgb: [u8; 3]) {
        for y in 0..self.n {
            for x in 0..self.n {
                let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                let (dx, dy) = (bx - ax, by - ay);
                let t = (((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy).max(1e-6))
                    .clamp(0.0, 1.0);
                let d = ((px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)).sqrt();
                self.blend(x, y, rgb, r + 0.5 - d);
            }
        }
    }

    /// Clear a capsule-shaped hole (a gap around the badge).
    fn erase_capsule(&mut self, a: (f32, f32), b: (f32, f32), r: f32) {
        let mut mask = Canvas::new(self.n);
        mask.capsule(a, b, r, [0, 0, 0]);
        for i in 0..self.n * self.n {
            let keep = 1.0 - mask.px[i * 4 + 3] as f32 / 255.0;
            self.px[i * 4 + 3] = (self.px[i * 4 + 3] as f32 * keep) as u8;
        }
    }

    fn rect(&mut self, x0: usize, y0: usize, w: usize, h: usize, rgb: [u8; 3]) {
        for y in y0..y0 + h {
            for x in x0..x0 + w {
                self.blend(x, y, rgb, 1.0);
            }
        }
    }
}

/// The Treehouse mark: a roof with a chimney over five sound bars.
fn mark(c: &mut Canvas, rgb: [u8; 3]) {
    c.capsule((5.0, 16.0), (18.0, 6.0), 2.1, rgb);
    c.capsule((18.0, 6.0), (31.0, 16.0), 2.1, rgb);
    c.capsule((25.5, 6.5), (25.5, 10.5), 1.9, rgb);
    for (x, half) in [
        (10.0, 2.5),
        (14.0, 5.0),
        (18.0, 8.0),
        (22.0, 5.0),
        (26.0, 2.5),
    ] {
        c.capsule((x, 23.5 - half), (x, 23.5 + half), 1.6, rgb);
    }
}

/// 3×5 digits for the badge.
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];
const PLUS: [u8; 5] = [0b000, 0b010, 0b111, 0b010, 0b000];

/// Red bubble with the count (9+ above nine), bottom-right.
fn badge(c: &mut Canvas, count: u32, scale: usize) {
    let glyphs: Vec<[u8; 5]> = if count > 9 {
        vec![DIGITS[9], PLUS]
    } else {
        vec![DIGITS[count as usize]]
    };
    let (gw, gh, gap) = (3 * scale, 5 * scale, scale);
    let text_w = glyphs.len() * gw + (glyphs.len() - 1) * gap;
    let n = c.n as f32;
    let r = n * 0.27;
    let cy = n - r - 0.5;
    let half = (text_w as f32 / 2.0 - r * 0.45).max(0.0);
    let (x1, x0) = (n - r - 0.5, n - r - 0.5 - 2.0 * half);
    c.erase_capsule((x0, cy), (x1, cy), r + 1.8);
    c.capsule((x0, cy), (x1, cy), r, BADGE);
    let left = ((x0 + x1) / 2.0 - text_w as f32 / 2.0).round() as usize;
    let top = (cy - gh as f32 / 2.0).round() as usize;
    for (i, g) in glyphs.iter().enumerate() {
        let gx = left + i * (gw + gap);
        for (row, bits) in g.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    c.rect(
                        gx + col * scale,
                        top + row * scale,
                        scale,
                        scale,
                        [255, 255, 255],
                    );
                }
            }
        }
    }
}

fn icon(count: u32) -> Image<'static> {
    let mut c = Canvas::new(N);
    // macOS tints template images itself; elsewhere (and with a badge) use lantern.
    let plain = cfg!(target_os = "macos") && count == 0;
    mark(&mut c, if plain { [0, 0, 0] } else { LANTERN });
    if count > 0 {
        badge(&mut c, count, 2);
    }
    Image::new_owned(c.px, N as u32, N as u32)
}

#[cfg(target_os = "windows")]
fn badge_only(count: u32) -> Image<'static> {
    let mut c = Canvas::new(32);
    let mut b = Canvas::new(32);
    badge(&mut b, count, 3);
    // Move the bubble to fill the overlay square.
    c.px = b.px;
    Image::new_owned(c.px, 32, 32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_render() {
        for n in [0, 1, 7, 12] {
            let img = icon(n);
            assert_eq!(img.rgba().len(), N * N * 4);
            assert!(img.rgba().chunks(4).any(|p| p[3] > 0));
        }
    }
}
