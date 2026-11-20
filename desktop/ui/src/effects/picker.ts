// Tiles for the call bar's Effects menu: a Background group (blur or not)
// and a Masks group with search.
import { h, icon, type icons } from "../dom";
import { t, type Key } from "../i18n";
import type { Mask } from "./support";

export type Tile = "noBlur" | "blur" | "noMask" | Mask;

const TILES: Record<Tile, { emoji?: string; icon?: keyof typeof icons; label: Key }> = {
  noBlur: { icon: "ban", label: "effects.noBlur" },
  blur: { icon: "blurDots", label: "effects.blur" },
  noMask: { icon: "ban", label: "effects.noMask" },
  skull: { emoji: "💀", label: "effects.skull" },
  cat: { emoji: "🐱", label: "effects.cat" },
  shades: { emoji: "😎", label: "effects.shades" },
};

/** Extra words people might search for, in every language the app speaks. */
const KEYWORDS: Record<Mask, string> = {
  skull: "skull halloween day of the dead dia de muertos calavera catrina череп хелловін",
  cat: "cat kitty kitten ears whiskers animal gato gatito orejas кіт котик вушка тварина",
  shades: "sunglasses glasses shades cool gafas lentes окуляри",
};

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whether a mask matches what's typed in the search box (its name, or a keyword). */
export function maskMatches(mask: Mask, query: string): boolean {
  const q = fold(query.trim());
  return !q || fold(`${t(TILES[mask].label)} ${KEYWORDS[mask]}`).includes(q);
}

export function effectTile(id: Tile, on: boolean, pick: () => void): HTMLButtonElement {
  const { emoji, icon: ic, label } = TILES[id];
  return h("button", { class: `fx-tile ${on ? "on" : ""}`, type: "button", role: "radio", "aria-checked": String(on), onclick: pick },
    emoji ? h("span", { class: "fx-emoji", "aria-hidden": "true" }, emoji) : icon(ic ?? "ban", 26),
    h("span", { class: "fx-label" }, t(label)));
}
