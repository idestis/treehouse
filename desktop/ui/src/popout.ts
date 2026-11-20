// Main-window side of the "people on top" overlay (desktop app only).
// Opens it when you start sharing (if the setting is on), closes it when the
// share it was opened for stops, and always when you leave or the call ends.
// The window itself lives in overlay.ts and Rust's overlay.rs.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { call } from "./call";
import { prefs } from "./voice";

const inApp = "__TAURI_INTERNALS__" in window;

let open = false;
/** Opened because you started sharing (so it closes when sharing stops). */
let byShare = false;
let sharing = false;
const listeners = new Set<() => void>();

function changed() {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error(err); }
  }
}

function show(roomId: number, auto: boolean) {
  open = true;
  byShare = auto;
  changed();
  void invoke("overlay_open", { roomId }).catch(() => { open = false; byShare = false; changed(); });
}

function hide() {
  if (!open) return;
  open = false;
  byShare = false;
  changed();
  void invoke("overlay_close").catch(() => {});
}

/** How "Leave" from the overlay hangs up (the home screen sets this so leave sounds and views stay right). */
let leaveHandler: () => void = () => void call.leave();

/** Tell the overlay what the call looks like (for its buttons and your own tile). */
function sendState() {
  if (!open) return;
  void emitTo("overlay", "overlay-state", { muted: call.muted, deafened: call.deafened, screen: call.screen, camera: call.camera }).catch(() => {});
}

export const popout = {
  setLeaveHandler(fn: () => void) { leaveHandler = fn; },
  /** Only the desktop app can float a window above other apps. */
  available: inApp,
  get open(): boolean { return open; },
  toggle() {
    if (open) hide();
    else if (call.roomId !== null && call.status !== "idle") show(call.roomId, false);
  },
  on(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

if (inApp) {
  // Closed from its own × (or by the system).
  void listen("overlay-closed", () => {
    if (!open) return;
    open = false;
    byShare = false;
    changed();
  });
  // The overlay's own buttons.
  void listen<string>("overlay-command", (e) => {
    if (call.status === "idle") return;
    if (e.payload === "mute") void call.setMuted(!call.muted);
    else if (e.payload === "deafen") void call.setDeafened(!call.deafened);
    else if (e.payload === "stop-share") void call.setScreenShare(false);
    else if (e.payload === "leave") leaveHandler();
  });
  void listen("overlay-ready", () => sendState());
  call.on((e) => {
    if (e.type !== "status" && e.type !== "local") return;
    sendState();
    if (call.status === "idle") { sharing = false; hide(); return; }
    if (call.screen === sharing) return;
    sharing = call.screen;
    if (sharing && !open && prefs.overlayWhileSharing && call.roomId !== null) show(call.roomId, true);
    else if (!sharing && byShare) hide();
  });
}
