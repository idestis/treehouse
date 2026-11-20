import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/** MediaPipe's runtime for camera effects, served from the app itself (never from a CDN). */
const MEDIAPIPE_FILES = ["vision_wasm_internal.js", "vision_wasm_internal.wasm"];
const MEDIAPIPE_DIR = fileURLToPath(new URL("./node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url));

function mediapipeRuntime(): Plugin {
  return {
    name: "treehouse-mediapipe-runtime",
    configureServer(server) {
      server.middlewares.use("/mediapipe", (req, res, next) => {
        const file = (req.url ?? "").replace(/^\//, "").split("?")[0];
        if (!MEDIAPIPE_FILES.includes(file)) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        createReadStream(MEDIAPIPE_DIR + file).pipe(res);
      });
    },
    generateBundle() {
      for (const file of MEDIAPIPE_FILES) {
        this.emitFile({ type: "asset", fileName: `mediapipe/${file}`, source: readFileSync(MEDIAPIPE_DIR + file) });
      }
    },
  };
}

// Tauri expects a fixed dev port and serves the built files from desktop/dist.
// The /api proxy is only for running the UI in a plain browser against a
// local server (task server:dev); the app itself talks to servers from Rust.
export default defineConfig({
  root: "ui",
  clearScreen: false,
  plugins: [mediapipeRuntime()],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: { "/api": { target: process.env.TREEHOUSE_DEV_SERVER ?? "http://127.0.0.1:8090", ws: true } },
  },
  // safari16: WKWebView on macOS 13; WebView2 on Windows is newer.
  build: { outDir: "../dist", emptyOutDir: true, target: "safari16", sourcemap: false },
});
