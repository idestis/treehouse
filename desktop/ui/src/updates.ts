// Self-update: quiet check shortly after launch and every few hours.
// The server-side Rust commands do the checking; release builds only.
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

interface UpdateStatus { enabled: boolean; current: string }
interface UpdateInfo { version: string; current: string; notes: string | null }

const EVERY_MS = 6 * 60 * 60 * 1000;
let busy = false;

export async function initUpdates(): Promise<UpdateStatus | null> {
  const st = await invoke<UpdateStatus>("update_status").catch(() => null);
  if (st?.enabled) {
    setTimeout(() => void check(), 10_000);
    setInterval(() => void check(), EVERY_MS);
  }
  return st;
}

async function check() {
  if (busy) return;
  busy = true;
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    if (!info) return;
    const ok = await ask(
      `Treehouse ${info.version} is out (you have ${info.current}). Treehouse restarts to finish.`,
      { title: "Update Treehouse", kind: "info", okLabel: "Update and restart", cancelLabel: "Later" },
    );
    if (ok) await invoke("update_install");
  } catch (e) {
    console.warn("update check failed", e);
  } finally {
    busy = false;
  }
}
