// A person's color is a hex ("#3F8EFC") or a named gradient ("rainbow").
// The server decides which values are allowed (session.rs check_color);
// this file only draws them.

interface Gradient { stops: string[]; /** One color for places a gradient can't go. */ solid: string }

export const GRADIENTS: Record<string, Gradient> = {
  rainbow: { stops: ["#FF5E5E", "#FFB347", "#FFE66D", "#63D69E", "#4FC3F7", "#8B7CF6", "#E86FD8"], solid: "#FFB347" },
  sunset: { stops: ["#FFB347", "#FF7A6B", "#E5487D", "#9B5CF6"], solid: "#FF7A6B" },
  ocean: { stops: ["#5EF2E0", "#3FA9FC", "#5A6BFF"], solid: "#3FA9FC" },
  aurora: { stops: ["#7CF29C", "#2EC4B6", "#6F7BF7", "#C86FF0"], solid: "#2EC4B6" },
};

const gradientOf = (color: string): Gradient | undefined => GRADIENTS[color];

export const isGradient = (color: string): boolean => color in GRADIENTS;

/** A single color: the hex itself, or the gradient's middle tone. */
export function solid(color: string): string {
  return gradientOf(color)?.solid ?? color;
}

/** CSS `background` for avatars and swatches. */
export function paint(color: string, angle = 135): string {
  const g = gradientOf(color);
  return g ? `linear-gradient(${angle}deg, ${g.stops.join(", ")})` : color;
}

/** CSS `background` for a tile: the color mixed into `base` at `pct`%, stop by stop for gradients. */
export function tint(color: string, pct: number, base: string): string {
  const mix = (c: string) => `color-mix(in srgb, ${c} ${pct}%, ${base})`;
  const g = gradientOf(color);
  return g ? `linear-gradient(135deg, ${g.stops.map(mix).join(", ")})` : mix(color);
}

/** Make `el` draw its text in `color` (gradient text for gradients). */
export function inkText<T extends HTMLElement>(el: T, color: string): T {
  if (isGradient(color)) {
    el.classList.add("grad-text");
    el.style.backgroundImage = paint(color, 90);
  } else {
    el.style.color = color;
  }
  return el;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Initials color on top of `color`: white, or night on light colors. */
export function inkOn(color: string): string {
  const c = solid(color);
  if (!/^#[0-9a-f]{6}$/i.test(c)) return "#fff";
  // Pick whichever of white and night contrasts more.
  const l = luminance(c);
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / (luminance("#0E1322") + 0.05)) ? "#fff" : "#0E1322";
}

/**
 * True when a custom color is too dark for names on the night background.
 * Only for an early hint in the picker; the server makes the real decision.
 */
export function looksTooDark(hex: string): boolean {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  return (luminance(hex) + 0.05) / (luminance("#0E1322") + 0.05) < 3;
}
