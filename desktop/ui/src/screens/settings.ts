// Settings: profile, sound and hotkeys, security, invites, this computer.
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import type { Device, Invite, Me, Role } from "../api/types";
import { errorText } from "../api/types";
import { go, register, session, type SettingsTab } from "../app";
import { ago, h, icon, initial, mount, toast } from "../dom";
import { personAvatar, shrinkForUpload } from "../avatars";
import { ACTIONS, type Action, conflicts, DEFAULTS as DEFAULT_KEYS, format as formatKey, fromEvent, load as loadHotkeys, problem as hotkeyProblem, save as saveHotkeys, globalAvailable } from "../hotkeys";
import { dropdown, dropdownOpen } from "../dropdown";
import { strengthMeter } from "../password";
import type { SoundName } from "../api/types";
import { JOIN_SOUNDS, LEAVE_SOUNDS, playSound } from "../sounds";
import { AUDIO_CAPTURE, prefs } from "../voice";
import { call } from "../call";
import { colorPicker, tilePreview } from "./auth";
import { detectedSystemLang, LANG_NAMES, langSetting, setLangSetting, t, tn, type Key, type LangSetting } from "../i18n";

const TABS: [SettingsTab, Key][] = [
  ["profile", "settings.tab.profile"], ["sound", "settings.tab.sound"], ["security", "settings.tab.security"], ["invites", "settings.tab.invites"], ["computer", "settings.tab.computer"],
];

