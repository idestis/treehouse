import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./style.css";
import { start } from "./app";
import "./screens/auth";
import "./screens/home";
import "./screens/settings";
import { initUpdates } from "./updates";

const root = document.getElementById("app")!;

start(root, { name: "find" });
if ("__TAURI_INTERNALS__" in window) void initUpdates();
