import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { go, session, start } from "./app";
import { toast } from "./dom";
import "./screens/auth";
import "./screens/home";
import "./screens/settings";
import { checkForUpdates, initUpdates } from "./updates";

const root = document.getElementById("app")!;

// It's an app, not a web page: no browser context menu (Reload / Inspect Element)
// except in text fields, where Cut / Copy / Paste and spelling are useful.
addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  const editable = t?.closest("input, textarea, [contenteditable='true']");
  const selection = getSelection()?.toString();
  if (!editable && !selection) e.preventDefault();
});
// No reloading the window (it would drop your session and any call).
addEventListener("keydown", (e) => {
  const reload = e.key === "F5" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r");
  if (reload) e.preventDefault();
});

start(root, { name: "find" });
if ("__TAURI_INTERNALS__" in window) {
  void initUpdates();
  // Tray menu commands.
  void listen<string>("menu-command", (e) => {
    if (e.payload === "settings") {
      if (session.me && !session.me.mfa_setup_needed) go({ name: "settings" });
      else toast("Sign in first, then open settings.");
    } else if (e.payload === "check-updates") {
      void checkForUpdates();
    }
  });
}
