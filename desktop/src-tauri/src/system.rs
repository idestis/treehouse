//! Small bridges to the operating system.

/// Open the OS privacy page for the microphone, camera or screen recording,
/// so a denied permission can be fixed in one click.
#[tauri::command]
pub fn open_privacy_settings(kind: String) -> Result<(), String> {
    let device = match kind.as_str() {
        "microphone" | "camera" | "screen" => kind.as_str(),
        _ => return Err("Unknown setting.".into()),
    };
    #[cfg(target_os = "macos")]
    let result = {
        let pane = match device {
            "camera" => "Privacy_Camera",
            "screen" => "Privacy_ScreenCapture",
            _ => "Privacy_Microphone",
        };
        std::process::Command::new("open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{pane}"
            ))
            .status()
    };
    #[cfg(target_os = "windows")]
    let result = {
        let page = match device {
            "camera" => "ms-settings:privacy-webcam",
            "microphone" => "ms-settings:privacy-microphone",
            // Windows has no screen-sharing permission; the share picker is the only gate.
            _ => return Err("Windows doesn’t block screen sharing. Try sharing again.".into()),
        };
        std::process::Command::new("explorer.exe")
            .arg(page)
            .status()
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result: std::io::Result<std::process::ExitStatus> = {
        let _ = device;
        Err(std::io::Error::other(
            "Open your system settings and allow Treehouse there.",
        ))
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// The person's preferred languages from the OS (BCP 47 tags, best first).
/// The web view can't be trusted for this: on macOS it only reports
/// languages the app bundle declares.
#[tauri::command]
pub fn system_languages() -> Vec<String> {
    sys_locale::get_locales().collect()
}
