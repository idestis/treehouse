// Interface languages: English, Spanish and Ukrainian.
//
// Each area of the app has a pack in ./packs with `en`, `es` and `uk`
// objects. English is the source; the others are typed against it, so a
// missing key fails `tsc`. Placeholders look like `{name}`.
//
// The language is a per-computer preference: "system" (the default) follows
// the operating system and falls back to English.
import type { Plural } from "./types";
import * as auth from "./packs/auth";
import * as call from "./packs/call";
import * as common from "./packs/common";
import * as errors from "./packs/errors";
import * as home from "./packs/home";
import * as settings from "./packs/settings";

export type Lang = "en" | "es" | "uk";
export type LangSetting = Lang | "system";

/** Each language's name in that language, for the picker. */
export const LANG_NAMES: Record<Lang, string> = { en: "English", es: "Español", uk: "Українська" };

const EN = { ...common.en, ...errors.en, ...auth.en, ...home.en, ...settings.en, ...call.en };
type Dict = typeof EN;
type Params = Record<string, string | number>;

/** Keys whose value is a plain string (use `t`). */
export type Key = { [K in keyof Dict]: Dict[K] extends string ? K : never }[keyof Dict];
/** Keys with plural forms (use `tn`). */
export type PluralKey = Exclude<keyof Dict, Key>;

const PACKS: Record<Lang, Record<string, string | Plural>> = {
  en: EN,
  es: { ...common.es, ...errors.es, ...auth.es, ...home.es, ...settings.es, ...call.es },
  uk: { ...common.uk, ...errors.uk, ...auth.uk, ...home.uk, ...settings.uk, ...call.uk },
};

const STORE_KEY = "treehouse.language";
let lang: Lang = "en";
let systemLang: Lang = "en";
let plurals = new Intl.PluralRules("en");
let numbers = new Intl.NumberFormat("en");
const listeners = new Set<(l: Lang) => void>();

function fill(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Text for `key` in the current language, with `{placeholders}` filled in. */
export function t(key: Key, params?: Params): string {
  const v = PACKS[lang][key] ?? EN[key];
  return fill(typeof v === "string" ? v : String(EN[key]), params);
}

/** Plural text for `n`; `{n}` is the formatted number. */
export function tn(key: PluralKey, n: number, params?: Params): string {
  const v = (PACKS[lang][key] ?? EN[key]) as Plural;
  const form = (v as unknown as Record<string, string | undefined>)[plurals.select(n)] ?? v.other;
  return fill(form, { ...params, n: numbers.format(n) });
}

/** True when `key` exists (for codes that come from the server). */
export function has(key: string): key is Key {
  return typeof (EN as Record<string, unknown>)[key] === "string";
}

export const currentLang = (): Lang => lang;
export const detectedSystemLang = (): Lang => systemLang;

export function langSetting(): LangSetting {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === "en" || v === "es" || v === "uk") return v;
  } catch { /* preference only */ }
  return "system";
}

/** First supported language in a list of BCP 47 tags (uk-UA → uk, es-419 → es). */
export function pickLang(tags: readonly string[]): Lang {
  for (const tag of tags) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (base === "en" || base === "es" || base === "uk") return base;
  }
  return "en";
}

function apply() {
  const s = langSetting();
  lang = s === "system" ? systemLang : s;
  plurals = new Intl.PluralRules(lang);
  numbers = new Intl.NumberFormat(lang);
  document.documentElement.lang = lang;
  for (const f of listeners) f(lang);
}

/** Change the preference. Callers re-render their screen afterwards. */
export function setLangSetting(s: LangSetting) {
  try {
    if (s === "system") localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, s);
  } catch { /* preference only */ }
  apply();
}

/** Run `f` now and whenever the language changes. */
export function onLang(f: (l: Lang) => void): () => void {
  listeners.add(f);
  f(lang);
  return () => listeners.delete(f);
}

/**
 * Ask the OS which languages the person prefers. In the desktop app the
 * web view's `navigator.languages` can say English when the system is
 * Ukrainian (macOS limits it to the app bundle's localizations), so the
 * Rust side reads the system list directly.
 */
export async function initI18n() {
  let tags: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language];
  if ("__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const sys = await invoke<string[]>("system_languages");
      if (sys.length) tags = sys;
    } catch { /* older shell: keep the web view's list */ }
  }
  systemLang = pickLang(tags);
  apply();
}

/** "3 minutes ago", "yesterday" in the current language. */
export function relative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(value, unit);
}
