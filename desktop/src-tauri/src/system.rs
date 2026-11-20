//! Small bridges to the operating system.

/// Open the OS privacy page for the microphone or camera, so a denied
/// permission can be fixed in one click.
#[tauri::command]
pub fn open_privacy_settings(kind: String) -> Result<(), String> {
    let device = match kind.as_str() {
        "microphone" | "camera" => kind.as_str(),
        _ => return Err("Unknown setting.".into()),
    };
    #[cfg(target_os = "macos")]
    let result = {
        let pane = if device == "camera" {
            "Privacy_Camera"
        } else {
            "Privacy_Microphone"
        };
        std::process::Command::new("open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{pane}"
            ))
            .status()
    };
    #[cfg(target_os = "windows")]
    let result = {
        let page = if device == "camera" {
            "ms-settings:privacy-webcam"
        } else {
            "ms-settings:privacy-microphone"
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
