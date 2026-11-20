mod client;
mod live;
mod tray;
mod update;

pub fn run() {
    tauri::Builder::default()
        // First, so a second launch just brings the running window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::UpdateState::default())
        .manage(client::Client::new())
        .manage(live::Live::default())
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
        ])
        .setup(|app| {
            tray::build(app.handle())?;
            Ok(())
        })
        // Closing the window keeps Treehouse in the tray (Quit is in its menu).
        .on_window_event(|window, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = window.hide();
            }
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
