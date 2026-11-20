import { defineConfig } from "vite";

// Tauri expects a fixed dev port and serves the built files from desktop/dist.
// The /api proxy is only for running the UI in a plain browser against a
// local server (task server:dev); the app itself talks to servers from Rust.
export default defineConfig({
  root: "ui",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: { "/api": { target: process.env.TREEHOUSE_DEV_SERVER ?? "http://127.0.0.1:8090", ws: true } },
  },
  // safari16: WKWebView on macOS 13; WebView2 on Windows is newer.
  build: { outDir: "../dist", emptyOutDir: true, target: "safari16", sourcemap: false },
});
