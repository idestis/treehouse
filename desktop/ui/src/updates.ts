// Self-update: quiet check shortly after launch and every few hours, plus
// "Check for Updates…" in the tray menu. Rust does the checking (release builds only).
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "./dom";
import { t } from "./i18n";

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
  if (!st?.enabled) { toast(t("updates.off")); return; }
  toast(t("updates.checking"));
  await check(true, st.current);
}

async function check(manual: boolean, current?: string) {
  if (busy) return;
  busy = true;
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    if (!info) {
      if (manual) toast(current ? t("updates.upToDate", { version: current }) : t("updates.upToDateBare"));
      return;
    }
    const ok = await ask(
      t("updates.available", { version: info.version, current: info.current }),
      { title: t("updates.title"), kind: "info", okLabel: t("updates.install"), cancelLabel: t("updates.later") },
    );
    if (ok) await invoke("update_install");
  } catch (e) {
    // The Rust side's reason is English and technical: log it, show a plain line.
    console.warn("update check failed", e);
    if (manual) toast(t("updates.failed"), "error");
  } finally {
    busy = false;
  }
}
