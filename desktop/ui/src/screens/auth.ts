// Find your treehouse, sign in, two-step code, join with an invite.
import { api } from "../api";
import { errorText } from "../api/types";
import { afterSignIn, go, register, session } from "../app";
import { GRADIENTS, inkOn, looksTooDark, paint, tint } from "../colors";
import { h, icon, initial, mount, toast } from "../dom";
import { strengthMeter } from "../password";
import { type Key, t } from "../i18n";

function logo() {
  return h("div", { class: "brand" }, h("img", { src: "/logo.png", alt: "", width: 36, height: 36 }), "treehouse");
}

function serverBadge(name: string, size = 40) {
  return h("span", { class: "server-badge", style: { width: `${size}px`, height: `${size}px` } }, initial(name));
}

function field(label: string, input: HTMLInputElement) {
  input.id ||= `f-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return h("div", { class: "field" }, h("label", { for: input.id }, label), input);
}

function errorLine() {
  return h("p", { class: "form-error", role: "alert", hidden: true });
}

function showError(el: HTMLElement, e: unknown) {
  el.textContent = errorText(e);
  el.hidden = false;
}

/** Run an async submit with the button disabled. */
async function busy(btn: HTMLButtonElement, work: () => Promise<void>) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await work();
  } finally {
    btn.disabled = false;
  }
}

async function enter() {
  afterSignIn(await api.me());
}

// ─── Find your treehouse ───────────────────────────────────────────

const STARS: [number, number, number, number][] = [
  [27.14, 12.52, 0, 3.2], [54.21, 10.31, 1.1, 4.4], [20.1, 20.26, 2.2, 3.8], [76.73, 18.78, 0.6, 5],
  [81.7, 24.95, 1.8, 4.1], [17.75, 31.95, 2.9, 3.5], [70.37, 47.79, 0.3, 4.8], [78.45, 54.24, 3.4, 4.2],
  [68.37, 62.43, 2.0, 5.4], [26.66, 72.1, 1.4, 3.9],
];
const BULBS: [number, number][] = [[30.66, 57.18], [35.36, 57.27], [40.4, 58.47], [45.3, 58.75], [49.86, 57.64]];

function scene() {
  const pos = (l: number, t: number) => ({ left: `${l}%`, top: `${t}%` });
  return h("div", { class: "scene" },
    h("img", { src: "/left-side-pic.jpg", alt: t("auth.sceneAlt") }),
    h("span", { class: "tw tw-window-electric", style: { ...pos(33.8, 43.3), width: "6.1%", height: "7.9%" } }),
    h("span", { class: "tw tw-window-candle", style: { ...pos(41.7, 42.8), width: "8.5%", height: "9.6%" } }),
    h("span", { class: "tw tw-ring", style: pos(59.25, 39.8) }),
    h("span", { class: "tw tw-ring", style: { ...pos(59.25, 39.8), animationDelay: "1.4s" } }),
    STARS.map(([l, t, d, dur]) => h("span", { class: "tw tw-star", style: { ...pos(l, t), animationDelay: `${d}s`, animationDuration: `${dur}s` } })),
    BULBS.map(([l, t], i) => h("span", { class: "tw tw-bulb", style: { ...pos(l, t), animationDelay: `${i * 0.5}s` } })),
  );
}

register("find", (root) => {
  const input = h("input", { id: "server", placeholder: "owls.example.net", spellcheck: "false", autocomplete: "url", autofocus: true });
  const err = errorLine();
  const btn = h("button", { class: "btn primary", type: "submit" }, t("common.continue"));
  const known = h("div", { class: "known" });

  const open = (address: string) => busy(btn, async () => {
    err.hidden = true;
    try {
      const r = await api.probe(address);
      session.server = { address: r.address, name: r.name };
      session.me = null;
      if (r.signed_in) {
        try { return await enter(); } catch { /* token expired: sign in again */ }
      }
      go({ name: "signin" });
    } catch (e) {
      showError(err, e);
    }
  });

  api.servers().then((list) => {
    if (!list.length) return;
    mount(known,
      h("p", { class: "muted small" }, t("auth.find.known")),
      list.map((s) => h("button", { class: "server-row", type: "button", onclick: () => open(s.address) },
        serverBadge(s.name),
        h("span", { class: "grow col" }, h("strong", null, s.name), h("span", { class: "muted small" }, s.address)),
        icon("chevron", 20, "muted"),
      )),
    );
  }).catch(() => {});

  mount(root,
    h("div", { class: "find" },
      h("div", { class: "find-art" }, scene()),
      h("div", { class: "find-form" },
        h("div", { class: "stack-28" },
          logo(),
          h("div", { class: "stack-10" },
            h("h1", { class: "display" }, t("auth.find.title")),
            h("p", { class: "lead" }, t("auth.find.lead")),
          ),
          h("form", { class: "stack-14", onsubmit: (e: Event) => { e.preventDefault(); void open(input.value); } },
            h("label", { for: "server", class: "label" }, t("auth.find.address")), input, err, btn),
          known,
        ),
      ),
    ),
  );
});

// ─── Sign in ───────────────────────────────────────────────────────

function serverChip() {
  const s = session.server!;
  return h("div", { class: "server-chip" },
    serverBadge(s.name, 44),
    h("span", { class: "grow col" }, h("strong", null, s.name), h("span", { class: "muted small" }, s.address)),
    h("button", { class: "link", type: "button", onclick: () => go({ name: "find" }) }, t("auth.signin.change")),
  );
}

register("signin", (root) => {
  if (!session.server) return go({ name: "find" });
  const user = h("input", { id: "user", autocomplete: "username", spellcheck: "false", autofocus: true });
  const pass = h("input", { id: "pass", type: "password", autocomplete: "current-password" });
  const remember = h("input", { type: "checkbox", checked: true });
  const err = errorLine();
  const btn = h("button", { class: "btn primary", type: "submit" }, t("auth.signin.submit"));

  const submit = (e: Event) => {
    e.preventDefault();
    void busy(btn, async () => {
      err.hidden = true;
      try {
        const r = await api.login(user.value, pass.value, remember.checked);
        if (r.status === "mfa_required") return go({ name: "twostep", mfa_token: r.mfa_token });
        afterSignIn(r.me);
      } catch (e) {
        showError(err, e);
        pass.select();
      }
    });
  };

  mount(root,
    h("div", { class: "card-page" },
      h("div", { class: "narrow stack-28" },
        serverChip(),
        h("div", { class: "stack-8" },
          h("h1", { class: "display sm" }, t("auth.signin.title")),
          h("p", { class: "lead" }, t("auth.signin.lead")),
        ),
        h("form", { class: "stack-16", onsubmit: submit },
          field(t("auth.username"), user),
          field(t("auth.password"), pass),
          h("label", { class: "check" }, remember, t("auth.signin.remember")),
          err,
          btn,
        ),
        h("div", { class: "divider" }, h("span"), t("auth.signin.newHere"), h("span")),
        h("button", { class: "btn ghost", type: "button", onclick: () => go({ name: "join" }) }, t("auth.signin.haveInvite")),
      ),
    ),
  );
});

// ─── Two-step code ─────────────────────────────────────────────────

register("twostep", (root, screen) => {
  if (screen.name !== "twostep" || !session.server) return go({ name: "find" });
  const mfa = screen.mfa_token;
  let backup = false;
  const err = errorLine();
  const btn = h("button", { class: "btn primary", type: "submit" }, t("common.continue"));
  const digits = Array.from({ length: 6 }, (_, i) =>
    h("input", { class: "digit", "aria-label": t("auth.twostep.digit", { n: i + 1 }), maxlength: 1, inputmode: "numeric", autocomplete: i === 0 ? "one-time-code" : "off", autofocus: i === 0 }));
  const backupInput = h("input", { id: "backup", class: "code-input", spellcheck: "false", placeholder: "xxxx-xxxx" });
  const codeArea = h("div");
  const toggle = h("button", { class: "link", type: "button" });

  const code = () => (backup ? backupInput.value : digits.map((d) => d.value).join(""));
  const submit = () => busy(btn, async () => {
    err.hidden = true;
    try {
      afterSignIn(await api.loginMfa(mfa, code(), backup));
    } catch (e) {
      showError(err, e);
      if (!backup) { digits.forEach((d) => (d.value = "")); digits[0].focus(); }
    }
  });

  digits.forEach((d, i) => {
    d.addEventListener("input", () => {
      d.value = d.value.replace(/\D/g, "").slice(-1);
      if (d.value && i < 5) digits[i + 1].focus();
      if (code().length === 6) void submit();
    });
    d.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !d.value && i > 0) digits[i - 1].focus();
    });
    d.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text").replace(/\D/g, "").slice(0, 6) ?? "";
      if (!text) return;
      e.preventDefault();
      text.split("").forEach((c, j) => (digits[j].value = c));
      digits[Math.min(text.length, 5)].focus();
      if (text.length === 6) void submit();
    });
  });

  const renderCode = () => {
    toggle.textContent = backup ? t("auth.twostep.useTotp") : t("auth.twostep.useBackup");
    mount(codeArea, backup
      ? field(t("auth.twostep.backup"), backupInput)
      : h("fieldset", { class: "digits" }, h("legend", { class: "label" }, t("auth.twostep.code")), digits));
    (backup ? backupInput : digits[0]).focus();
  };
  toggle.onclick = () => { backup = !backup; err.hidden = true; renderCode(); };

  mount(root,
    h("div", { class: "card-page" },
      h("div", { class: "narrow wide-440 stack-28" },
        h("div", { class: "icon-tile" }, icon("phone", 30)),
        h("div", { class: "stack-8" },
          h("h1", { class: "display sm" }, t("auth.twostep.title")),
          h("p", { class: "lead" }, t("auth.twostep.lead", { server: session.server.name })),
        ),
        h("form", { class: "stack-18", onsubmit: (e: Event) => { e.preventDefault(); void submit(); } }, codeArea, err, btn),
        h("div", { class: "row between wrap" }, toggle, h("button", { class: "link muted", type: "button", onclick: () => go({ name: "signin" }) }, t("common.back"))),
      ),
    ),
  );
  renderCode();
});

// ─── Join with an invite ───────────────────────────────────────────

/** [hex, name]; the name is read in the current language each time. */
const swatch = (hex: string, key: Key): [string, string] =>
  Object.defineProperty([hex, ""], 1, { get: () => t(key), enumerable: true }) as [string, string];

export const PALETTE: [string, string][] = [
  swatch("#3F8EFC", "auth.color.sky"), swatch("#12A594", "auth.color.teal"), swatch("#2FA84F", "auth.color.leaf"),
  swatch("#E8A317", "auth.color.sun"), swatch("#F0663A", "auth.color.tangerine"), swatch("#E5487D", "auth.color.berry"),
  swatch("#8B5CF6", "auth.color.grape"), swatch("#7C8BA8", "auth.color.slate"),
];

/** Named gradients, after the solid swatches. */
const SPECIAL: [string, Key][] = [
  ["rainbow", "auth.color.rainbow"], ["sunset", "auth.color.sunset"], ["ocean", "auth.color.ocean"], ["aurora", "auth.color.aurora"],
];

interface EyeDropperApi { open(): Promise<{ sRGBHex: string }> }
declare global { interface Window { EyeDropper?: new () => EyeDropperApi } }

/**
 * Solid swatches, gradients, and "your own color": the system color picker
 * (its macOS panel has an eyedropper), plus a screen eyedropper where the
 * web view has one (Windows). The buttons are built once and updated in
 * place, so the open system picker keeps talking to the same input.
 */
export function colorPicker(initialColor: string, onPick: (c: string) => void) {
  let color = initialColor;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const preset = (c: string) => c in GRADIENTS || PALETTE.some(([hex]) => same(hex, c));
  let custom = preset(color) ? "" : color;

  const hint = h("p", { class: "form-error", role: "status", hidden: true }, t("auth.color.tooDark"));
  const pick = (c: string) => { color = c; onPick(c); sync(); };

  const presets = [...PALETTE, ...SPECIAL.map(([c, key]) => [c, t(key)] as [string, string])].map(([c, label]) => {
    const b = h("button", { type: "button", class: "swatch", "aria-label": label, title: label, style: { background: paint(c) } });
    b.addEventListener("click", () => { hint.hidden = true; pick(c); });
    return { c, b };
  });

  const input = h("input", { type: "color", class: "swatch-input", "aria-label": t("auth.color.custom"), title: t("auth.color.custom"), value: custom || "#63D69E" });
  const own = h("label", { class: "swatch swatch-custom" }, icon("plus", 20), input);
  const tryCustom = (hex: string) => {
    custom = hex.toUpperCase();
    hint.hidden = !looksTooDark(custom);
    if (hint.hidden) pick(custom);
    else sync();
  };
  input.addEventListener("input", () => tryCustom(input.value));

  const Dropper = window.EyeDropper;
  const dropper = Dropper && h("button", { type: "button", class: "swatch swatch-tool", "aria-label": t("auth.color.eyedropper"), title: t("auth.color.eyedropper"),
    onclick: () => void new Dropper().open().then((r) => { input.value = r.sRGBHex.slice(0, 7); tryCustom(input.value); }).catch(() => { /* cancelled */ }) },
    icon("pipette", 20));

  function sync() {
    for (const { c, b } of presets) b.setAttribute("aria-pressed", String(same(c, color)));
    const mine = custom !== "" && same(custom, color);
    own.classList.toggle("has-color", custom !== "");
    own.style.background = custom || "";
    own.style.color = custom ? inkOn(custom) : "";
    own.setAttribute("aria-pressed", String(mine));
  }
  sync();
  return h("div", { class: "color-picker" }, h("div", { class: "swatches" }, presets.map((p) => p.b), own, dropper), hint);
}

export function tilePreview(name: string, color: string, face?: HTMLElement) {
  return h("div", { class: "tile-preview", style: { background: tint(color, 22, "#182238") } },
    face ?? h("span", { class: "avatar big", style: { background: paint(color), color: inkOn(color) } }, initial(name)),
    h("span", { class: "tile-name" }, name || " "),
  );
}

/** "Joining <strong>name</strong> at address", with the name wherever the language puts it. */
function joiningLine(name: string, address: string) {
  const [before, after = ""] = t("auth.join.joining", { address }).split("{server}");
  return h("p", { class: "muted" }, before, h("strong", { class: "bright" }, name), after);
}

register("join", (root, screen) => {
  if (!session.server) return go({ name: "find" });
  let color = PALETTE[5][0];
  const code = h("input", { id: "code", class: "code-input", spellcheck: "false", autofocus: true, value: screen.name === "join" ? screen.code ?? "" : "", placeholder: "XXXXX-XXXXX" });
  const nick = h("input", { id: "nick", maxlength: 24 });
  const uname = h("input", { id: "uname", spellcheck: "false", autocomplete: "username" });
  const pw = h("input", { id: "pw", type: "password", placeholder: t("auth.join.pwPlaceholder"), autocomplete: "new-password" });
  const err = errorLine();
  const btn = h("button", { class: "btn primary", type: "submit" }, t("auth.join.submit"));
  const preview = h("div", { class: "preview-col" });

  const renderPreview = () => mount(preview, tilePreview(nick.value || t("auth.join.you"), color), h("p", { class: "muted small" }, t("auth.join.previewNote")));
  nick.addEventListener("input", renderPreview);

  const submit = (e: Event) => {
    e.preventDefault();
    void busy(btn, async () => {
      err.hidden = true;
      try {
        afterSignIn(await api.join({ code: code.value.trim(), display_name: nick.value.trim(), username: uname.value.trim(), password: pw.value, color }));
      } catch (e) {
        showError(err, e);
      }
    });
  };

  mount(root,
    h("div", { class: "card-page" },
      h("div", { class: "join" },
        h("div", { class: "join-form stack-22" },
          h("div", { class: "stack-8" },
            joiningLine(session.server.name, session.server.address),
            h("h1", { class: "display sm" }, t("auth.join.title")),
          ),
          h("form", { class: "stack-14", onsubmit: submit },
            field(t("auth.join.code"), code),
            h("div", { class: "row wrap gap-14" }, h("div", { class: "grow-180" }, field(t("auth.join.nick"), nick)), h("div", { class: "grow-180" }, field(t("auth.username"), uname))),
            h("div", { class: "stack-8" }, field(t("auth.password"), pw), strengthMeter(pw, () => ({ username: uname.value, display_name: nick.value }))),
            h("fieldset", { class: "plain" }, h("legend", { class: "label" }, t("auth.join.color")), colorPicker(color, (c) => { color = c; renderPreview(); })),
            err,
            btn,
          ),
          h("button", { class: "link muted", type: "button", onclick: () => go({ name: "signin" }) }, t("auth.join.haveAccount")),
        ),
        preview,
      ),
    ),
  );
  renderPreview();
});

// ─── Two-step setup (admins must; anyone may) ──────────────────────

register("mfasetup", (root, screen) => {
  if (!session.me || !session.server) return go({ name: "find" });
  const back = screen.name === "mfasetup" ? screen.back : undefined;
  const required = session.me.mfa_setup_needed;
  const body = h("div", { class: "stack-22" }, h("p", { class: "muted" }, t("auth.mfa.preparing")));
  const err = errorLine();

  const showCodes = (codes: string[]) => {
    root.querySelector<HTMLElement>(".mfa-signout")?.remove();
    const done = h("button", { class: "btn primary", type: "button" }, t("auth.mfa.saved"));
    done.onclick = () => void busy(done, async () => {
      session.me = await api.me();
      go(back ?? { name: "home" });
    });
    mount(body,
      h("div", { class: "mfa-body" },
        h("ul", { class: "backup-codes" }, codes.map((c) => h("li", null, c))),
        h("div", { class: "stack-14" },
          h("h2", { class: "subhead" }, t("auth.mfa.codesTitle")),
          h("p", { class: "muted" }, t("auth.mfa.codesHelp")),
          h("div", { class: "row gap-10 wrap" },
            h("button", { class: "btn ghost", type: "button", onclick: async () => {
              try { await navigator.clipboard.writeText(codes.join("\n")); toast(t("auth.mfa.codesCopied")); }
              catch { toast(t("auth.mfa.copyFailed"), "error"); }
            } }, t("auth.mfa.copyCodes")),
            done))));
  };

  api.mfaSetup().then((s) => {
    const code = h("input", { id: "mfa-code", class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 7, placeholder: "123456", autofocus: true });
    const btn = h("button", { class: "btn primary", type: "submit" }, t("auth.mfa.turnOn"));
    mount(body,
      h("div", { class: "mfa-body" },
        h("img", { class: "qr", src: s.qr, alt: t("auth.mfa.qrAlt"), width: 200, height: 200 }),
        h("form", { class: "stack-14", onsubmit: (e: Event) => {
          e.preventDefault();
          void busy(btn, async () => {
            err.hidden = true;
            try { showCodes((await api.mfaConfirm(code.value)).backup_codes); }
            catch (x) { showError(err, x); code.select(); }
          });
        } },
          h("p", null, h("strong", null, "1. "), t("auth.mfa.step1")),
          h("details", { class: "mfa-key" }, h("summary", { class: "muted small" }, t("auth.mfa.cantScan")),
            h("code", { class: "secret" }, s.secret.replace(/(.{4})/g, "$1 ").trim())),
          h("label", { for: "mfa-code" }, h("strong", null, "2. "), t("auth.mfa.step2")),
          h("div", { class: "row gap-10" }, code, btn),
          err)));
    code.focus();
  }).catch((e) => { mount(body, err); showError(err, e); });

  mount(root,
    h("div", { class: "card-page" },
      h("div", { class: "mfa-page stack-22" },
        h("div", { class: "mfa-head" },
          h("div", { class: "icon-tile" }, icon("phone", 30)),
          h("div", { class: "stack-8" },
            h("h1", { class: "display xs" }, t("auth.mfa.title")),
            h("p", { class: "muted" }, required
              ? t("auth.mfa.required")
              : t("auth.mfa.optional")))),
        body,
        !required && h("button", { class: "link muted", type: "button", onclick: () => go(back ?? { name: "home" }) }, t("auth.mfa.notNow")),
        required && h("button", { class: "link muted mfa-signout", type: "button", onclick: async () => {
          try { await api.logout(); } catch { await api.forgetLogin().catch(() => {}); }
          session.me = null;
          go({ name: "signin" });
        } }, t("auth.mfa.signOut")),
      ),
    ),
  );
});
