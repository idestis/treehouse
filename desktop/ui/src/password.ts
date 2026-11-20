// Live password strength meter. The server judges (POST /api/password-check)
// with the same rule it enforces when the password is set; this only shows it.
import { api } from "./api";
import { codeText } from "./api/types";
import { h, mount } from "./dom";
import { t } from "./i18n";

export function strengthMeter(input: HTMLInputElement, context: () => { username?: string; display_name?: string }) {
  const bars = Array.from({ length: 4 }, () => h("span", { class: "pw-bar" }));
  const text = h("span", { class: "pw-text muted small" }, t("settings.password.hint"));
  const el = h("div", { class: "pw-meter", "aria-live": "polite" }, h("div", { class: "pw-bars" }, bars), text);
  let timer = 0;
  let seq = 0;

  const paint = (score: number, ok: boolean, message: string) => {
    const tone = ok ? "leaf" : score >= 2 ? "lantern" : "ember";
    bars.forEach((b, i) => (b.className = `pw-bar ${i < Math.max(1, score) ? tone : ""}`));
    text.className = `pw-text small ${ok ? "leaf" : "ember"}`;
    mount(text, message);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const pw = input.value;
    if (!pw) {
      bars.forEach((b) => (b.className = "pw-bar"));
      text.className = "pw-text muted small";
      mount(text, t("settings.password.hint"));
      return;
    }
    timer = window.setTimeout(async () => {
      const mine = ++seq;
      try {
        const r = await api.passwordCheck({ password: pw, ...context() });
        if (mine === seq && input.value === pw) paint(r.score, r.ok, r.code ? codeText(r.code, r.message, r.min === undefined ? undefined : { min: r.min }) : r.message);
      } catch { /* the meter is a hint; the real check happens on submit */ }
    }, 250);
  });
  return el;
}
