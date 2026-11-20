// Settings: profile, sound and hotkeys, security, invites, this computer.
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import type { Device, Invite, Me, Role } from "../api/types";
import { errorText } from "../api/types";
import { go, register, session, type SettingsTab } from "../app";
import { ago, h, icon, initial, mount, toast } from "../dom";
import { strengthMeter } from "../password";
import { AUDIO_CAPTURE, prefs } from "../voice";
import { colorPicker, tilePreview } from "./auth";

const TABS: [SettingsTab, string][] = [
  ["profile", "Profile"], ["sound", "Sound and hotkeys"], ["security", "Security"], ["invites", "Invite friends"], ["computer", "This computer"],
];

register("settings", (root, screen) => {
  if (!session.me) { go({ name: "find" }); return; }
  const me: Me = session.me;
  // Invites are hidden from members (the server refuses them anyway).
  const tabs = TABS.filter(([t]) => t !== "invites" || me.role !== "member");
  let tab: SettingsTab = (screen.name === "settings" && screen.tab) || "profile";
  let stopTab: (() => void) | undefined;
  const nav = h("nav", { class: "set-nav" });
  const body = h("section", { class: "set-body" });

  const close = () => go({ name: "home" });
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) close(); };
  addEventListener("keydown", onKey);

  function select(t: SettingsTab) {
    stopTab?.();
    stopTab = undefined;
    tab = t;
    mount(nav, h("h1", { class: "set-title" }, "Settings"), tabs.map(([id, label]) =>
      h("button", { class: `set-tab ${id === tab ? "active" : ""}`, "aria-current": id === tab ? "page" : undefined, onclick: () => select(id) }, label)));
    const panel = h("div", { class: "set-panel" });
    mount(body, h("button", { class: "btn ghost back", onclick: close }, icon("close", 20), "Back to the treehouse"), panel);
    stopTab = ({ profile, sound, security, invites, computer } as const)[tab](panel) ?? undefined;
  }

  // ─── Profile ───
  function profile(el: HTMLElement) {
    let color = me.color;
    const name = h("input", { id: "p-name", value: me.display_name, maxlength: 32 });
    const preview = h("div");
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const save = h("button", { class: "btn primary fit", type: "submit" }, "Save");
    const draw = () => mount(preview, tilePreview(name.value || me.display_name, color));
    name.addEventListener("input", draw);
    mount(el,
      h("h2", { class: "display xs" }, "Profile"),
      h("form", { class: "set-grid", onsubmit: async (e: Event) => {
        e.preventDefault();
        save.disabled = true;
        err.hidden = true;
        try {
          session.me = Object.assign(me, await api.updateMe({ display_name: name.value.trim(), color }));
          toast("Saved.");
        } catch (x) { err.textContent = errorText(x); err.hidden = false; }
        save.disabled = false;
      } },
        h("div", { class: "stack-16" },
          h("div", { class: "field" }, h("label", { for: "p-name" }, "Name your crew sees"), name),
          h("div", { class: "field" }, h("span", { class: "label" }, "Username"), h("p", { class: "muted" }, `@${me.username}`)),
          h("fieldset", { class: "plain" }, h("legend", { class: "label" }, "Your color"), colorPicker(color, (c) => { color = c; draw(); })),
          err, save),
        preview));
    draw();
  }

  // ─── Sound and hotkeys ───
  function sound(el: HTMLElement) {
    const mic = h("select", { id: "s-mic", class: "select" });
    const out = h("select", { id: "s-out", class: "select" });
    const bar = h("span", { class: "meter-fill" });
    const problem = h("div", { class: "mic-problem", role: "alert", hidden: true });
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;

    const stop = () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
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
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
          bar.style.width = `${Math.min(100, (peak / 64) * 100)}%`;
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
          h("strong", null, notFound ? "No microphone found" : "Treehouse can’t use your microphone")),
        h("p", { class: "muted small" }, notFound
          ? "Plug one in or pick another one above, then try again."
          : isMac
            ? "Allow it in System Settings → Privacy & Security → Microphone, then try again."
            : "Allow it in Settings → Privacy → Microphone, then try again."),
        h("div", { class: "row gap-10 wrap" },
          !notFound && inApp && h("button", { class: "btn primary sm", type: "button", onclick: () =>
            void invoke("open_privacy_settings", { kind: "microphone" }).catch(() => toast("Couldn’t open settings. Open them yourself.", "error")) },
            isMac ? "Open System Settings" : "Open Windows settings"),
          h("button", { class: "btn ghost sm", type: "button", onclick: () => void listen().then(fill) }, "Try again")));
      problem.hidden = false;
      bar.style.width = "0";
    };

    const fill = async () => {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const opts = (kind: MediaDeviceKind, chosen: string) => {
        const list = devices.filter((d) => d.kind === kind);
        return [h("option", { value: "" }, "System default"), ...list.filter((d) => d.deviceId && d.deviceId !== "default").map((d, i) =>
          h("option", { value: d.deviceId, selected: d.deviceId === chosen }, d.label || `${kind === "audioinput" ? "Microphone" : "Speaker"} ${i + 1}`))];
      };
      mount(mic, opts("audioinput", prefs.mic));
      mount(out, opts("audiooutput", prefs.speaker));
      mic.value = prefs.mic;
      out.value = prefs.speaker;
    };
    mic.onchange = () => { prefs.mic = mic.value; void listen(); };
    out.onchange = () => { prefs.speaker = out.value; };

    const key = (k: string) => h("kbd", { class: "kbd" }, k);
    mount(el,
      h("h2", { class: "display xs" }, "Sound"),
      h("div", { class: "stack-16 maxw" },
        h("div", { class: "field" }, h("label", { for: "s-mic" }, "Microphone"), mic),
        h("div", { class: "row gap-14 meter-row" }, h("span", { class: "muted small" }, "Say something"), h("span", { class: "meter" }, bar)),
        problem,
        h("div", { class: "field" }, h("label", { for: "s-out" }, "Speakers or headphones"), out),
        h("p", { class: "info-box" }, "Echo removal, background-noise removal and volume leveling are always on, so your keyboard and fans stay out of the call."),
        h("h3", { class: "subhead" }, "Hotkeys"),
        h("ul", { class: "rows" },
          h("li", null, h("span", { class: "grow" }, "Mute"), key("Ctrl + M")),
          h("li", null, h("span", { class: "grow" }, "Deafen"), key("Ctrl + D")),
          h("li", null, h("span", { class: "grow" }, "Push to talk"), h("span", { class: "muted" }, "Off")))));
    // Fill the lists now; fill again once access is granted (device names appear then).
    void fill();
    void listen().then(fill);
    return stop;
  }

  // ─── Security ───
  function security(el: HTMLElement) {
    const cur = h("input", { id: "pw-cur", type: "password", autocomplete: "current-password" });
    const next = h("input", { id: "pw-new", type: "password", autocomplete: "new-password", placeholder: "A few unrelated words" });
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const btn = h("button", { class: "btn primary fit", type: "submit" }, "Change password");
    mount(el,
      h("h2", { class: "display xs" }, "Security"),
      h("div", { class: "stack-28 maxw" },
        h("div", { class: "card stack-10" },
          h("div", { class: "row gap-10" }, h("strong", { class: "grow" }, "Two-step sign-in"),
            h("span", { class: me.mfa_enabled ? "leaf" : "muted" }, me.mfa_enabled ? "On" : "Off")),
          h("p", { class: "muted small" }, me.mfa_enabled
            ? "Signing in asks for a code from your authenticator app. Lost your phone? Use a backup code, or ask an admin to reset it."
            : "Add a code from an authenticator app when you sign in. Admins always need it."),
          !me.mfa_enabled && h("button", { class: "btn primary sm fit", onclick: () => go({ name: "mfasetup", back: { name: "settings", tab: "security" } }) }, "Turn on two-step sign-in")),
        h("form", { class: "stack-16", onsubmit: async (e: Event) => {
          e.preventDefault();
          btn.disabled = true;
          err.hidden = true;
          try {
            await api.changePassword(cur.value, next.value);
            cur.value = next.value = "";
            toast("Password changed.");
          } catch (x) { err.textContent = errorText(x); err.hidden = false; }
          btn.disabled = false;
        } },
          h("h3", { class: "subhead" }, "Password"),
          h("div", { class: "field" }, h("label", { for: "pw-cur" }, "Current password"), cur),
          h("div", { class: "field" }, h("label", { for: "pw-new" }, "New password"), next, strengthMeter(next, () => ({ username: me.username, display_name: me.display_name }))),
          err, btn)));
  }

  // ─── Invite friends ───
  function invites(el: HTMLElement) {
    const label = h("input", { id: "inv-label", placeholder: "Who’s it for? (Kai)", maxlength: 40 });
    const hours = h("select", { id: "inv-hours", class: "select" },
      [[1, "1 hour"], [24, "1 day"], [72, "3 days"], [168, "7 days"]].map(([v, t]) => h("option", { value: v, selected: v === 168 }, t)));
    const uses = h("select", { id: "inv-uses", class: "select" }, [1, 2, 3, 4, 5].map((n) => h("option", { value: n }, n === 1 ? "Once" : `Up to ${n} people`)));
    const role = h("select", { id: "inv-role", class: "select" }, h("option", { value: "member" }, "Member"), h("option", { value: "moderator" }, "Moderator"));
    const fresh = h("div");
    const list = h("ul", { class: "rows" });
    const btn = h("button", { class: "btn primary fit", type: "submit" }, "Create invite");

    const expiresIn = (iso: string) => {
      const hrs = (new Date(iso).getTime() - Date.now()) / 3_600_000;
      if (hrs <= 0) return "Expired";
      return hrs < 24 ? `Expires in ${Math.max(1, Math.round(hrs))} hour${Math.round(hrs) === 1 ? "" : "s"}` : `Expires in ${Math.round(hrs / 24)} day${Math.round(hrs / 24) === 1 ? "" : "s"}`;
    };

    const show = (inv: Invite) => {
      const copy = h("button", { class: "btn primary fit" }, icon("copy", 18), "Copy invite link");
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(inv.link ?? inv.code ?? ""); toast("Invite link copied."); }
        catch { toast("Couldn’t copy. Select the code and copy it yourself.", "error"); }
      };
      mount(fresh, h("div", { class: "invite-card" },
        h("strong", null, inv.label ? `New invite for ${inv.label}` : "New invite"),
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
            h("span", { class: "grow col" }, h("span", null, inv.label ?? "Invite"),
              h("span", { class: "muted small" }, `${inv.role === "moderator" ? "Moderator, " : ""}${inv.max_uses > 1 ? `${inv.uses} of ${inv.max_uses} used` : ""}`.replace(/, $/, ""))),
            used ? h("span", { class: "leaf" }, inv.joined.length ? `Joined: ${inv.joined.join(", ")}` : "Used")
              : expired ? h("span", { class: "muted" }, "Expired or cancelled")
              : [h("span", { class: "lantern" }, "Waiting"),
                h("button", { class: "btn ghost sm", onclick: async () => {
                  try { await api.cancelInvite(inv.id); await load(); } catch (e) { toast(errorText(e), "error"); }
                } }, "Cancel")]);
        }) : h("li", { class: "muted" }, "No invites yet."));
      } catch (e) { mount(list, h("li", { class: "muted" }, errorText(e))); }
    };

    mount(el,
      h("h2", { class: "display xs" }, "Invite friends"),
      h("p", { class: "muted" }, "Make an invite, then send the link to your friend."),
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
          h("div", { class: "field" }, h("label", { for: "inv-label" }, "For"), label),
          h("div", { class: "row gap-14 wrap" },
            h("div", { class: "field grow-180" }, h("label", { for: "inv-hours" }, "Works for"), hours),
            h("div", { class: "field grow-180" }, h("label", { for: "inv-uses" }, "Uses"), uses),
            me.role === "admin" && h("div", { class: "field grow-180" }, h("label", { for: "inv-role" }, "Starts as"), role)),
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
      try { await api.logout(); } catch { await api.forgetLogin().catch(() => {}); }
      session.me = null;
      go({ name: "signin" });
    };
    const load = async () => {
      try {
        const ds: Device[] = await api.devices();
        mount(list, ds.map((d) => h("li", null,
          h("span", { class: "grow col" }, h("strong", null, d.device_name),
            d.current ? h("span", { class: "leaf small" }, "This computer") : h("span", { class: "muted small" }, `Last used ${ago(d.last_seen)}`)),
          !d.current && h("button", { class: "btn ghost sm", onclick: async () => {
            try { await api.signOutDevice(d.id); await load(); } catch (e) { toast(errorText(e), "error"); }
          } }, "Sign it out"))));
      } catch (e) { mount(list, h("li", { class: "muted" }, errorText(e))); }
    };
    mount(el,
      h("h2", { class: "display xs" }, "This computer"),
      h("div", { class: "stack-28 maxw" },
        h("div", { class: "card stack-16" },
          h("div", { class: "row gap-14" },
            h("span", { class: "server-badge", style: { width: "56px", height: "56px", fontSize: "24px" } }, initial(server?.name ?? "T")),
            h("div", { class: "col" }, h("strong", { class: "big" }, server?.name ?? "Treehouse"), h("span", { class: "muted" }, `${server?.address ?? ""}, signed in as ${me.username}`))),
          h("div", { class: "row gap-14 wrap" },
            h("button", { class: "btn outline-ember fit", onclick: () => void signOut() }, "Sign out"),
            h("button", { class: "btn ghost fit", onclick: () => go({ name: "find" }) }, "Switch treehouse")),
          h("p", { class: "muted small" }, "Signing out removes your login from this computer only. Your account and friends stay put.")),
        h("h3", { class: "subhead" }, "Where you’re signed in"),
        list));
    void load();
  }

  mount(root, h("div", { class: "settings" }, nav, body));
  select(tab);
  return () => { stopTab?.(); removeEventListener("keydown", onKey); };
});
