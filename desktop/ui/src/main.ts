import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./style.css";

// One bundle, two windows: `index.html#overlay=<room id>` is the small
// "people on top" window (desktop app only); everything else is the app.
const overlayRoom = /^#overlay=(\d+)$/.exec(location.hash);
if (overlayRoom && "__TAURI_INTERNALS__" in window) {
  void import("./overlay").then((m) => m.startOverlay(document.getElementById("app")!, Number(overlayRoom[1])));
} else {
  void import("./shell");
}
