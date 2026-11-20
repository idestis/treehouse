// Voice hotkeys: a per-computer preference (not account data). Matching uses
// KeyboardEvent.code, so a binding survives keyboard layout changes.
import { type Key, t } from "./i18n";

export type Action = "mute" | "deafen" | "ptt";
export interface Combo { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
export type Bindings = Record<Action, Combo | null>;

/** [action, label]; the label is read in the current language each time. */
const action = (a: Action, key: Key): [Action, string] =>
  Object.defineProperty([a, ""], 1, { get: () => t(key), enumerable: true }) as [Action, string];

export const ACTIONS: [Action, string][] = [action("mute", "hotkeys.mute"), action("deafen", "hotkeys.deafen"), action("ptt", "hotkeys.ptt")];

const KEY = "treehouse.hotkeys";
const isMac = navigator.userAgent.includes("Mac");
const combo = (code: string, mods: Partial<Combo> = {}): Combo => ({ code, ctrl: false, alt: false, shift: false, meta: false, ...mods });

export const DEFAULTS: Bindings = {
  mute: combo("KeyM", { ctrl: true }),
  deafen: combo("KeyD", { ctrl: true }),
  ptt: null,
};

export function load(): Bindings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved === "object") return { ...DEFAULTS, ...saved };
  } catch { /* fall back to defaults */ }
  return { ...DEFAULTS };
}

export function save(b: Bindings) {
  try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* preference only */ }
}

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** The combo a key press makes, or null for a bare modifier. */
export function fromEvent(e: KeyboardEvent): Combo | null {
  if (MODIFIER_CODES.test(e.code) || !e.code) return null;
  return { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

/** Tauri global-shortcut accelerator, e.g. "Alt+Shift+KeyT" (codes are layout-independent). */
export function toAccelerator(c: Combo): string {
  return [c.ctrl && "Control", c.alt && "Alt", c.shift && "Shift", c.meta && "Super", c.code].filter(Boolean).join("+");
}

/** Can this computer give us the combo system-wide? (Tauri only; false when another app holds it.) */
export async function globalAvailable(c: Combo): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return true;
  const gs = await import("@tauri-apps/plugin-global-shortcut");
  const acc = toAccelerator(c);
  try {
    if (await gs.isRegistered(acc)) return true; // ours already
    await gs.register(acc, () => {});
    await gs.unregister(acc);
    return true;
  } catch { return false; }
}

export function matches(e: KeyboardEvent, c: Combo | null): boolean {
  return !!c && e.code === c.code && e.ctrlKey === c.ctrl && e.altKey === c.alt && e.shiftKey === c.shift && e.metaKey === c.meta;
}

const same = (a: Combo, b: Combo) => a.code === b.code && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;

function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[code] ?? code;
  return ({ Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
    Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: "Space", Escape: "Esc", Enter: "Enter", Tab: "Tab", Backspace: "Backspace" } as Record<string, string>)[code] ?? code;
}

