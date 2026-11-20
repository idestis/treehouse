fn main() {
    // The update feed is baked in with option_env! (see src/update.rs).
    println!("cargo:rerun-if-env-changed=TREEHOUSE_UPDATE_URL");
    tauri_build::build()
}
