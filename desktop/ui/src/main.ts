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