register("settings", (root, screen) => {
  if (!session.me) { go({ name: "find" }); return; }
  const me: Me = session.me;
  // Invites are hidden from members (the server refuses them anyway).
  const tabs = TABS.filter(([id]) => id !== "invites" || me.role !== "member");
  let tab: SettingsTab = (screen.name === "settings" && screen.tab) || "profile";
  let stopTab: (() => void) | undefined;
  const nav = h("nav", { class: "set-nav" });
  const body = h("section", { class: "set-body" });

  const close = () => go({ name: "home" });
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !dropdownOpen() && !(e.target instanceof HTMLInputElement)) close(); };
  addEventListener("keydown", onKey);

  function select(next: SettingsTab) {
    stopTab?.();
    stopTab = undefined;
    tab = next;
    mount(nav, h("h1", { class: "set-title" }, t("settings.title")), tabs.map(([id, label]) =>
      h("button", { class: `set-tab ${id === tab ? "active" : ""}`, "aria-current": id === tab ? "page" : undefined, onclick: () => select(id) }, t(label))));
    const panel = h("div", { class: "set-panel" });
    mount(body, h("button", { class: "btn ghost back", onclick: close }, icon("close", 20), t("settings.back")), panel);
    stopTab = ({ profile, sound, security, invites, computer } as const)[tab](panel) ?? undefined;
  }

  // ─── Profile ───
  function profile(el: HTMLElement) {
    let color = me.color;
    const name = h("input", { id: "p-name", value: me.display_name, maxlength: 32 });
    const preview = h("div");
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const save = h("button", { class: "btn primary fit", type: "submit" }, t("common.save"));
    const draw = () => {
      const shown = name.value || me.display_name;
      mount(preview, tilePreview(shown, color, personAvatar({ ...me, display_name: shown, color }, 0, "big")));
      remove.hidden = !me.avatar;
    };
    name.addEventListener("input", draw);

    // Photo: shrunk here, re-encoded to 256px on the server, stored in Postgres.
    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
    const upload = h("button", { class: "btn ghost sm", type: "button", onclick: () => file.click() }, t("settings.profile.uploadPhoto"));
    const remove = h("button", { class: "btn ghost sm", type: "button" }, t("settings.profile.removePhoto"));
    file.onchange = async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) { toast(t("settings.profile.photoTooBig"), "error"); return; }
      upload.disabled = true;
      try {
        const me2 = await api.uploadAvatar(await shrinkForUpload(f));
        session.me = Object.assign(me, { avatar: me2.avatar });
        draw();
        toast(t("settings.profile.photoUpdated"));
      } catch (x) { toast(errorText(x), "error"); }
      upload.disabled = false;
    };
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        await api.removeAvatar();
        session.me = Object.assign(me, { avatar: null });
        draw();
      } catch (x) { toast(errorText(x), "error"); }
      remove.disabled = false;
    };
    mount(el,
      h("h2", { class: "display xs" }, t("settings.profile.title")),
      h("form", { class: "set-grid", onsubmit: async (e: Event) => {
        e.preventDefault();
        save.disabled = true;
        err.hidden = true;
        try {
          session.me = Object.assign(me, await api.updateMe({ display_name: name.value.trim(), color }));
          toast(t("common.saved"));
        } catch (x) { err.textContent = errorText(x); err.hidden = false; }
        save.disabled = false;
      } },
        h("div", { class: "stack-16" },
          h("div", { class: "field" }, h("span", { class: "label" }, t("settings.profile.photo")), h("div", { class: "row gap-10" }, upload, remove, file),
            h("p", { class: "muted small" }, t("settings.profile.photoHint"))),
          h("div", { class: "field" }, h("label", { for: "p-name" }, t("settings.profile.name")), name),
          h("div", { class: "field" }, h("span", { class: "label" }, t("settings.profile.username")), h("p", { class: "muted" }, `@${me.username}`)),
          h("fieldset", { class: "plain" }, h("legend", { class: "label" }, t("settings.profile.color")), colorPicker(color, (c) => { color = c; draw(); })),
          err, save),
        preview));
    draw();
  }

  // ─── Sound and hotkeys ───
  function sound(el: HTMLElement) {
    const mic = dropdown("s-mic", [{ value: "", label: t("settings.sound.systemDefault") }], prefs.mic);
    const out = dropdown("s-out", [{ value: "", label: t("settings.sound.systemDefault") }], prefs.speaker);
    // Segmented level meter: green for normal speech, amber when loud, red near clipping.
    const SEGMENTS = 32;
    const segs = Array.from({ length: SEGMENTS }, (_, i) =>
      h("span", { class: `seg ${i < SEGMENTS * 0.6 ? "low" : i < SEGMENTS * 0.85 ? "mid" : "high"}` }));
    const bar = h("span", { class: "meter segmented", role: "meter", "aria-label": t("settings.sound.micLevel"), "aria-valuemin": 0, "aria-valuemax": 100 }, segs);
    let shown = -1;
    const setLevel = (pct: number) => {
      const lit = Math.round((pct / 100) * SEGMENTS);
      if (lit === shown) return;
      shown = lit;
      segs.forEach((s, i) => s.classList.toggle("on", i < lit));
      bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    };
    let micGainNode: GainNode | null = null;
    const slider = (id: string, label: string, value: number, onInput: (v: number) => void, extra?: Node, max = 200) => {
      const out = h("span", { class: "range-value" }, `${value}%`);
      const input = h("input", { id, type: "range", class: "range", min: 0, max, step: 5, value, "aria-valuetext": t("settings.sound.percent", { n: value }) });
      const paint = () => input.style.setProperty("--fill", `${(Number(input.value) / max) * 100}%`);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = `${v}%`;
        input.setAttribute("aria-valuetext", t("settings.sound.percent", { n: v }));
        paint();
        onInput(v);
      });
      paint();
      return h("div", { class: "field" }, h("div", { class: "row between" }, h("label", { for: id }, label), out),
        h("div", { class: "row gap-14" }, input, extra));
    };
    const micVolume = slider("s-mic-gain", t("settings.sound.micVolume"), prefs.micGain, (v) => {
      prefs.micGain = v;
      if (micGainNode) micGainNode.gain.value = v / 100;
      call.setMicGain(v);
    });
    const outVolume = slider("s-out-gain", t("settings.sound.voicesVolume"), prefs.outputVolume, (v) => { prefs.outputVolume = v; call.setOutputVolume(v); }, undefined, 100);
    const testSound = h("button", { class: "btn ghost sm", type: "button", onclick: () => playSound(me.join_sound === "none" ? "ding" : me.join_sound) }, t("settings.sound.play"));
    const soundsVolume = slider("s-sounds-gain", t("settings.sound.soundsVolume"), prefs.soundsVolume, (v) => { prefs.soundsVolume = v; }, testSound, 100);
    const problem = h("div", { class: "mic-problem", role: "alert", hidden: true });
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;

    const stop = () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
      void ctx?.close();
      stream = null; ctx = null;
    };

    const listen = async () => {
      stop();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_CAPTURE, deviceId: prefs.mic ? { exact: prefs.mic } : undefined } as MediaTrackConstraints });
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        // The meter shows the level after your microphone volume, like friends will hear it.
        micGainNode = ctx.createGain();
        micGainNode.gain.value = prefs.micGain / 100;
        ctx.createMediaStreamSource(stream).connect(micGainNode).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(100, (peak / 64) * 100));
          raf = requestAnimationFrame(tick);
        };
        tick();
        problem.hidden = true;
      } catch (e) {
        showMicProblem(e instanceof DOMException ? e.name : "");
      }
    };

    const isMac = navigator.userAgent.includes("Mac");
    const showMicProblem = (name: string) => {
      const notFound = name === "NotFoundError" || name === "OverconstrainedError";
      const inApp = "__TAURI_INTERNALS__" in window;
      mount(problem,
        h("div", { class: "row gap-10" }, icon("micOff", 22, "ember"),
          h("strong", null, notFound ? t("settings.sound.noMic") : t("settings.sound.micBlocked"))),
        h("p", { class: "muted small" }, notFound
          ? t("settings.sound.noMicHint")
          : isMac
            ? t("settings.sound.allowMac")
            : t("settings.sound.allowWindows")),
        h("div", { class: "row gap-10 wrap" },
          !notFound && inApp && h("button", { class: "btn primary sm", type: "button", onclick: () =>
            void invoke("open_privacy_settings", { kind: "microphone" }).catch(() => toast(t("settings.sound.openSettingsFailed"), "error")) },
            isMac ? t("settings.sound.openMac") : t("settings.sound.openWindows")),
          h("button", { class: "btn ghost sm", type: "button", onclick: () => void listen().then(fill) }, t("common.tryAgain"))));
      problem.hidden = false;
      setLevel(0);
    };

    const fill = async () => {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const opts = (kind: MediaDeviceKind) => [{ value: "", label: t("settings.sound.systemDefault") },
        ...devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default").map((d, i) =>
          ({ value: d.deviceId, label: d.label || t(kind === "audioinput" ? "settings.sound.microphoneN" : "settings.sound.speakerN", { n: i + 1 }) }))];
      mic.setOptions(opts("audioinput"), prefs.mic);
      out.setOptions(opts("audiooutput"), prefs.speaker);
    };
    // A call in progress switches right away.
    mic.onChange = (v) => { prefs.mic = v; void listen(); void call.useDevice("audioinput", v); };
    out.onChange = (v) => { prefs.speaker = v; void call.useDevice("audiooutput", v); };

    mount(el,
      h("h2", { class: "display xs" }, t("settings.sound.title")),
      h("div", { class: "stack-16 maxw" },
        h("div", { class: "field" }, h("label", { for: "s-mic" }, t("settings.sound.microphone")), mic.el),
        micVolume,
        h("div", { class: "row gap-14 meter-row" }, h("span", { class: "muted small" }, t("settings.sound.saySomething")), bar),
        problem,
        h("div", { class: "field" }, h("label", { for: "s-out" }, t("settings.sound.output")), out.el),
        outVolume,
        soundsVolume,
        h("p", { class: "muted small" }, t("settings.sound.voicesVsSounds")),
        joinSoundField(),
        h("h3", { class: "subhead" }, t("settings.sound.screenSharing")),
        screenModeField(),
        "__TAURI_INTERNALS__" in window && toggle(t("settings.sound.overlay"),
          t("settings.sound.overlayHint"),
          prefs.overlayWhileSharing, (v) => { prefs.overlayWhileSharing = v; }),
        h("h3", { class: "subhead" }, t("settings.sound.voiceRooms")),
        toggle(t("settings.sound.autoJoin"), t("settings.sound.autoJoinHint"), prefs.autoJoin, (v) => { prefs.autoJoin = v; }),
        toggle(t("settings.sound.joinMuted"), t("settings.sound.joinMutedHint"), prefs.joinMuted, (v) => { prefs.joinMuted = v; }),
        toggle(t("settings.sound.joinCamera"), t("settings.sound.joinCameraHint"), prefs.joinCamera, (v) => { prefs.joinCamera = v; }),
        h("p", { class: "info-box" }, t("settings.sound.processing")),
        h("h3", { class: "subhead" }, t("settings.sound.hotkeys")),
        h("p", { class: "muted small" }, t("settings.sound.hotkeysHint")),
        hotkeyRows()));
    // Fill the lists now; fill again once access is granted (device names appear then).
    void fill();
    void listen().then(fill);
    return stop;
  }

  function screenModeField() {
    const pick = dropdown("s-screen", [
      { value: "text", label: t("settings.sound.sharpText"), hint: t("settings.sound.sharpTextHint") },
      { value: "motion", label: t("settings.sound.smoothMotion"), hint: t("settings.sound.smoothMotionHint") },
    ], prefs.screenMode);
    pick.onChange = (v) => { prefs.screenMode = v as "text" | "motion"; };
    return h("div", { class: "field" }, h("label", { for: "s-screen" }, t("settings.sound.screenMode")), pick.el,
      h("p", { class: "muted small" }, t("settings.sound.screenModeHint")));
  }

  function toggle(label: string, hint: string, on: boolean, onChange: (v: boolean) => void) {
    const box = h("input", { type: "checkbox", checked: on });
    box.addEventListener("change", () => onChange(box.checked));
    return h("label", { class: "toggle-row" }, h("span", { class: "grow col" }, h("span", null, label), h("span", { class: "muted small" }, hint)), box, h("span", { class: "switch", "aria-hidden": "true" }));
  }

  /** Your join and leave sounds: what everyone in a voice room hears when you come and go. */
  function soundPicker(kind: "join_sound" | "leave_sound", label: string, hint: string) {
    const pick = dropdown(`s-${kind}`, kind === "join_sound" ? JOIN_SOUNDS : LEAVE_SOUNDS, me[kind]);
    pick.onChange = async (v) => {
      playSound(v as SoundName);
      try {
        Object.assign(me, await api.updateMe({ [kind]: v as SoundName }));
        session.me = me;
      } catch (x) { toast(errorText(x), "error"); pick.value = me[kind]; }
    };
    const play = h("button", { class: "btn ghost sm", type: "button", onclick: () => playSound(pick.value as SoundName) }, t("settings.sound.play"));
    return h("div", { class: "field" }, h("label", { for: `s-${kind}` }, label),
      h("div", { class: "row gap-14" }, h("div", { class: "grow" }, pick.el), play),
      h("p", { class: "muted small" }, hint));
  }

  function joinSoundField() {
    return [
      soundPicker("join_sound", t("settings.sound.joinSound"), t("settings.sound.joinSoundHint")),
      soundPicker("leave_sound", t("settings.sound.leaveSound"), t("settings.sound.leaveSoundHint")),
    ];
  }

  function hotkeyRows() {
    const bindings = loadHotkeys();
    const list = h("ul", { class: "rows" });
    let recording: Action | null = null;
    let note: { action: Action; text: string[]; bad: boolean } | null = null;

    const stopRecording = () => {
      recording = null;
      removeEventListener("keydown", capture, true);
      draw();
    };
    const capture = (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();
      const action = recording;
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (plain && e.code === "Escape") return stopRecording();
      if (plain && (e.code === "Backspace" || e.code === "Delete")) {
        bindings[action] = null;
        saveHotkeys(bindings);
        note = null;
        return stopRecording();
      }
      const c = fromEvent(e);
      if (!c) return; // just a modifier so far
      const bad = hotkeyProblem(c);
      if (bad) { note = { action, text: [bad], bad: true }; return stopRecording(); }
      bindings[action] = c;
      saveHotkeys(bindings);
      const found = conflicts(c, action, bindings);
      note = found.length ? { action, text: found, bad: false } : null;
      stopRecording();
      // Push to talk is system-wide: make sure no other app already holds it.
      if (action === "ptt") void globalAvailable(c).then((ok) => {
        if (ok || JSON.stringify(bindings.ptt) !== JSON.stringify(c)) return;
        note = { action, text: [...found, t("settings.hotkey.taken")], bad: true };
        draw();
      });
    };

    function draw() {
      mount(list, ACTIONS.map(([action, label]) => {
        const isDefault = JSON.stringify(bindings[action]) === JSON.stringify(DEFAULT_KEYS[action]);
        const btn = h("button", { class: `kbd kbd-btn ${recording === action ? "recording" : ""}`, type: "button",
          "aria-label": t("settings.hotkey.change", { action: label, keys: formatKey(bindings[action]) }) },
          recording === action ? t("settings.hotkey.pressKeys") : formatKey(bindings[action]));
        btn.onclick = () => {
          if (recording) removeEventListener("keydown", capture, true);
          recording = action;
          note = null;
          addEventListener("keydown", capture, true);
          draw();
        };
        // Conflicts are shown for every binding, not only right after a change.
        const current = bindings[action];
        const live = current ? conflicts(current, action, bindings) : [];
        const lines = note?.action === action ? note.text : live;
        return h("li", { class: "hotkey-row" },
          h("div", { class: "row gap-14" },
            h("span", { class: "grow" }, label),
            !isDefault && h("button", { class: "link muted", type: "button", onclick: () => {
              bindings[action] = DEFAULT_KEYS[action];
              saveHotkeys(bindings);
              note = null;
              draw();
            } }, t("settings.hotkey.reset")),
            btn),
          lines.length > 0 && h("ul", { class: `hotkey-warn ${note?.action === action && note.bad ? "bad" : ""}` }, lines.map((line) => h("li", null, line))));
      }));
    }
    draw();
    return list;
  }

  // ─── Security ───
  function security(el: HTMLElement) {
    const cur = h("input", { id: "pw-cur", type: "password", autocomplete: "current-password" });
    const next = h("input", { id: "pw-new", type: "password", autocomplete: "new-password", placeholder: t("settings.security.newPlaceholder") });
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const btn = h("button", { class: "btn primary fit", type: "submit" }, t("settings.security.changePassword"));
    mount(el,
      h("h2", { class: "display xs" }, t("settings.security.title")),
      h("div", { class: "stack-28 maxw" },
        h("div", { class: "card stack-10" },
          h("div", { class: "row gap-10" }, h("strong", { class: "grow" }, t("settings.security.twoStep")),
            h("span", { class: me.mfa_enabled ? "leaf" : "muted" }, me.mfa_enabled ? t("settings.security.on") : t("settings.security.off"))),
          h("p", { class: "muted small" }, me.mfa_enabled
            ? t("settings.security.twoStepOnHint")
            : t("settings.security.twoStepOffHint")),
          !me.mfa_enabled && h("button", { class: "btn primary sm fit", onclick: () => go({ name: "mfasetup", back: { name: "settings", tab: "security" } }) }, t("settings.security.turnOn"))),
        h("form", { class: "stack-16", onsubmit: async (e: Event) => {
          e.preventDefault();
          btn.disabled = true;
          err.hidden = true;
          try {
            await api.changePassword(cur.value, next.value);
            cur.value = next.value = "";
            toast(t("settings.security.passwordChanged"));
          } catch (x) { err.textContent = errorText(x); err.hidden = false; }
          btn.disabled = false;
        } },
          h("h3", { class: "subhead" }, t("settings.security.password")),
          h("div", { class: "field" }, h("label", { for: "pw-cur" }, t("settings.security.current")), cur),
          h("div", { class: "field" }, h("label", { for: "pw-new" }, t("settings.security.new")), next, strengthMeter(next, () => ({ username: me.username, display_name: me.display_name }))),
          err, btn)));
  }

  // ─── Invite friends ───
  function invites(el: HTMLElement) {
    const label = h("input", { id: "inv-label", placeholder: t("settings.invites.forPlaceholder"), maxlength: 40 });
    const hours = dropdown("inv-hours", [["1", tn("settings.invites.hours", 1)], ["24", tn("settings.invites.days", 1)], ["72", tn("settings.invites.days", 3)], ["168", tn("settings.invites.days", 7)]].map(([value, label]) => ({ value, label })), "168");
    const uses = dropdown("inv-uses", [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n === 1 ? t("settings.invites.once") : tn("settings.invites.upTo", n) })), "1");
    const role = dropdown("inv-role", [{ value: "member", label: t("role.member") }, { value: "moderator", label: t("role.moderator") }], "member");
    const fresh = h("div");
    const list = h("ul", { class: "rows" });
    const btn = h("button", { class: "btn primary fit", type: "submit" }, t("settings.invites.create"));

    const expiresIn = (iso: string) => {
      const hrs = (new Date(iso).getTime() - Date.now()) / 3_600_000;
      if (hrs <= 0) return t("settings.invites.expired");
      return hrs < 24 ? tn("settings.invites.expiresHours", Math.max(1, Math.round(hrs))) : tn("settings.invites.expiresDays", Math.round(hrs / 24));
    };

    const show = (inv: Invite) => {
      const copy = h("button", { class: "btn primary fit" }, icon("copy", 18), t("settings.invites.copyLink"));
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(inv.link ?? inv.code ?? ""); toast(t("settings.invites.copied")); }
        catch { toast(t("settings.invites.copyFailed"), "error"); }
      };
      mount(fresh, h("div", { class: "invite-card" },
        h("strong", null, inv.label ? t("settings.invites.newFor", { label: inv.label }) : t("settings.invites.new")),
        h("p", { class: "invite-code" }, inv.code ?? ""),
        h("div", { class: "row gap-14 wrap" }, copy, h("span", { class: "muted" }, expiresIn(inv.expires_at)))));
    };

    const load = async () => {
      try {
        const all = await api.invites();
        mount(list, all.length ? all.map((inv) => {
          const used = inv.uses >= inv.max_uses || (inv.joined.length > 0 && new Date(inv.expires_at).getTime() < Date.now());
          const expired = new Date(inv.expires_at).getTime() < Date.now();
          return h("li", null,
            h("span", { class: "grow col" }, h("span", null, inv.label ?? t("settings.invites.invite")),
              h("span", { class: "muted small" }, [inv.role === "moderator" && t("role.moderator"), inv.max_uses > 1 && t("settings.invites.used", { uses: inv.uses, max: inv.max_uses })].filter(Boolean).join(", "))),
            used ? h("span", { class: "leaf" }, inv.joined.length ? t("settings.invites.joined", { names: inv.joined.join(", ") }) : t("settings.invites.usedUp"))
              : expired ? h("span", { class: "muted" }, t("settings.invites.expiredOrCancelled"))
              : [h("span", { class: "lantern" }, t("settings.invites.waiting")),
                h("button", { class: "btn ghost sm", onclick: async () => {
                  try { await api.cancelInvite(inv.id); await load(); } catch (e) { toast(errorText(e), "error"); }
                } }, t("settings.invites.cancel"))]);
        }) : h("li", { class: "muted" }, t("settings.invites.none")));
      } catch (e) { mount(list, h("li", { class: "muted" }, errorText(e))); }
    };

    mount(el,
      h("h2", { class: "display xs" }, t("settings.invites.title")),
      h("p", { class: "muted" }, t("settings.invites.intro")),
      h("div", { class: "stack-22 maxw" },
        h("form", { class: "stack-14", onsubmit: async (e: Event) => {
          e.preventDefault();
          btn.disabled = true;
          try {
            const inv = await api.createInvite({ label: label.value, role: role.value as Role, max_uses: Number(uses.value), hours: Number(hours.value) });
            label.value = "";
            show(inv);
            await load();
          } catch (x) { toast(errorText(x), "error"); }
          btn.disabled = false;
        } },
          h("div", { class: "field" }, h("label", { for: "inv-label" }, t("settings.invites.for")), label),
          h("div", { class: "row gap-14 wrap" },
            h("div", { class: "field grow-180" }, h("label", { for: "inv-hours" }, t("settings.invites.worksFor")), hours.el),
            h("div", { class: "field grow-180" }, h("label", { for: "inv-uses" }, t("settings.invites.uses")), uses.el),
            me.role === "admin" && h("div", { class: "field grow-180" }, h("label", { for: "inv-role" }, t("settings.invites.startsAs")), role.el)),
          btn),
        fresh,
        list));
    void load();
  }

  // ─── This computer ───
  function computer(el: HTMLElement) {
    const server = session.server;
    const list = h("ul", { class: "rows" });
    const signOut = async () => {
      await call.leave();
      try { await api.logout(); } catch { await api.forgetLogin().catch(() => {}); }
      session.me = null;
      go({ name: "signin" });
    };
    const load = async () => {
      try {
        const ds: Device[] = await api.devices();
        mount(list, ds.map((d) => h("li", null,
          h("span", { class: "grow col" }, h("strong", null, d.device_name),
            d.current ? h("span", { class: "leaf small" }, t("settings.computer.thisComputer")) : h("span", { class: "muted small" }, t("settings.computer.lastUsed", { ago: ago(d.last_seen) }))),
          !d.current && h("button", { class: "btn ghost sm", onclick: async () => {
            try { await api.signOutDevice(d.id); await load(); } catch (e) { toast(errorText(e), "error"); }
          } }, t("settings.computer.signItOut")))));
      } catch (e) { mount(list, h("li", { class: "muted" }, errorText(e))); }
    };
    mount(el,
      h("h2", { class: "display xs" }, t("settings.computer.title")),
      h("div", { class: "stack-28 maxw" },
        h("div", { class: "card stack-16" },
          h("div", { class: "row gap-14" },
            h("span", { class: "server-badge", style: { width: "56px", height: "56px", fontSize: "24px" } }, initial(server?.name ?? "T")),
            h("div", { class: "col" }, h("strong", { class: "big" }, server?.name ?? "Treehouse"), h("span", { class: "muted" }, t("settings.computer.signedInAs", { address: server?.address ?? "", username: me.username })))),
          h("div", { class: "row gap-14 wrap" },
            h("button", { class: "btn outline-ember fit", onclick: () => void signOut() }, t("settings.computer.signOut")),
            h("button", { class: "btn ghost fit", onclick: () => go({ name: "find" }) }, t("settings.computer.switch"))),
          h("p", { class: "muted small" }, t("settings.computer.signOutHint"))),
        languageField(),
        h("h3", { class: "subhead" }, t("settings.computer.devices")),
        list));
    void load();
  }

  /** Interface language, per computer. "System default" follows the OS. */
  function languageField() {
    const opts: { value: LangSetting; label: string }[] = [
      { value: "system", label: t("settings.computer.systemLanguage", { name: LANG_NAMES[detectedSystemLang()] }) },
      { value: "en", label: LANG_NAMES.en },
      { value: "es", label: LANG_NAMES.es },
      { value: "uk", label: LANG_NAMES.uk },
    ];
    const pick = dropdown("c-lang", opts, langSetting());
    pick.onChange = (v) => {
      setLangSetting(v as LangSetting);
      go({ name: "settings", tab: "computer" });
    };
    return h("div", { class: "field" }, h("label", { for: "c-lang" }, t("settings.computer.language")), pick.el,
      h("p", { class: "muted small" }, t("settings.computer.languageHint")));
  }

  mount(root, h("div", { class: "settings" }, nav, body));
  select(tab);
  return () => { stopTab?.(); removeEventListener("keydown", onKey); };
});
