// Tiny DOM helpers: h("div", { class: "x", onclick }, child, …).
import { inkOn, paint } from "./colors";
import { relative, t } from "./i18n";

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value") (el as HTMLInputElement).value = String(v);
    else if (k === "checked") (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

/** Replace an element's children. */
export function mount(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

/** Inline SVG icon from `icons`. */
export function icon(name: keyof typeof icons, size = 20, cls = ""): SVGSVGElement {
  const t = document.createElement("template");
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${cls}">${icons[name]}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}

export const icons = {
  chevron: '<path d="M9 6l6 6-6 6"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
  speaker: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/>',
  micOff: '<path d="M2 2l20 20M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6"/><path d="M17 16.9A7 7 0 0 1 5 11v-1M19 10v1a7 7 0 0 1-.1 1.2M12 18v4"/>',
  headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  headphonesOff: '<path d="M2 2l20 20"/><path d="M3 18v-6a9 9 0 0 1 14.3-7.3M21 12v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  video: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  videoOff: '<path d="M2 2l20 20M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5 0h4a2 2 0 0 1 2 2v3.3l1 1L23 7v10"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M12 13V7M9 10l3-3 3 3"/>',
  monitorOff: '<path d="M2 2l20 20"/><path d="M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 .6-1.4M8 3h12a2 2 0 0 1 2 2v10a2 2 0 0 1-.6 1.4"/><path d="M8 21h8M12 17v4"/>',
  popout: '<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/>',
  hangup: '<path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 4.2 2 2 0 0 1 5.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.4 2.1L8.9 9.9"/><path d="M22 2L2 22"/>',
  smilePlus: '<path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8 8.4 8.4 0 0 1 8.4-8.5h.5a8.5 8.5 0 0 1 8 8v.5z"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h.01M16 16h.01M12 12h.01M16 8h.01M8 16h.01"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  more: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  volumeOff: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  reply: '<path d="M9 14L4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pipette: '<path d="M2 22l1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
} as const;

export function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export function avatar(name: string, color: string, size = 28, cls = ""): HTMLElement {
  return h("span", { class: `avatar ${cls}`, style: { width: `${size}px`, height: `${size}px`, background: paint(color), color: inkOn(color), fontSize: `${Math.round(size * 0.42)}px` } }, initial(name));
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return t("time.justNow");
  if (s < 3600) return relative(-Math.round(s / 60), "minute");
  if (s < 86400 * 1.5) return relative(-Math.round(s / 3600), "hour");
  return relative(-Math.round(s / 86400), "day");
}

let toastTimer = 0;
/** Short message at the bottom of the window. */
export function toast(text: string, kind: "info" | "error" = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = h("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.appendChild(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), 3500);
}
