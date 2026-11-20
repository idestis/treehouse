// In-theme dropdown (listbox) instead of the native <select> popup.
// Keyboard: Enter/Space/↓ opens, ↑/↓ move, Enter picks, Esc closes, typing jumps.
import { h, icon, mount } from "./dom";

export interface Option { value: string; label: string; hint?: string }

export interface Dropdown {
  el: HTMLElement;
  value: string;
  setOptions(options: Option[], value?: string): void;
  onChange?: (value: string) => void;
}

let openCount = 0;

export function dropdown(id: string, options: Option[], value = options[0]?.value ?? ""): Dropdown {
  let opts = options;
  let current = value;
  let active = 0;
  const label = h("span", { class: "dd-label" });
  const button = h("button", { id, class: "dd-button", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
    label, icon("chevron", 18, "dd-chevron"));
  const list = h("ul", { class: "dd-list", role: "listbox", tabindex: -1, hidden: true });
  const el = h("div", { class: "dd" }, button, list);

  const api: Dropdown = {
    el,
    get value() { return current; },
    set value(v: string) { current = v; paint(); },
    setOptions(next, v) {
      opts = next;
      if (v !== undefined) current = v;
      if (!opts.some((o) => o.value === current)) current = opts[0]?.value ?? "";
      paint();
    },
  };

  function paint() {
    label.textContent = opts.find((o) => o.value === current)?.label ?? "";
    if (!list.hidden) renderList();
  }

  function renderList() {
    mount(list, opts.map((o, i) => {
      const li = h("li", { id: `${id}-opt-${i}`, role: "option", class: `dd-opt ${i === active ? "active" : ""}`, "aria-selected": String(o.value === current) },
        h("span", { class: "dd-check" }, o.value === current ? "✓" : ""),
        h("span", { class: "grow" }, o.label, o.hint && h("span", { class: "muted small" }, ` ${o.hint}`)));
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
      li.addEventListener("mousemove", () => { if (active !== i) { active = i; renderList(); } });
      return li;
    }));
    list.setAttribute("aria-activedescendant", `${id}-opt-${active}`);
    list.querySelector(".dd-opt.active")?.scrollIntoView({ block: "nearest" });
  }

  function open() {
    if (!list.hidden) return;
    active = Math.max(0, opts.findIndex((o) => o.value === current));
    list.hidden = false;
    el.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    // Open upward when there isn't room below.
    const r = button.getBoundingClientRect();
    el.classList.toggle("up", innerHeight - r.bottom < 260 && r.top > innerHeight - r.bottom);
    renderList();
    openCount++;
    setTimeout(() => addEventListener("mousedown", outside, true));
  }

  function close(focus = true) {
    if (list.hidden) return;
    list.hidden = true;
    el.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
    removeEventListener("mousedown", outside, true);
    openCount--;
    if (focus) button.focus();
  }

  function pick(i: number) {
    const o = opts[i];
    close();
    if (!o || o.value === current) return;
    current = o.value;
    paint();
    api.onChange?.(current);
  }

  const outside = (e: MouseEvent) => { if (!el.contains(e.target as Node)) close(false); };

  button.addEventListener("click", () => (list.hidden ? open() : close()));
  button.addEventListener("keydown", (e) => {
    const isOpen = !list.hidden;
    if (!isOpen && ["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); open(); return; }
    if (!isOpen) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(opts.length - 1, active + 1); renderList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); renderList(); }
    else if (e.key === "Home") { e.preventDefault(); active = 0; renderList(); }
    else if (e.key === "End") { e.preventDefault(); active = opts.length - 1; renderList(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
    else if (e.key === "Tab") close(false);
    else if (e.key.length === 1) {
      const i = opts.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) { active = i; renderList(); }
    }
  });

  paint();
  return api;
}

/** True while any dropdown is open (so Esc closes it rather than the screen). */
export const dropdownOpen = () => openCount > 0;
