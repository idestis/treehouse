// The main window: screens, tray menu commands and update checks.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { go, session, start } from "./app";
import { toast } from "./dom";
import { onLang, t } from "./i18n";
import "./screens/auth";
import "./screens/home";
import "./screens/settings";
import { checkForUpdates, initUpdates } from "./updates";

const root = document.getElementById("app")!;

// It's an app, not a web page: no browser context menu (Reload, Look Up, Inspect…)
// except in text fields, where Cut / Copy / Paste and spelling are useful.
// Selected message text still copies with Cmd/Ctrl+C.
addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (!t?.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
});
// No reloading the window (it would drop your session and any call).
addEventListener("keydown", (e) => {
  const reload = e.key === "F5" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r");
  if (reload) e.preventDefault();
});

start(root, { name: "find" });
if ("__TAURI_INTERNALS__" in window) {
  void initUpdates();
  // The tray menu is native; send it labels in the current language.
  onLang(() => {
    const labels = { open: t("tray.open"), settings: t("tray.settings"), updates: t("tray.updates"), quit: t("tray.quit") };
    void invoke("tray_labels", { labels }).catch(() => {});
  });
  // Tray menu commands.
  void listen<string>("menu-command", (e) => {
    if (e.payload === "settings") {
      if (session.me && !session.me.mfa_setup_needed) go({ name: "settings" });
      else toast(t("shell.signInFirst"));
    } else if (e.payload === "check-updates") {
      void checkForUpdates();
    }
  });
}
