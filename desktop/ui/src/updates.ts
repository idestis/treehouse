// Self-update: quiet check shortly after launch and every few hours, plus
// "Check for Updates…" in the tray menu. Rust does the checking (release builds only).
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "./dom";

interface UpdateStatus { enabled: boolean; current: string }
interface UpdateInfo { version: string; current: string; notes: string | null }

const EVERY_MS = 6 * 60 * 60 * 1000;
let busy = false;

export async function initUpdates(): Promise<UpdateStatus | null> {
  const st = await invoke<UpdateStatus>("update_status").catch(() => null);
  if (st?.enabled) {
    setTimeout(() => void check(false), 10_000);
    setInterval(() => void check(false), EVERY_MS);
  }
  return st;
}

/** Tray menu: check now and say what happened. */
export async function checkForUpdates() {
  const st = await invoke<UpdateStatus>("update_status").catch(() => null);
  if (!st?.enabled) { toast("Updates are off in this build."); return; }
  toast("Checking for updates…");
  await check(true, st.current);
}

async function check(manual: boolean, current?: string) {
  if (busy) return;
  busy = true;
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    if (!info) {
      if (manual) toast(`You’re up to date (Treehouse ${current ?? ""}).`.replace(" )", ")"));
      return;
    }
    const ok = await ask(
      `Treehouse ${info.version} is out (you have ${info.current}). Treehouse restarts to finish.`,
      { title: "Update Treehouse", kind: "info", okLabel: "Update and restart", cancelLabel: "Later" },
    );
    if (ok) await invoke("update_install");
  } catch (e) {
    if (manual) toast(`Couldn’t check for updates: ${String(e)}`, "error");
    else console.warn("update check failed", e);
  } finally {
    busy = false;
  }
}
