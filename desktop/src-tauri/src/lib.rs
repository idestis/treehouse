mod client;
mod live;
mod overlay;
mod system;
mod system_audio;
mod tray;
mod update;

use tauri::Emitter;

pub fn run() {
    tauri::Builder::default()
        // First, so a second launch just brings the running window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        // Push to talk works while a game has focus.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::UpdateState::default())
        .manage(client::Client::new())
        .manage(live::Live::default())
        .manage(system_audio::SystemAudio::default())
        .invoke_handler(tauri::generate_handler![
            update::update_status,
            update::update_check,
            update::update_install,
            client::server_probe,
            client::servers_list,
            client::api_request,
            client::session_clear,
            live::events_start,
            live::events_stop,
            tray::set_unread,
            tray::tray_labels,
            system::system_languages,
            system::open_privacy_settings,
            overlay::overlay_open,
            overlay::overlay_close,
            system_audio::system_audio_start,
            system_audio::system_audio_stop,
        ])
        .setup(|app| {
            tray::build(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, ev| match ev {
            // Closing the overlay remembers where it was and tells the main window.
            tauri::WindowEvent::CloseRequested { .. } if window.label() == overlay::LABEL => {
                overlay::remember(window);
            }
            tauri::WindowEvent::Destroyed if window.label() == overlay::LABEL => {
                let _ = window.emit_to("main", "overlay-closed", ());
            }
            // Closing the main window keeps Treehouse in the tray (Quit is in its menu).
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Treehouse failed to start: {e}");
            std::process::exit(1);
        })
        .run(|app, ev| {
            // Clicking the Dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = ev {
                tray::show(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, ev);
        });
}