export function format(c: Combo | null): string {
  if (!c) return t("hotkeys.notSet");
  const parts: string[] = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push(isMac ? "Option" : "Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push(isMac ? "Cmd" : "Win");
  parts.push(keyName(c.code));
  return parts.join(" + ");
}

/** A hotkey needs a modifier so it can't fire while typing (function keys excepted). */
export function problem(c: Combo): string | null {
  const fKey = /^F\d{1,2}$/.test(c.code);
  if (!fKey && !c.ctrl && !c.alt && !c.meta) return t(isMac ? "hotkeys.needModifierMac" : "hotkeys.needModifierWin");
  return null;
}

type Rule = { m: Partial<Combo>; codes: string[] | "*"; why: Key };

// Shortcuts the system or text fields already use. Not exhaustive: the common ones a player would hit.
const MAC: Rule[] = [
  { m: { meta: true }, codes: ["KeyQ"], why: "hotkeys.why.quits" },
  { m: { meta: true }, codes: ["KeyW"], why: "hotkeys.why.closesWindow" },
  { m: { meta: true }, codes: ["KeyH"], why: "hotkeys.why.hides" },
  { m: { meta: true }, codes: ["KeyM"], why: "hotkeys.why.minimizes" },
  { m: { meta: true }, codes: ["Tab"], why: "hotkeys.why.switchesApps" },
  { m: { meta: true }, codes: ["Space"], why: "hotkeys.why.spotlight" },
  { m: { meta: true }, codes: ["Backquote"], why: "hotkeys.why.switchesWindows" },
  { m: { meta: true }, codes: ["Comma"], why: "hotkeys.why.settings" },
  { m: { meta: true }, codes: ["KeyC", "KeyV", "KeyX", "KeyZ", "KeyA"], why: "hotkeys.why.macClipboard" },
  { m: { meta: true, shift: true }, codes: ["Digit3", "Digit4", "Digit5"], why: "hotkeys.why.screenshot" },
  { m: { meta: true, ctrl: true }, codes: ["KeyQ"], why: "hotkeys.why.lock" },
  { m: { meta: true, ctrl: true }, codes: ["KeyF"], why: "hotkeys.why.fullScreen" },
  { m: { meta: true, ctrl: true }, codes: ["Space"], why: "hotkeys.why.emoji" },
  { m: { ctrl: true }, codes: ["Space"], why: "hotkeys.why.inputLanguage" },
  { m: { ctrl: true }, codes: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], why: "hotkeys.why.desktops" },
  // Text fields (Emacs-style editing keys in every macOS text box, including the message box).
  { m: { ctrl: true }, codes: ["KeyA", "KeyE"], why: "hotkeys.why.lineEnds" },
  { m: { ctrl: true }, codes: ["KeyD"], why: "hotkeys.why.deleteNext" },
  { m: { ctrl: true }, codes: ["KeyH"], why: "hotkeys.why.deletePrev" },
  { m: { ctrl: true }, codes: ["KeyK"], why: "hotkeys.why.deleteToEnd" },
  { m: { ctrl: true }, codes: ["KeyF", "KeyB", "KeyN", "KeyP"], why: "hotkeys.why.moveCursor" },
];

const WIN: Rule[] = [
  { m: { alt: true }, codes: ["F4"], why: "hotkeys.why.closesWindow" },
  { m: { alt: true }, codes: ["Tab"], why: "hotkeys.why.switchesApps" },
  { m: { ctrl: true }, codes: ["Escape"], why: "hotkeys.why.startMenu" },
  { m: { ctrl: true, shift: true }, codes: ["Escape"], why: "hotkeys.why.taskManager" },
  { m: { meta: true }, codes: "*", why: "hotkeys.why.winReserved" },
  { m: { ctrl: true }, codes: ["KeyC", "KeyV", "KeyX", "KeyZ", "KeyY", "KeyA"], why: "hotkeys.why.winClipboard" },
  { m: { ctrl: true }, codes: ["KeyW"], why: "hotkeys.why.closesMany" },
  { m: { alt: true, ctrl: true }, codes: ["Delete"], why: "hotkeys.why.security" },
];

function modsEqual(c: Combo, m: Partial<Combo>) {
  return c.ctrl === !!m.ctrl && c.alt === !!m.alt && c.shift === !!m.shift && c.meta === !!m.meta;
}

/** Why this combo may not work well: system or text-field shortcuts, or another Treehouse action. */
export function conflicts(c: Combo, action: Action, all: Bindings): string[] {
  const out: string[] = [];
  for (const [other, label] of ACTIONS) {
    const b = all[other];
    if (other !== action && b && same(b, c)) out.push(t("hotkeys.alreadyUsed", { action: label }));
  }
  for (const r of isMac ? MAC : WIN) {
    const codeHit = r.codes === "*" || r.codes.includes(c.code);
    const modHit = r.codes === "*" ? c.meta : modsEqual(c, r.m);
    if (codeHit && modHit) out.push(t("hotkeys.system", { os: isMac ? "macOS" : "Windows", combo: format(c), why: t(r.why) }));
  }
  return out;
}
