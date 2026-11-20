// The main window: sidebar, The Deck, voice rooms and room chat.
// Everything shown comes from the server; buttons hidden here are still
// refused by the server.
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import type { Gif, LiveEvent, Me, Message, Person, Presence, Room, Treehouse, VoiceMember } from "../api/types";
import { errorText } from "../api/types";
import { go, register, session } from "../app";
import { personAvatar } from "../avatars";
import { chime, notificationsOn, setNotifications } from "../notify";
import { playJoinSound, playSound, preloadSounds } from "../sounds";
import { prefs } from "../voice";
import { call, type CallEvent, type Capture, type Video } from "../call";
import { popout } from "../popout";
import { format as formatKey, load as loadHotkeys, matches, toAccelerator } from "../hotkeys";
import { ago, h, icon, icons, mount, time, toast } from "../dom";

const EMOJI = ["😂", "😭", "💀", "🔥", "💯", "❤️", "👍", "👎", "😎", "🥲", "😴", "🤔", "😤", "🙃", "😅", "🤯", "🥳", "😈", "👀", "🙏", "🫡", "🤝", "👋", "🎮", "🕹️", "🏆", "⚡", "✨", "🎉", "🍕", "🍿", "🥤", "🌙", "⭐", "🦉", "🌲", "🎧", "🎤", "📣", "✅", "❌", "⏰"];

const PRESENCE_LABEL: Record<Presence, string> = { online: "Online", away: "Away", busy: "Busy", brb: "Be right back" };
const STATUS_PRESETS: [string, string][] = [["🎮", "In a game"], ["📚", "Homework"], ["🍕", "Eating"], ["🎧", "Listening to music"], ["😴", "Sleeping"]];

// Last reactions you used, for the hover toolbar (a per-computer convenience).
const RECENT_KEY = "treehouse.recentEmoji";
function recentEmoji(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "null");
    if (Array.isArray(list) && list.length) return list.slice(0, 3);
  } catch { /* defaults */ }
  return ["👍", "😂", "🔥"];
}
function rememberEmoji(e: string) {
  const list = [e, ...recentEmoji().filter((x) => x !== e)].slice(0, 3);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* preference only */ }
}

const COMMANDS = [
  { name: "giphy", arg: "search words", help: "Pick and send a GIF" },
  { name: "shrug", arg: "message", help: "Add ¯\\_(ツ)_/¯ to your message" },
  { name: "roll", arg: "", help: "Roll a number from 1 to 100, for picking who goes first" },
  { name: "me", arg: "action", help: "Say what you’re doing, like “/me grabs snacks”" },
];

type View = { kind: "deck" } | { kind: "voice"; roomId: number };

register("home", (root) => {
  if (!session.me) { go({ name: "find" }); return; }
  const me: Me = session.me;

  // ── state (a view of what the server sent) ──
  let people = new Map<number, Person>();
  let rooms: Room[] = [];
  let treehouse: Treehouse = { name: session.server?.name ?? "Treehouse", version: "", message_ttl_hours: 72, max_voice_rooms: 3, gifs: false };
  let offline = false;
  // Coming back from Settings mid-call opens the call again.
  let view: View = call.roomId !== null ? { kind: "voice", roomId: call.roomId } : { kind: "deck" };
  let roomChatOpen = false;
  let deckMentions = 0;
  /** Whose screen is large when several people share. */
  let spotlight: number | null = null;
  let problem: { kind: Capture; problem: "denied" | "missing" | "unsupported" | "failed"; sound?: boolean } | null = null;
  const cache = new Map<number, Message[]>();

  const deck = () => rooms.find((r) => r.kind === "deck");
  const voiceRooms = () => rooms.filter((r) => r.kind === "voice");
  /** The room your call is in (connecting, connected or reconnecting). */
  const myVoiceRoom = () => voiceRooms().find((r) => r.id === call.roomId);
  const person = (id: number): Person => people.get(id) ?? { id, username: "gone", display_name: "Someone", color: "#7C8BA8", role: "member", online: false, avatar: null, status: "online", status_emoji: null, status_text: null, join_sound: "none", leave_sound: "none" };

  // ── layout ──
  const sidebar = h("aside", { class: "sidebar" });
  const main = h("main", { class: "main" });
  const side = h("aside", { class: "roomchat", hidden: true });
  const crew = h("aside", { class: "crew", "aria-label": "People" });
  mount(root, h("div", { class: "home" }, sidebar, main, crew, side));

  const ROLE_TAG: Record<string, string> = { admin: "Admin", moderator: "Mod" };

  /** Right column in The Deck: who's here, online first. */
  function renderCrew() {
    crew.hidden = view.kind !== "deck";
    if (crew.hidden) return;
    const all = [...people.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
    const row = (p: Person) => {
      const inVoice = voiceRooms().find((r) => r.members.some((m) => m.user_id === p.id));
      return h("li", { class: `crew-row ${p.online ? "" : "away"}` },
        h("span", { class: "me-avatar" }, personAvatar(p, 32), p.online && h("span", { class: `online-dot sm ${p.status}` })),
        h("span", { class: "grow col min0" },
          h("span", { class: "crew-name" }, p.display_name, p.id === me.id ? " (you)" : ""),
          inVoice ? h("span", { class: "leaf small" }, `In ${inVoice.name}`)
            : p.status_text || p.status_emoji ? h("span", { class: "muted small ellipsis" }, `${p.status_emoji ?? ""} ${p.status_text ?? ""}`.trim())
            : p.online && p.status !== "online" ? h("span", { class: `small presence-${p.status}` }, PRESENCE_LABEL[p.status])
            : h("span", { class: "muted small" }, `@${p.username}`)),
        ROLE_TAG[p.role] && h("span", { class: `role-tag ${p.role}` }, ROLE_TAG[p.role]));
    };
    const online = all.filter((p) => p.online);
    const away = all.filter((p) => !p.online);
    mount(crew,
      h("h2", { class: "crew-title" }, "People"),
      h("p", { class: "sb-label" }, `Online — ${online.length}`),
      h("ul", { class: "crew-list" }, online.map(row)),
      away.length > 0 && h("p", { class: "sb-label" }, `Offline — ${away.length}`),
      away.length > 0 && h("ul", { class: "crew-list" }, away.map(row)));
  }

  const keys = loadHotkeys();

  // ─── Sidebar ─────────────────────────────────────────────────────

  function renderSidebar() {
    renderCrew();
    const online = [...people.values()].filter((p) => p.online).length;
    const inVoice = voiceRooms().reduce((n, r) => n + r.members.length, 0);
    const d = deck();
    const current = myVoiceRoom();
    mount(sidebar,
      h("header", { class: "sb-head" },
        h("img", { src: "/logo.png", alt: "", width: 44, height: 44, class: "sb-logo" }),
        h("div", { class: "grow col min0" }, h("strong", { class: "sb-title" }, treehouse.name), offline ? h("span", { class: "lantern small" }, "Reconnecting…") : h("span", { class: "muted small" }, `${online} online, ${inVoice} in voice`)),
        h("button", { class: "icon-btn", "aria-label": "Settings", title: "Settings", onclick: () => go({ name: "settings" }) }, icon("gear", 22)),
      ),
      h("nav", { class: "sb-scroll" },
        h("p", { class: "sb-label" }, "Chat"),
        d && (renaming === d.id ? renameRow(d) : h("div", { class: "sb-row-wrap" },
          h("button", { class: `sb-row ${view.kind === "deck" ? "active" : ""}`, onclick: () => show({ kind: "deck" }) },
            icon("hash", 20, "muted"), h("span", { class: "grow" }, d.slug),
            deckMentions > 0 && view.kind !== "deck" && h("span", { class: "badge lantern" }, `@${deckMentions}`)),
          me.role === "admin" && roomMenuButton(d))),
        h("p", { class: "sb-label" }, "Voice rooms"),
        voiceRooms().map((r) => [
          renaming === r.id ? renameRow(r) : h("div", { class: "sb-row-wrap" },
            h("button", { class: `sb-row ${view.kind === "voice" && view.roomId === r.id ? "active" : ""}`,
              title: r.id === call.roomId ? r.name : `${r.name}: double-click to join`,
              onclick: () => previewRoom(r), ondblclick: () => void joinRoom(r) },
              icon("speaker", 20, "muted"), h("span", { class: "grow" }, r.name),
              r.members.length > 0 && h("span", { class: "badge leaf" }, String(r.members.length))),
            me.role === "admin" && roomMenuButton(r)),
          r.members.length > 0 && h("ul", { class: "sb-members", "data-room": String(r.id) }, r.members.map((m) => {
            const p = person(m.user_id);
            const talking = r.id === call.roomId && call.speaking.includes(m.user_id);
            return h("li", { "data-user": String(m.user_id), class: talking ? "speaking" : "" },
              personAvatar(p, 24, "sb-av"),
              h("span", { class: "grow" }, p.display_name, p.id === me.id ? " (you)" : ""),
              m.screen && h("span", { title: "Sharing their screen", class: "row" }, icon("monitor", 18, "lantern")),
              m.muted && h("span", { title: "Muted", class: "row" }, icon("micOff", 18, "ember")),
              m.camera && h("span", { title: "Camera on", class: "row" }, icon("video", 18, "leaf")));
          })),
        ]),
        me.role === "admin" && newRoomControl(),
      ),
      current && h("div", { class: "sb-voice" },
        h("button", { class: "grow col sb-voice-info", title: "Open the room", onclick: () => show({ kind: "voice", roomId: current.id }) },
          call.status === "connected"
            ? h("span", { class: "leaf strong" }, h("span", { class: "dot" }), "Voice connected")
            : h("span", { class: "lantern strong" }, h("span", { class: "dot" }), call.status === "connecting" ? "Connecting…" : "Reconnecting…"),
          h("span", { class: "small" }, current.name)),
        h("button", { class: "icon-btn danger", "aria-label": "Leave voice", title: "Leave voice", onclick: () => leave() }, icon("hangup", 22))),
      h("footer", { class: "sb-me" },
        h("button", { class: "me-button", type: "button", "aria-haspopup": "menu", "aria-label": "Your status and settings", onclick: (e: Event) => statusMenu(e.currentTarget as HTMLElement) },
          h("span", { class: "me-avatar" }, personAvatar(me, 40), h("span", { class: `online-dot ${me.status}` })),
          h("span", { class: "grow col min0" }, h("strong", null, me.display_name),
            h("span", { class: "muted small ellipsis" }, me.status_text || me.status_emoji ? `${me.status_emoji ?? ""} ${me.status_text ?? ""}`.trim() : PRESENCE_LABEL[me.status]))),
        h("button", { class: `icon-btn ${call.muted ? "ember" : ""}`, "aria-pressed": String(call.muted), "aria-label": `${call.muted ? "Unmute" : "Mute"} (${formatKey(keys.mute)})`, title: `${call.muted ? "Unmute" : "Mute"} (${formatKey(keys.mute)})`, onclick: toggleMute }, icon(call.muted ? "micOff" : "mic", 22)),
        h("button", { class: `icon-btn ${call.deafened ? "ember" : ""}`, "aria-pressed": String(call.deafened), "aria-label": `${call.deafened ? "Undeafen" : "Deafen"} (${formatKey(keys.deafen)})`, title: `${call.deafened ? "Undeafen" : "Deafen"} (${formatKey(keys.deafen)})`, onclick: toggleDeafen }, icon(call.deafened ? "headphonesOff" : "headphones", 22)),
      ),
    );
  }

  // ─── Messages ────────────────────────────────────────────────────

  function renderBody(text: string, mentions: number[]): (Node | string)[] {
    const out: (Node | string)[] = [];
    const re = /(@[A-Za-z0-9_.-]+|#[a-z0-9-]+)/gi;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const tok = m[0];
      const i = m.index ?? 0;
      out.push(text.slice(last, i));
      last = i + tok.length;
      if (tok.startsWith("@")) {
        const p = [...people.values()].find((x) => x.username.toLowerCase() === tok.slice(1).toLowerCase());
        out.push(p && mentions.includes(p.id) ? h("span", { class: `mention ${p.id === me.id ? "me" : ""}` }, `@${p.display_name}`) : tok);
      } else {
        const r = rooms.find((x) => x.slug === tok.slice(1).toLowerCase());
        out.push(r ? roomChip(r) : tok);
      }
    }
    out.push(text.slice(last));
    return out;
  }

  function roomChip(r: Room) {
    const chip = h("button", { class: "room-chip", type: "button" },
      icon(r.kind === "voice" ? "speaker" : "hash", 16), r.name,
      r.kind === "voice" && r.members.length > 0 && h("span", { class: "badge leaf sm" }, `${r.members.length} in voice`));
    chip.onclick = () => (r.kind === "voice" ? roomPreview(r, chip) : show({ kind: "deck" }));
    return chip;
  }

  function roomPreview(r: Room, anchor: HTMLElement) {
    document.querySelector(".popover")?.remove();
    const rect = anchor.getBoundingClientRect();
    const full = r.capacity !== null && r.members.length >= r.capacity;
    const inIt = r.id === call.roomId;
    const pop = h("div", { class: "popover", role: "dialog", "aria-label": r.name, style: { left: `${Math.min(rect.left, innerWidth - 320)}px`, top: `${rect.bottom + 8}px` } },
      h("div", { class: "row gap-10" }, icon("speaker", 20, "lantern"), h("strong", { class: "grow" }, r.name),
        h("button", { class: "icon-btn sm", "aria-label": "Close", onclick: () => pop.remove() }, icon("close", 18))),
      h("p", { class: "muted small" }, r.members.length ? `${r.members.length} in voice${r.capacity ? ` of ${r.capacity}` : ""}` : "Nobody here yet"),
      r.members.length > 0 && h("div", { class: "row gap-6 wrap" }, r.members.map((m) => { const p = person(m.user_id); return h("span", { class: "chip" }, personAvatar(p, 20), p.display_name); })),
      h("button", { class: "btn primary sm", disabled: full && !inIt, onclick: () => { pop.remove(); void openRoom(r); } }, inIt ? "Open room" : full ? "Room is full" : "Join"),
    );
    document.body.appendChild(pop);
    const close = (e: MouseEvent) => { if (!pop.contains(e.target as Node)) { pop.remove(); removeEventListener("mousedown", close); } };
    setTimeout(() => addEventListener("mousedown", close));
  }

  function messageEl(m: Message, compact = false) {
    const p = person(m.author_id);
    const mentionsMe = m.mentions.includes(me.id);
    const canDelete = m.author_id === me.id || me.role !== "member";
    let content: Node | (Node | string)[];
    if (m.kind === "gif" && m.gif) {
      content = h("div", { class: "gif-msg" },
        h("div", { class: "gif-frame" }, h("img", { src: m.gif.url, alt: m.gif.title, loading: "lazy" }), h("span", { class: "gif-tag" }, "GIF")),
        m.gif.query && h("span", { class: "muted small" }, `/giphy ${m.gif.query}`));
    } else if (m.kind === "roll" && m.roll) {
      content = h("div", { class: "roll" }, icon("dice", 20, "lantern"), "rolled ", h("strong", { class: "roll-n" }, String(m.roll.value)), h("span", { class: "muted small" }, ` out of ${m.roll.max}`));
    } else if (m.kind === "action") {
      content = h("p", { class: "body action" }, `${p.display_name} ${m.body ?? ""}`);
    } else {
      content = h("p", { class: "body" }, renderBody(m.body ?? "", m.mentions));
    }
    // Inline "add" chip only after existing reactions (Slack-style); otherwise use the hover toolbar.
    const reactBtn = m.reactions.length > 0 && h("button", { class: "reaction add", type: "button", "aria-label": "Add reaction", title: "Add reaction" }, icon("smilePlus", 18));
    if (reactBtn) reactBtn.onclick = () => emojiPicker(reactBtn, (e) => void react(m, e, true));
    const tools = messageTools(m, p, canDelete);
    // `/me` is a status line, like "joined" or "muted": one row, no repeated header.
    if (m.kind === "action") {
      return h("article", { class: `msg status ${compact ? "compact" : ""}`, "data-id": String(m.id) },
        // Same avatar column as regular messages, so names and text line up.
        h("span", { class: "status-slot" }, personAvatar(p, 22)),
        h("div", { class: "msg-main" },
          h("p", { class: "status-line" },
            h("strong", { style: { color: p.color } }, p.display_name), " ",
            h("em", null, m.body ?? ""),
            h("time", { class: "muted small", datetime: m.created_at }, time(m.created_at))),
          m.reactions.length > 0 && h("div", { class: "reactions" },
            m.reactions.map((r) => reactionChip(m, r.emoji, r.user_ids)), reactBtn)),
        tools);
    }
    return h("article", { class: `msg ${mentionsMe ? "mentioned" : ""} ${compact ? "compact" : ""}`, "data-id": String(m.id) },
      personAvatar(p, compact ? 36 : 44),
      h("div", { class: "msg-main" },
        h("div", { class: "msg-head" }, h("strong", { style: { color: p.color } }, p.display_name), h("time", { class: "muted small", datetime: m.created_at }, time(m.created_at))),
        content,
        m.reactions.length > 0 && h("div", { class: "reactions" },
          m.reactions.map((r) => reactionChip(m, r.emoji, r.user_ids)), reactBtn),
      ),
      tools,
    );
  }

  /** Slack-style hover toolbar: recent reactions, add reaction, reply, delete. */
  function messageTools(m: Message, author: Person, canDelete: boolean) {
    const bar = h("div", { class: "msg-tools", role: "toolbar", "aria-label": "Message actions" });
    const quick = recentEmoji().map((e) => {
      const mine = m.reactions.some((r) => r.emoji === e && r.user_ids.includes(me.id));
      return h("button", { class: `tool emoji-tool ${mine ? "on" : ""}`, type: "button", title: mine ? `Remove ${e}` : `React ${e}`, "aria-label": mine ? `Remove ${e}` : `React with ${e}`,
        onclick: () => void react(m, e, !mine) }, e);
    });
    const add = h("button", { class: "tool", type: "button", title: "Add reaction", "aria-label": "Add reaction" }, icon("smilePlus", 18));
    add.onclick = () => emojiPicker(add, (e) => void react(m, e, true));
    const reply = h("button", { class: "tool", type: "button", title: `Reply to ${author.display_name}`, "aria-label": `Reply to ${author.display_name}`,
      onclick: () => replyTo(m.channel_id, author) }, icon("reply", 18));
    const del = canDelete && h("button", { class: "tool danger", type: "button", title: "Delete", "aria-label": "Delete message" }, icon("trash", 18));
    if (del) del.onclick = () => confirmDelete(m, bar);
    mount(bar, quick, h("span", { class: "tool-sep" }), add, author.id !== me.id && reply, del);
    return bar;
  }

  /** Reply = mention them in the message box (Treehouse has no threads). */
  function replyTo(channel: number, author: Person) {
    const input = composerInputs.get(channel);
    if (!input) return;
    const tag = `@${author.username} `;
    if (!input.value.startsWith(tag)) input.value = tag + input.value.replace(/^\s+/, "");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** "You", "Ana and Leo", "You, Ana and 3 others" — who reacted, you first. */
  function reactedBy(userIds: number[]): string {
    const names = [...userIds].sort((a, b) => Number(b === me.id) - Number(a === me.id))
      .map((id) => (id === me.id ? "You" : person(id).display_name));
    if (names.length > 4) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} others`;
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
  }

  function reactionChip(m: Message, emoji: string, userIds: number[]) {
    const mine = userIds.includes(me.id);
    const who = `${reactedBy(userIds)} reacted`;
    return h("button", { class: `reaction ${mine ? "mine" : ""}`, "aria-pressed": String(mine), "aria-label": `${emoji} ${userIds.length}: ${who}`,
      "data-tip": who, onclick: () => void react(m, emoji, !mine) },
      h("span", { class: "emoji" }, emoji), String(userIds.length));
  }

  async function react(m: Message, emoji: string, on: boolean) {
    if (on) rememberEmoji(emoji);
    try {
      m.reactions = await api.react(m.id, emoji, on);
      refreshLists(m.channel_id);
    } catch (e) { toast(errorText(e), "error"); }
  }

  /** Ask in place before deleting: the bin turns into "Delete for everyone? Delete / Cancel". */
  function confirmDelete(m: Message, actions: HTMLElement) {
    const kids = [...actions.childNodes];
    const restore = () => { actions.classList.remove("confirming"); mount(actions, kids); document.removeEventListener("keydown", onEsc, true); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); restore(); } };
    const yes = h("button", { class: "btn danger sm", type: "button" }, "Delete");
    yes.onclick = async () => {
      yes.disabled = true;
      try {
        await api.deleteMessage(m.id);
        document.removeEventListener("keydown", onEsc, true);
        removeMessage(m.channel_id, m.id);
      } catch (e) { toast(errorText(e), "error"); restore(); }
    };
    actions.classList.add("confirming");
    mount(actions,
      h("span", { class: "small" }, m.author_id === me.id ? "Delete for everyone?" : "Delete their message?"),
      yes,
      h("button", { class: "btn ghost sm", type: "button", onclick: restore }, "Cancel"));
    document.addEventListener("keydown", onEsc, true);
    yes.focus();
  }

  /** Message boxes on screen, by channel (for Reply). */
  const composerInputs = new Map<number, HTMLInputElement>();

  /** Message lists currently on screen, by channel. */
  const lists = new Map<number, { el: HTMLElement; compact: boolean }>();

  function messageList(channel: number, compact: boolean) {
    const el = h("div", { class: "messages", role: "log", "aria-live": "polite" });
    // Stay pinned to the newest message while it's in view, also when GIFs finish loading.
    el.addEventListener("scroll", () => { el.dataset.stick = String(el.scrollHeight - el.scrollTop - el.clientHeight < 80); });
    el.addEventListener("load", () => { if (el.dataset.stick !== "false") el.scrollTop = el.scrollHeight; }, true);
    lists.set(channel, { el, compact });
    if (cache.has(channel)) fillList(channel);
    else {
      mount(el, h("p", { class: "muted center pad" }, "Loading…"));
      api.messages(channel).then((ms) => { cache.set(channel, ms); fillList(channel); })
        .catch((e) => mount(el, h("p", { class: "muted center pad" }, errorText(e))));
    }
    return el;
  }

  function fillList(channel: number) {
    const l = lists.get(channel);
    if (!l) return;
    const stick = l.el.dataset.stick !== "false";
    const top = l.el.scrollTop;
    const ms = cache.get(channel) ?? [];
    mount(l.el, ms.length ? ms.map((m) => messageEl(m, l.compact)) : h("p", { class: "muted center pad" }, "No messages yet. Say hi."));
    requestAnimationFrame(() => (l.el.scrollTop = stick ? l.el.scrollHeight : top));
  }

  const refreshLists = (channel: number) => { if (lists.has(channel)) fillList(channel); };

  function addMessage(m: Message) {
    const list = cache.get(m.channel_id);
    if (list && !list.some((x) => x.id === m.id)) {
      list.push(m);
      refreshLists(m.channel_id);
    }
  }

  /** Dissolve the message out (blur, fade, collapse), then drop it. Also used when someone else deletes. */
  function removeMessage(channel: number, id: number) {
    const list = cache.get(channel);
    if (!list) return;
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    const el = lists.get(channel)?.el.querySelector<HTMLElement>(`.msg[data-id="${id}"]`);
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) { refreshLists(channel); return; }
    el.style.maxHeight = `${el.offsetHeight}px`;
    void el.offsetHeight; // start the transition from the real height
    el.classList.add("dissolving");
    setTimeout(() => refreshLists(channel), 420);
  }

  // ─── Composer and pickers ────────────────────────────────────────

  function composer(channel: number, placeholder: string) {
    const input = h("input", { class: "composer-input", placeholder, "aria-label": placeholder, maxlength: 2000, autocomplete: "off" });
    composerInputs.set(channel, input);
    const pop = h("div", { class: "composer-pop", hidden: true });
    const emojiBtn = h("button", { class: "icon-btn square", type: "button", "aria-label": "Emoji", title: "Emoji" }, icon("smile", 24));
    const sendBtn = h("button", { class: "icon-btn square send", type: "submit", "aria-label": "Send", title: "Send" }, icon("send", 24));
    let slashIndex = 0;

    const closePop = () => { pop.hidden = true; pop.replaceChildren(); };

    const slashMatches = () => {
      const v = input.value;
      if (!v.startsWith("/") || v.includes(" ")) return [];
      return COMMANDS.filter((c) => c.name.startsWith(v.slice(1).toLowerCase()));
    };

    const renderSlash = () => {
      const list = slashMatches();
      if (!list.length) { if (pop.dataset.kind === "slash") closePop(); return; }
      slashIndex = Math.min(slashIndex, list.length - 1);
      pop.dataset.kind = "slash";
      pop.hidden = false;
      mount(pop, h("p", { class: "pop-title" }, "Commands"), list.map((c, i) =>
        h("button", { type: "button", class: `cmd ${i === slashIndex ? "active" : ""}`, onmousedown: (e: Event) => { e.preventDefault(); pick(c.name); } },
          h("span", null, h("strong", { class: "lantern" }, `/${c.name}`), c.arg && h("span", { class: "muted" }, ` ${c.arg}`)),
          h("span", { class: "cmd-help" }, c.help))));
    };

    const pick = (name: string) => {
      input.value = `/${name} `;
      closePop();
      input.focus();
    };

    // ── @person and #room suggestions for the word at the cursor.
    type Suggestion = { insert: string; title: string; hint: string; face?: HTMLElement };
    let suggestIndex = 0;
    const tokenAtCursor = () => {
      const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
      const m = upto.match(/(?:^|\s)([@#])([\w.-]*)$/);
      return m ? { sigil: m[1], query: m[2].toLowerCase(), start: upto.length - m[1].length - m[2].length } : null;
    };
    const suggestions = (): Suggestion[] => {
      const t = tokenAtCursor();
      if (!t) return [];
      if (t.sigil === "@") {
        return [...people.values()]
          .filter((p) => p.id !== me.id && (p.username.toLowerCase().startsWith(t.query) || p.display_name.toLowerCase().includes(t.query)))
          .sort((a, b) => Number(b.online) - Number(a.online) || a.display_name.localeCompare(b.display_name))
          .slice(0, 6)
          .map((p) => ({ insert: `@${p.username}`, title: p.display_name, hint: `@${p.username}${p.online ? "" : " · offline"}`, face: personAvatar(p, 24) }));
      }
      return rooms
        .filter((r) => r.slug.toLowerCase().startsWith(t.query) || r.name.toLowerCase().includes(t.query))
        .slice(0, 6)
        .map((r) => ({ insert: `#${r.slug}`, title: r.name, hint: r.kind === "voice" ? (r.members.length ? `#${r.slug} · ${r.members.length} in voice` : `#${r.slug}`) : `#${r.slug}` }));
    };
    const renderSuggest = () => {
      const list = suggestions();
      if (!list.length) { if (pop.dataset.kind === "suggest") closePop(); return; }
      suggestIndex = Math.min(suggestIndex, list.length - 1);
      pop.dataset.kind = "suggest";
      pop.hidden = false;
      const sigil = tokenAtCursor()?.sigil;
      mount(pop, h("p", { class: "pop-title" }, sigil === "@" ? "People" : "Rooms"), list.map((s, i) =>
        h("button", { type: "button", class: `cmd suggest ${i === suggestIndex ? "active" : ""}`, onmousedown: (e: Event) => { e.preventDefault(); takeSuggestion(s); } },
          s.face ?? icon(s.insert.startsWith("#") ? "speaker" : "hash", 20, "muted"),
          h("span", { class: "grow col" }, h("strong", null, s.title), h("span", { class: "muted small" }, s.hint)))));
    };
    const takeSuggestion = (s: Suggestion) => {
      const t = tokenAtCursor();
      if (!t) return;
      const end = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, t.start)}${s.insert} ${input.value.slice(end)}`;
      const caret = t.start + s.insert.length + 1;
      input.setSelectionRange(caret, caret);
      closePop();
      input.focus();
    };

    const gifPicker = async (q: string) => {
      pop.dataset.kind = "gif";
      pop.hidden = false;
      const grid = h("div", { class: "gif-grid" }, h("p", { class: "muted pad" }, "Looking for GIFs…"));
      // The server sends one batch; Shuffle deals the next 9 from it in random order.
      let all: Gif[] = [];
      let dealt = 0;
      const show = () => {
        if (dealt >= all.length) {
          all = all.map((g) => [Math.random(), g] as const).sort((a, b) => a[0] - b[0]).map(([, g]) => g);
          dealt = 0;
        }
        const gifs = all.slice(dealt, dealt + 9);
        dealt += 9;
        shuffleBtn.hidden = all.length <= 9;
        mount(grid, gifs.length ? gifs.map((g) => h("button", { type: "button", class: "gif-pick", "aria-label": `Send ${g.title}`, onclick: () => void sendGif(g) }, h("img", { src: g.preview_url, alt: g.title }))) : h("p", { class: "muted pad" }, "No GIFs for that. Try other words."));
      };
      const load = async () => {
        try {
          all = await api.gifs(q);
          dealt = all.length; // start with a fresh random deal
          show();
        } catch (e) { mount(grid, h("p", { class: "muted pad" }, errorText(e))); }
      };
      const shuffleBtn = h("button", { class: "btn ghost sm", type: "button", hidden: true, onclick: show }, "Shuffle");
      mount(pop,
        h("div", { class: "row between pop-head" }, h("strong", null, `GIFs for “${q}”`),
          h("div", { class: "row gap-10" }, shuffleBtn,
            h("button", { class: "icon-btn sm", type: "button", "aria-label": "Close", onclick: closePop }, icon("close", 20)))),
        grid,
        h("p", { class: "giphy-credit" }, "Powered by GIPHY"));
      await load();
    };

    const sendGif = async (g: Gif) => {
      const query = input.value.replace(/^\/giphy\s*/i, "").trim();
      closePop();
      input.value = "";
      await post({ client_id: crypto.randomUUID(), gif_id: g.id, gif_query: query });
    };

    const post = async (body: { client_id: string; text?: string; gif_id?: string; gif_query?: string }) => {
      try {
        addMessage(await api.send(channel, body));
      } catch (e) { toast(errorText(e), "error"); }
    };

    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      const giphy = text.match(/^\/giphy\s+(.+)/i);
      if (giphy) return gifPicker(giphy[1]);
      if (/^\/giphy$/i.test(text)) { toast("Add some words after /giphy, like “/giphy gg”."); return; }
      input.value = "";
      closePop();
      await post({ client_id: crypto.randomUUID(), text });
    };

    input.addEventListener("input", () => {
      slashIndex = 0;
      suggestIndex = 0;
      renderSlash();
      if (pop.dataset.kind !== "slash" || pop.hidden) renderSuggest();
    });
    input.addEventListener("keydown", (e) => {
      if (pop.dataset.kind === "suggest" && !pop.hidden) {
        const list = suggestions();
        if (!list.length) return;
        if (e.key === "Escape") { e.preventDefault(); closePop(); return; }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          suggestIndex = (suggestIndex + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
          renderSuggest();
        } else if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          takeSuggestion(list[suggestIndex]);
        }
        return;
      }
      const list = pop.dataset.kind === "slash" && !pop.hidden ? slashMatches() : [];
      if (e.key === "Escape") { closePop(); return; }
      if (!list.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
        renderSlash();
      } else if (e.key === "Tab" || (e.key === "Enter" && list[slashIndex] && `/${list[slashIndex].name}` !== input.value.trim())) {
        e.preventDefault();
        pick(list[slashIndex].name);
      }
    });
    emojiBtn.onclick = () => emojiPicker(emojiBtn, (emoji) => {
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + emoji + input.value.slice(input.selectionEnd ?? at);
      input.focus();
      input.setSelectionRange(at + emoji.length, at + emoji.length);
    });

    return h("form", { class: "composer", onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
      pop, h("div", { class: "composer-field" }, input), emojiBtn, sendBtn);
  }

  function emojiPicker(anchor: HTMLElement, onPick: (e: string) => void) {
    document.querySelector(".emoji-pop")?.remove();
    const rect = anchor.getBoundingClientRect();
    const pop = h("div", { class: "emoji-pop", role: "dialog", "aria-label": "Pick an emoji" },
      EMOJI.map((e) => h("button", { type: "button", class: "emoji-btn", onclick: () => { onPick(e); pop.remove(); } }, e)));
    const top = rect.top > 300 ? rect.top - 8 : rect.bottom + 8;
    Object.assign(pop.style, { left: `${Math.max(12, Math.min(rect.right - 320, innerWidth - 332))}px`, top: `${top}px`, transform: rect.top > 300 ? "translateY(-100%)" : "none" });
    document.body.appendChild(pop);
    const close = (ev: MouseEvent) => { if (!pop.contains(ev.target as Node) && ev.target !== anchor) { pop.remove(); removeEventListener("mousedown", close); } };
    setTimeout(() => addEventListener("mousedown", close));
  }

  // ─── Main views ──────────────────────────────────────────────────

  function ttlText() {
    const hrs = treehouse.message_ttl_hours;
    return hrs % 24 === 0 ? `${hrs / 24} day${hrs === 24 ? "" : "s"}` : `${hrs} hours`;
  }

  function renderMain() {
    lists.clear();
    if (view.kind === "deck") {
      const d = deck();
      if (!d) { mount(main, h("p", { class: "muted center pad" }, "Loading…")); return; }
      mount(main,
        h("header", { class: "main-head" },
          h("span", { class: "head-hash" }, icon("hash", 32)),
          h("div", { class: "col" }, h("h1", { class: "title" }, d.slug), h("p", { class: "muted" }, `Everyone’s hangout chat. Messages disappear after ${ttlText()}.`))),
        messageList(d.id, false),
        composer(d.id, "Message #the-deck"));
      side.hidden = true;
      return;
    }
    const room = rooms.find((r) => r.id === (view as { roomId: number }).roomId);
    if (!room && !rooms.length) { mount(main, h("p", { class: "muted center pad" }, "Loading…")); return; }
    if (!room) { show({ kind: "deck" }); return; }
    stageSub = h("p", { class: "muted" });
    stageEl = h("section", { class: "stage", "aria-label": `People in ${room.name}` });
    barEl = h("div", { class: "call-bar", role: "toolbar", "aria-label": "Call controls" });
    problemEl = h("div", { class: "call-problem", role: "alert", hidden: true });
    // Previewing: just "Join voice" top-right. In the call: room chat and Leave.
    const inCall = call.roomId === room.id;
    headerFor = inCall ? room.id : null;
    const full = room.capacity !== null && room.members.length >= room.capacity;
    mount(main,
      h("header", { class: "main-head" },
        h("div", { class: "col grow" }, h("h1", { class: "title" }, room.name), stageSub),
        inCall
          ? [h("button", { class: `btn outline-lantern ${roomChatOpen ? "on" : ""}`, "aria-pressed": String(roomChatOpen), onclick: () => { roomChatOpen = !roomChatOpen; renderMain(); } }, icon("chat", 20), "Room chat"),
             h("button", { class: "btn outline-ember", onclick: () => void leave() }, "Leave")]
          : h("button", { class: "btn primary", disabled: full, title: full ? undefined : "Or double-click the room", onclick: () => void joinRoom(room) }, icon("speaker", 20), full ? "Room is full" : "Join voice")),
      stageEl, problemEl, barEl);
    renderStage();
    renderBar();
    renderProblem();
    side.hidden = !(roomChatOpen && inCall);
    if (roomChatOpen && inCall) {
      mount(side,
        h("header", { class: "rc-head" },
          h("div", { class: "col grow" }, h("h2", { class: "rc-title" }, "Room chat"), h("p", { class: "muted small" }, `Only for people in ${room.name}. Cleared when everyone leaves.`)),
          h("button", { class: "icon-btn", "aria-label": "Close room chat", onclick: () => { roomChatOpen = false; renderMain(); } }, icon("close", 22))),
        messageList(room.id, true),
        composer(room.id, "Message the room"));
    }
  }

  // ─── Voice stage ─────────────────────────────────────────────────

  let stageEl: HTMLElement | null = null;
  let headerFor: number | null = null;
  let stageSub: HTMLElement | null = null;
  let barEl: HTMLElement | null = null;
  let problemEl: HTMLElement | null = null;
  /** Video elements by track, kept across re-renders so playing video doesn't flicker. */
  const videoEls = new Map<Video["track"], HTMLVideoElement>();

  const viewedRoom = () => (view.kind === "voice" ? rooms.find((r) => r.id === (view as { roomId: number }).roomId) : undefined);

  /** Server membership, plus anyone LiveKit already shows in your call before the server catches up. */
  function stageMembers(room: Room): VoiceMember[] {
    const list = room.members.map((m) => ({ ...m }));
    if (call.roomId !== room.id) return list;
    for (const p of call.participants()) {
      const m = list.find((x) => x.user_id === p.userId);
      if (!m) list.push({ user_id: p.userId, muted: p.muted, camera: p.camera, screen: p.screen });
      else if (p.local) Object.assign(m, { muted: call.muted, camera: call.camera, screen: call.screen });
    }
    return list;
  }

  function videoEl(v: Video): HTMLVideoElement {
    let el = videoEls.get(v.track);
    if (!el) {
      el = v.track.attach() as HTMLVideoElement;
      el.muted = true;
      el.playsInline = true;
      el.autoplay = true;
      videoEls.set(v.track, el);
    }
    el.className = `tile-video ${v.source === "screen" ? "screen" : ""} ${v.local && v.source === "camera" ? "mirror" : ""}`;
    return el;
  }

  /** "4 in voice, Ana is talking" */
  function talkingText(members: VoiceMember[]): string {
    const n = members.length;
    if (!n) return "Nobody here yet";
    const names = call.speaking
      .filter((id) => members.some((m) => m.user_id === id))
      .map((id) => (id === me.id ? "you" : person(id).display_name));
    if (!names.length) return `${n} in voice`;
    if (names.length === 1) return `${n} in voice, ${names[0]} ${names[0] === "you" ? "are" : "is"} talking`;
    return `${n} in voice, ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are talking`;
  }

  // Tiles are keyed and reused: an update changes icons and classes in place and
  // never re-inserts a <video>, which is what made pictures blink on mute/unmute.
  const tileCache = new Map<string, HTMLElement>();
  let usedTiles = new Set<string>();

  /** Put `desired` in `parent` in order, moving only nodes that are out of place. */
  function syncChildren(parent: Element, desired: Node[]) {
    desired.forEach((n, i) => { if (parent.childNodes[i] !== n) parent.insertBefore(n, parent.childNodes[i] ?? null); });
    while (parent.childNodes.length > desired.length) parent.lastChild?.remove();
  }

  function cached(key: string, make: () => HTMLElement): HTMLElement {
    usedTiles.add(key);
    let el = tileCache.get(key);
    if (!el) { el = make(); tileCache.set(key, el); }
    return el;
  }

  function personTile(m: VoiceMember, cam: Video | undefined, strip = false) {
    const p = person(m.user_id);
    const you = p.id === me.id;
    const key = `p:${m.user_id}:${cam ? cam.track.sid ?? "cam" : "-"}:${strip ? "s" : "b"}:${p.display_name}:${p.avatar ?? ""}:${p.color}`;
    const el = cached(key, () => h("div", { class: "tile", "data-user": String(m.user_id), style: { background: `color-mix(in srgb, ${p.color} 22%, #182238)` } },
      cam ? videoEl(cam) : personAvatar(p, 0, "huge"),
      cam && !strip && h("span", { class: "live" }, h("span", { class: "dot" }), "Live"),
      h("div", { class: "tile-bar" })));
    const speaking = call.roomId !== null && call.speaking.includes(m.user_id);
    el.className = `tile ${cam ? "camera" : ""} ${speaking ? "speaking" : ""} ${strip ? "small" : ""}`;
    el.querySelector(".avatar.huge")?.classList.toggle("dim", m.muted);
    const bar = el.querySelector(".tile-bar");
    const state = `${m.muted}|${m.camera}|${m.screen}`;
    if (bar instanceof HTMLElement && bar.dataset.state !== state) {
      bar.dataset.state = state;
      mount(bar,
        personAvatar(p, strip ? 22 : 28),
        h("strong", { class: "grow ellipsis" }, p.display_name, you ? " (you)" : ""),
        m.screen && h("span", { class: "tile-ic on", title: "Sharing their screen" }, icon("monitor", 18)),
        h("span", { class: `tile-ic ${m.muted ? "off" : ""}`, title: m.muted ? "Muted" : "Mic on" }, icon(m.muted ? "micOff" : "mic", 18)),
        !strip && h("span", { class: `tile-ic ${m.camera ? "on" : ""}`, title: m.camera ? "Camera on" : "Camera off" }, icon(m.camera ? "video" : "videoOff", 18)));
    }
    return el;
  }

  function screenTile(v: Video, large: boolean) {
    const label = v.userId === me.id ? "Your screen" : `${person(v.userId).display_name}’s screen`;
    const sound = call.screenHasSound(v.userId);
    return cached(`s:${v.userId}:${v.track.sid ?? ""}:${large ? "big" : "small"}:${sound}`, () => {
      const bar = h("div", { class: "tile-bar" }, icon("monitor", 18, "lantern"), h("strong", { class: "grow ellipsis" }, label),
        sound && h("span", { class: "sound-badge", title: "Everyone hears this screen’s sound" }, icon("volume", 16), "With sound"));
      if (large) return h("div", { class: "tile screen-tile spot", "aria-label": label }, videoEl(v), bar);
      return h("button", { class: "tile screen-tile small", type: "button", title: "Show large", "aria-label": `Show ${label.toLowerCase()} large`,
        onclick: () => { spotlight = v.userId; renderStage(); } }, videoEl(v), bar);
    });
  }

  let stripEl: HTMLElement | null = null;
  let noteEl: HTMLElement | null = null;
  let emptyEl: HTMLElement | null = null;

  function renderStage() {
    const room = viewedRoom();
    if (!room || !stageEl?.isConnected) return;
    const members = stageMembers(room);
    const here = call.roomId === room.id;
    const vids = here ? call.videos() : [];
    // Let go of video elements whose track is gone.
    for (const [track, el] of videoEls) {
      if (!vids.some((v) => v.track === track)) { track.detach(el); el.remove(); videoEls.delete(track); }
    }
    const cams = new Map(vids.filter((v) => v.source === "camera").map((v) => [v.userId, v]));
    const screens = vids.filter((v) => v.source === "screen");
    if (stageSub) stageSub.textContent = talkingText(members);
    usedTiles = new Set();

    const noteText = !here ? ""
      : call.status === "connecting" ? "Connecting…"
      : call.status === "reconnecting" ? "Connection lost. Reconnecting…"
      : call.weak ? "Your connection is weak. Video may look blurry."
      : "";
    noteEl ??= h("p", { class: "stage-note" });
    noteEl.textContent = noteText;
    const note = noteText ? noteEl : null;

    if (screens.length) {
      // Spotlight: one screen large, people (and other screens) in a strip below. Click one to swap.
      const big = screens.find((v) => v.userId === spotlight) ?? screens[0];
      spotlight = big.userId;
      stageEl.className = "stage spotlight";
      stageEl.removeAttribute("style");
      stripEl ??= h("div", { class: "strip" });
      const bigTile = screenTile(big, true);
      syncChildren(stripEl, [...screens.filter((v) => v !== big).map((v) => screenTile(v, false)), ...members.map((m) => personTile(m, cams.get(m.user_id), true))]);
      syncChildren(stageEl, [note, bigTile, stripEl].filter((n): n is HTMLElement => !!n));
    } else {
      const n = members.length;
      // 1 fills the stage, 2 side by side, 3–4 a 2×2 grid, 5–6 a 3×2 grid, more in rows of 4.
      const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
      const rowsN = Math.max(1, Math.ceil(n / cols));
      stageEl.className = "stage";
      Object.assign(stageEl.style, { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rowsN}, minmax(0, 1fr))` });
      emptyEl ??= h("p", { class: "muted center" }, "Nobody here yet.");
      syncChildren(stageEl, [note, ...members.map((m) => personTile(m, cams.get(m.user_id))), n === 0 ? emptyEl : null].filter((x): x is HTMLElement => !!x));
    }
    for (const key of [...tileCache.keys()]) if (!usedTiles.has(key)) tileCache.delete(key);
    // A video that did have to move can pause; start it again.
    for (const el of videoEls.values()) if (el.paused) void el.play().catch(() => {});
  }

  /** Talking changes many times a second: flip classes instead of rebuilding tiles. */
  function renderSpeaking() {
    const talking = new Set(call.speaking);
    const viewingCall = viewedRoom()?.id === call.roomId;
    for (const el of document.querySelectorAll<HTMLElement>(".stage [data-user]")) {
      el.classList.toggle("speaking", viewingCall && talking.has(Number(el.dataset.user)));
    }
    for (const el of document.querySelectorAll<HTMLElement>(`.sb-members[data-room="${call.roomId}"] [data-user]`)) {
      el.classList.toggle("speaking", talking.has(Number(el.dataset.user)));
    }
    const room = viewedRoom();
    if (room && stageSub) stageSub.textContent = talkingText(stageMembers(room));
  }

  /** Before sharing: what it's for decides the quality and whether sound goes along (remembered for next time). */
  function shareMenu(anchor: HTMLElement) {
    document.querySelector(".share-menu")?.remove();
    const r = anchor.getBoundingClientRect();
    const menu = h("div", { class: "status-menu share-menu", role: "menu", style: { left: `${Math.max(12, r.left + r.width / 2 - 150)}px`, bottom: `${innerHeight - r.top + 10}px` } });
    const close = () => { menu.remove(); removeEventListener("mousedown", outside, true); removeEventListener("keydown", esc, true); };
    const outside = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && e.target !== anchor) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const canSound = call.screenSoundAvailable;
    // The switch shows the remembered choice for the option you're about to pick,
    // until you flip it yourself; then your choice goes with whichever you pick.
    let touched = false;
    const box = h("input", { type: "checkbox", checked: prefs.screenSound(prefs.screenMode) }) as HTMLInputElement;
    const soundNote = h("span", null);
    const showNote = () => {
      soundNote.textContent = !canSound
        ? "Only the picture is shared on this Mac."
        : box.checked ? "Everyone hears what you share." : "Only the picture is shared.";
    };
    box.addEventListener("change", () => { touched = true; showNote(); });
    const preview = (mode: "text" | "motion") => { if (!touched) { box.checked = prefs.screenSound(mode); showNote(); } };
    showNote();
    const option = (mode: "text" | "motion", title: string, hint: string) =>
      h("button", { class: `sm-item share-opt ${prefs.screenMode === mode ? "on" : ""}`, type: "button", role: "menuitem",
        onmouseenter: () => preview(mode), onfocus: () => preview(mode),
        onclick: () => {
          prefs.screenMode = mode;
          if (canSound) prefs.setScreenSound(mode, touched ? box.checked : prefs.screenSound(mode));
          close();
          void call.setScreenShare(true);
        } },
        h("span", { class: "grow col" }, h("strong", null, title), h("span", { class: "muted small" }, hint)),
        prefs.screenMode === mode && h("span", { class: "lantern" }, "✓"));
    mount(menu,
      h("p", { class: "share-title" }, "Share your screen for"),
      option("text", "Reading together", "Sharp text: docs, code, websites (1080p, 15 fps)"),
      option("motion", "Watching or playing", "Smooth motion: videos and games (1080p, 30 fps)"),
      canSound && h("label", { class: "toggle-row share-sound-toggle" },
        h("span", { class: "grow col" }, h("span", null, "Include my computer’s sound"), h("span", { class: "muted small" }, soundNote)),
        box, h("span", { class: "switch", "aria-hidden": "true" })),
      !canSound && h("p", { class: "share-sound muted small" }, icon("volumeOff", 16), soundNote),
      h("p", { class: "share-sound muted small" }, icon("monitorOff", 16), "Streaming services like Netflix show a black picture when shared."));
    document.body.appendChild(menu);
    setTimeout(() => { addEventListener("mousedown", outside, true); addEventListener("keydown", esc, true); });
  }

  function renderBar() {
    const room = viewedRoom();
    if (!room || !barEl) return;
    if (call.roomId !== room.id) { mount(barEl); return; } // Join lives in the header
    const live = call.status === "connected";
    const btn = (label: string, ic: keyof typeof icons, cls: string, pressed: boolean | null, onclick: () => void, disabled = false) =>
      h("button", { class: `call-btn ${cls}`, type: "button", title: label, "aria-label": label, "aria-pressed": pressed === null ? undefined : String(pressed), disabled, onclick }, icon(ic, 24));
    mount(barEl,
      btn(`${call.muted ? "Unmute" : "Mute"} (${formatKey(keys.mute)})`, call.muted ? "micOff" : "mic", call.muted ? "off" : "", call.muted, toggleMute),
      btn(call.camera ? "Turn camera off" : "Turn camera on", call.camera ? "video" : "videoOff", call.camera ? "on" : "off", call.camera, () => void call.setCamera(!call.camera), !live),
      btn(call.screen ? "Stop sharing" : "Share your screen", call.screen ? "monitorOff" : "monitor", call.screen ? "on" : "", call.screen, (e?: Event) => { if (call.screen) void call.setScreenShare(false); else shareMenu((e?.currentTarget as HTMLElement) ?? barEl!); }, !live),
      popout.available && btn(popout.open ? "Close the people window" : "Pop out people", "popout", popout.open ? "on" : "", popout.open, () => popout.toggle(), !live && !popout.open),
      btn("Leave", "hangup", "leave", null, () => void leave()));
  }

  // ─── Room admin (admins only; the server checks too) ─────────────

  let renaming: number | null = null;
  let creating = false;

  function renameRow(r: Room) {
    const input = h("input", { class: "sb-input", value: r.name, maxlength: 40, "aria-label": `New name for ${r.name}` });
    let finished = false;
    const done = async (save: boolean) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      renaming = null;
      if (save && name && name !== r.name) {
        try { await api.updateRoom(r.id, { name }); } catch (e) { toast(errorText(e), "error"); }
      }
      renderSidebar();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void done(true); if (e.key === "Escape") void done(false); });
    input.addEventListener("blur", () => void done(true));
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return h("div", { class: "sb-row editing" }, icon(r.kind === "deck" ? "hash" : "speaker", 20, "muted"), input);
  }

  function roomMenuButton(r: Room) {
    const btn = h("button", { class: "sb-more", type: "button", "aria-label": `${r.name} options`, title: "Room options" }, icon("more", 18));
    btn.onclick = (e) => { e.stopPropagation(); roomMenu(r, btn); };
    return btn;
  }

  function roomMenu(r: Room, anchor: HTMLElement) {
    document.querySelector(".room-menu")?.remove();
    const rect = anchor.getBoundingClientRect();
    const menu = h("div", { class: "status-menu room-menu", role: "menu", style: { left: `${rect.left}px`, top: `${rect.bottom + 6}px` } });
    const close = () => { menu.remove(); removeEventListener("mousedown", outside, true); removeEventListener("keydown", esc, true); };
    const outside = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const busy = r.members.length;
    const draw = (confirming = false) => mount(menu,
      h("div", { class: "sm-head col start" }, h("strong", null, r.name),
        r.kind === "voice" && h("span", { class: "muted small" }, r.last_used_at ? `Last used ${ago(r.last_used_at)}` : "Not used yet")),
      r.kind === "voice" && sizeSlider(r),
      h("button", { class: "sm-item", type: "button", role: "menuitem", onclick: () => { close(); renaming = r.id; renderSidebar(); } }, "Rename"),
      r.kind === "voice" && (confirming
        ? h("div", { class: "sm-confirm" },
            h("p", { class: "small" }, busy ? `${busy} ${busy === 1 ? "person is" : "people are"} in ${r.name}. They’ll be moved to The Deck.` : `Delete ${r.name}? Its chat goes too.`),
            h("div", { class: "row gap-6" },
              h("button", { class: "btn danger sm", type: "button", onclick: async () => {
                try { await api.deleteRoom(r.id, busy > 0); close(); if (view.kind === "voice" && view.roomId === r.id) show({ kind: "deck" }); }
                catch (e) { toast(errorText(e), "error"); }
              } }, busy ? "Move everyone and delete" : "Delete"),
              h("button", { class: "btn ghost sm", type: "button", onclick: () => draw(false) }, "Cancel")))
        : h("button", { class: "sm-item danger", type: "button", role: "menuitem", onclick: () => draw(true) },
            busy ? "Move everyone to The Deck and delete…" : "Delete room…")));
    draw();
    document.body.appendChild(menu);
    setTimeout(() => { addEventListener("mousedown", outside, true); addEventListener("keydown", esc, true); });
  }

  /** Room size 2–10: shows the number while dragging, saves on release. */
  function sizeSlider(r: Room) {
    const value = r.capacity ?? 10;
    const out = h("strong", { class: "lantern" }, `${value} people`);
    const input = h("input", { type: "range", class: "range", min: 2, max: 10, step: 1, value, "aria-label": "Room size" });
    const paint = () => { input.style.setProperty("--fill", `${((Number(input.value) - 2) / 8) * 100}%`); out.textContent = `${input.value} people`; };
    input.addEventListener("input", paint);
    input.addEventListener("change", async () => {
      const n = Number(input.value);
      if (n === r.capacity) return;
      try { await api.updateRoom(r.id, { capacity: n }); }
      catch (e) { toast(errorText(e), "error"); input.value = String(r.capacity ?? 10); paint(); }
    });
    paint();
    return h("div", { class: "sm-group size-group" },
      h("div", { class: "row between sm-sub" }, h("span", { class: "muted small" }, "Room size"), out),
      h("div", { class: "size-row" }, input),
      r.members.length > 0 && h("span", { class: "muted small sm-sub" }, `${r.members.length} in the room now`));
  }

  function newRoomControl() {
    const count = voiceRooms().length;
    if (count >= treehouse.max_voice_rooms) {
      return h("p", { class: "muted small sb-note" }, `You have ${count} rooms. Delete one to add another.`);
    }
    if (!creating) {
      return h("button", { class: "sb-add", type: "button", onclick: () => { creating = true; renderSidebar(); } }, "+ New room");
    }
    const input = h("input", { class: "sb-input", maxlength: 40, placeholder: "Room name", "aria-label": "New room name" });
    const done = async (save: boolean) => {
      const name = input.value.trim();
      if (!creating) return;
      creating = false;
      if (save && name) {
        try { await api.createRoom({ name }); } catch (e) { toast(errorText(e), "error"); }
      }
      renderSidebar();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void done(true); if (e.key === "Escape") void done(false); });
    input.addEventListener("blur", () => void done(true));
    requestAnimationFrame(() => input.focus());
    return h("div", { class: "sb-row editing" }, icon("speaker", 20, "muted"), input);
  }

  // ─── Capture problems (denied, missing, unsupported) ─────────────

  const isMac = navigator.userAgent.includes("Mac");
  const inApp = "__TAURI_INTERNALS__" in window;

  function problemText(p: NonNullable<typeof problem>): { title: string; body: string } {
    const thing = p.kind === "screen" ? "screen share" : p.kind;
    if (p.sound) {
      // The picture is shared; only the computer's sound isn't.
      return p.problem === "denied"
        ? { title: "Your screen is shared without sound", body: "Allow Treehouse in System Settings → Privacy & Security → Screen & System Audio Recording, restart Treehouse, then share again." }
        : { title: "Your screen is shared without sound", body: "Only the picture is shared on this Mac." };
    }
    if (p.problem === "unsupported") return { title: "Screen sharing doesn’t work here yet", body: "This system doesn’t let apps share the screen. Update it, then try again." };
    if (p.problem === "missing") {
      return p.kind === "microphone"
        ? { title: "No microphone found", body: "Plug one in or pick another in Settings → Sound, then unmute." }
        : { title: "No camera found", body: "Plug one in, then turn the camera on again." };
    }
    if (p.problem === "failed") return { title: `Couldn’t start your ${thing}`, body: "Close other apps that may be using it, then try again." };
    if (p.kind === "screen") {
      return isMac
        ? { title: "Treehouse can’t share your screen", body: "Allow it in System Settings → Privacy & Security → Screen & System Audio Recording, restart Treehouse, then share again." }
        : { title: "Screen sharing didn’t start", body: "Try again and pick a screen or window to share." };
    }
    const pane = p.kind === "camera" ? "Camera" : "Microphone";
    return {
      title: `Treehouse can’t use your ${p.kind}`,
      body: isMac ? `Allow it in System Settings → Privacy & Security → ${pane}, then try again.` : `Allow it in Settings → Privacy → ${pane}, then try again.`,
    };
  }

  function renderProblem() {
    if (!problemEl) return;
    problemEl.hidden = !problem;
    if (!problem) { problemEl.replaceChildren(); return; }
    const p = problem;
    const { title, body } = problemText(p);
    const canOpen = p.problem === "denied" && inApp && (p.kind !== "screen" || isMac);
    mount(problemEl,
      icon(p.kind === "camera" ? "videoOff" : p.kind === "screen" ? "monitorOff" : "micOff", 22, "ember"),
      h("div", { class: "grow col" }, h("strong", null, title), h("span", { class: "muted small" }, body)),
      canOpen && h("button", { class: "btn primary sm", type: "button", onclick: () =>
        void invoke("open_privacy_settings", { kind: p.kind }).catch(() => toast("Couldn’t open settings. Open them yourself.", "error")) },
        isMac ? "Open System Settings" : "Open Windows settings"),
      h("button", { class: "icon-btn sm", type: "button", "aria-label": "Dismiss", title: "Dismiss", onclick: () => { problem = null; renderProblem(); } }, icon("close", 18)));
  }

  function onCall(e: CallEvent) {
    switch (e.type) {
      case "status":
        // Joining or leaving the room you're looking at swaps its header (Join ↔ Room chat / Leave).
        if (view.kind === "voice" && (headerFor === view.roomId) !== (call.roomId === view.roomId)) { renderSidebar(); renderMain(); break; }
        renderSidebar(); renderStage(); renderBar(); break;
      case "local": renderSidebar(); renderStage(); renderBar(); break;
      case "tracks": case "quality": renderStage(); break;
      case "speaking": renderSpeaking(); break;
      case "capture":
        problem = { kind: e.kind, problem: e.problem, sound: e.sound };
        if (view.kind === "voice") renderProblem();
        else toast(problemText(problem).title, "error");
        break;
      case "ended":
        toast(e.message, "error");
        problem = null;
        if (view.kind === "voice") show({ kind: "deck" });
        else renderSidebar();
        break;
    }
  }

  const seeingDeck = () => view.kind === "deck" && !document.hidden && document.hasFocus();

  /** Sounds and the tray/Dock badge pause when notifications are off or you're busy. */
  const notifying = () => notificationsOn() && me.status !== "busy";

  function reportUnread() {
    if ("__TAURI_INTERNALS__" in window) void invoke("set_unread", { count: notifying() ? deckMentions : 0 }).catch(() => {});
  }

  /** Drop-up from your name: custom status, presence, notifications, settings, sign out. */
  function statusMenu(anchor: HTMLElement) {
    document.querySelector(".status-menu")?.remove();
    const r = anchor.getBoundingClientRect();
    const menu = h("div", { class: "status-menu", role: "menu", style: { left: `${r.left}px`, bottom: `${innerHeight - r.top + 8}px` } });
    const close = () => { menu.remove(); removeEventListener("mousedown", outside, true); removeEventListener("keydown", esc, true); };
    const outside = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && !document.querySelector(".emoji-pop")?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };

    const save = async (patch: Parameters<typeof api.updateMe>[0]) => {
      try {
        Object.assign(me, await api.updateMe(patch));
        session.me = me;
        const self = people.get(me.id);
        if (self) Object.assign(self, { status: me.status, status_emoji: me.status_emoji, status_text: me.status_text });
        reportUnread();
        renderSidebar();
      } catch (e) { toast(errorText(e), "error"); }
    };

    const draw = (editing = false) => {
      const custom = me.status_text || me.status_emoji;
      let emoji = me.status_emoji ?? "💬";
      const emojiBtn = h("button", { class: "status-emoji", type: "button", "aria-label": "Pick an emoji" }, emoji);
      emojiBtn.onclick = () => emojiPicker(emojiBtn, (e) => { emoji = e; emojiBtn.textContent = e; });
      const text = h("input", { class: "status-input", maxlength: 60, placeholder: "What’s happening?", value: me.status_text ?? "" });
      const commit = async () => { await save({ status_emoji: emoji, status_text: text.value }); draw(); };
      text.addEventListener("keydown", (e) => { if (e.key === "Enter") void commit(); });
      mount(menu,
        h("div", { class: "sm-head" }, personAvatar(me, 36), h("div", { class: "col min0" }, h("strong", null, me.display_name), h("span", { class: "muted small" }, `@${me.username}`))),
        editing
          ? h("div", { class: "sm-edit" },
              h("div", { class: "row gap-6" }, emojiBtn, text),
              h("div", { class: "sm-presets" }, STATUS_PRESETS.map(([e, t]) => h("button", { class: "chip", type: "button", onclick: () => { emoji = e; emojiBtn.textContent = e; text.value = t; text.focus(); } }, `${e} ${t}`))),
              h("div", { class: "row gap-6" },
                h("button", { class: "btn primary sm", type: "button", onclick: () => void commit() }, "Save"),
                custom && h("button", { class: "btn ghost sm", type: "button", onclick: async () => { await save({ status_emoji: "", status_text: "" }); draw(); } }, "Clear"),
                h("button", { class: "link muted", type: "button", onclick: () => draw() }, "Cancel")))
          : h("button", { class: "sm-status", type: "button", role: "menuitem", onclick: () => { draw(true); menu.querySelector<HTMLInputElement>(".status-input")?.focus(); } },
              h("span", { class: "status-emoji static" }, me.status_emoji ?? "😀"),
              h("span", { class: "grow" }, custom ? (me.status_text || "Status set") : "Update your status")),
        h("div", { class: "sm-group", role: "group", "aria-label": "Presence" },
          (Object.keys(PRESENCE_LABEL) as Presence[]).map((p) =>
            h("button", { class: `sm-item ${me.status === p ? "on" : ""}`, type: "button", role: "menuitemradio", "aria-checked": String(me.status === p), onclick: () => void save({ status: p }).then(() => draw()) },
              h("span", { class: `online-dot inline ${p}` }), h("span", { class: "grow" }, PRESENCE_LABEL[p]),
              p === "busy" && h("span", { class: "muted small" }, "pauses notifications"),
              me.status === p && h("span", { class: "lantern" }, "✓")))),
        h("button", { class: "sm-item", type: "button", role: "menuitemcheckbox", "aria-checked": String(notificationsOn()), onclick: () => { setNotifications(!notificationsOn()); reportUnread(); draw(); } },
          h("span", { class: "grow" }, "Notifications"), h("span", { class: "muted small" }, notificationsOn() ? (me.status === "busy" ? "Paused while busy" : "On") : "Off")),
        h("div", { class: "sm-sep" }),
        h("button", { class: "sm-item", type: "button", role: "menuitem", onclick: () => { close(); go({ name: "settings" }); } }, "Profile and settings"),
        h("button", { class: "sm-item danger", type: "button", role: "menuitem", onclick: async () => {
          close();
          try { await api.logout(); } catch { await api.forgetLogin().catch(() => {}); }
          session.me = null;
          go({ name: "signin" });
        } }, "Sign out"));
    };
    draw();
    document.body.appendChild(menu);
    setTimeout(() => { addEventListener("mousedown", outside, true); addEventListener("keydown", esc, true); });
  }

  const onFocus = () => {
    if (seeingDeck() && deckMentions > 0) { deckMentions = 0; reportUnread(); renderSidebar(); }
  };

  function show(v: View) {
    view = v;
    if (v.kind === "deck" && document.hasFocus()) { deckMentions = 0; reportUnread(); }
    renderSidebar();
    renderMain();
  }

  /** One click: look at the room (and join right away if you chose that in Settings). */
  function previewRoom(r: Room) {
    if (r.id === call.roomId || !prefs.autoJoin) {
      if (!(view.kind === "voice" && view.roomId === r.id)) { roomChatOpen = false; spotlight = null; }
      return show({ kind: "voice", roomId: r.id });
    }
    void joinRoom(r);
  }

  /** Double-click, the Join button, or auto-join. Applies your "when I join" settings. */
  async function joinRoom(r: Room) {
    if (r.id === call.roomId) return show({ kind: "voice", roomId: r.id });
    // With push to talk set, you join muted and talk while holding the keys.
    if (call.status === "idle") await call.setMuted(prefs.joinMuted || !!keys.ptt);
    await openRoom(r);
    // Your own join sound waits until the call and mic are up, plus a moment: opening a
    // Bluetooth headset's mic switches it to call mode, and a sound during that switch stutters.
    if (call.roomId === r.id && call.status === "connected") setTimeout(() => { if (call.roomId === r.id) playJoinSound(me.join_sound); }, 600);
    if (call.roomId === r.id && prefs.joinCamera && !call.camera) void call.setCamera(true);
  }

  async function openRoom(r: Room) {
    if (r.id === call.roomId) return show({ kind: "voice", roomId: r.id });
    problem = null;
    spotlight = null;
    try {
      // Connects to LiveKit; the server learns from LiveKit and sends a "voice" event with the new occupancy.
      const joining = call.join(r.id);
      roomChatOpen = false;
      show({ kind: "voice", roomId: r.id });
      await joining;
    } catch (e) {
      toast(errorText(e), "error");
      if (view.kind === "voice" && view.roomId === r.id) show({ kind: "deck" });
    }
  }

  async function leave() {
    problem = null;
    // Disconnecting from LiveKit is leaving; the server hears it from LiveKit.
    playSound(me.leave_sound);
    await call.leave();
    if (view.kind === "voice") show({ kind: "deck" });
  }

  function toggleMute() { void call.setMuted(!call.muted); }
  function toggleDeafen() { void call.setDeafened(!call.deafened); }

  // ─── Events, hotkeys, load ───────────────────────────────────────

  function onEvent(e: LiveEvent) {
    switch (e.type) {
      case "message_new":
        addMessage(e.message);
        // Mentions count while you're elsewhere or the window is hidden/unfocused (tray and Dock badge).
        if (e.message.channel_id === deck()?.id && e.message.mentions.includes(me.id) && e.message.author_id !== me.id && !seeingDeck()) {
          deckMentions++;
          reportUnread();
          if (notifying()) chime();
          renderSidebar();
        }
        break;
      case "message_deleted": removeMessage(e.channel_id, e.id); break;
      case "reactions": {
        const m = cache.get(e.channel_id)?.find((x) => x.id === e.id);
        if (m) { m.reactions = e.reactions; refreshLists(e.channel_id); }
        break;
      }
      case "presence": { const p = people.get(e.user_id); if (p && p.id !== me.id) { p.online = e.online; renderSidebar(); } break; }
      case "voice": {
        const r = rooms.find((x) => x.id === e.room_id);
        if (!r) { void load(); break; }
        // Join sounds: whoever just came into the room you're in (you too), on top of the talk.
        if (r.id === call.roomId) {
          const before = new Set(r.members.map((m) => m.user_id));
          // (Your own plays from joinRoom once your mic is live.)
          for (const m of e.members) if (!before.has(m.user_id) && m.user_id !== me.id) playJoinSound(person(m.user_id).join_sound);
          // …and whoever left it (not you: you hear your own when you hang up).
          const after = new Set(e.members.map((m) => m.user_id));
          for (const id of before) if (!after.has(id) && id !== me.id) playSound(person(id).leave_sound);
        }
        r.members = e.members;
        // Room chat is only readable by people in the room, and it's cleared when the room empties.
        if (!e.members.some((m) => m.user_id === me.id) && call.roomId !== r.id) cache.delete(r.id);
        renderSidebar();
        if (viewedRoom()?.id === r.id) { renderStage(); renderBar(); }
        break;
      }
      case "people": case "rooms": void load(); break;
      case "offline": if (!offline) { offline = true; renderSidebar(); } break;
      case "ready": if (offline) { offline = false; void load(); } break;
      case "signed_out": void call.leave(); session.me = null; go({ name: "signin" }); break;
    }
  }

  // ── Push to talk: system-wide in the app (works while a game has focus), window keys in a dev browser.
  let pttActive = false;
  let pttCleanup: (() => void) | null = null;
  const pttPress = () => { if (call.roomId === null || pttActive) return; pttActive = true; void call.setMuted(false); };
  const pttRelease = () => { if (!pttActive) return; pttActive = false; void call.setMuted(true); };
  async function setupPushToTalk() {
    const combo = keys.ptt;
    if (!combo) return;
    if ("__TAURI_INTERNALS__" in window) {
      const gs = await import("@tauri-apps/plugin-global-shortcut");
      const acc = toAccelerator(combo);
      try {
        await gs.register(acc, (ev) => (ev.state === "Pressed" ? pttPress() : pttRelease()));
        pttCleanup = () => { pttRelease(); void gs.unregister(acc).catch(() => {}); };
      } catch {
        toast(`Push to talk (${formatKey(combo)}) is taken by another app. Pick another in Settings.`, "error");
      }
      return;
    }
    const down = (e: KeyboardEvent) => { if (!e.repeat && matches(e, combo)) { e.preventDefault(); pttPress(); } };
    const up = (e: KeyboardEvent) => { if (e.code === combo.code) pttRelease(); };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    pttCleanup = () => { pttRelease(); removeEventListener("keydown", down); removeEventListener("keyup", up); };
  }

  const onKey = (e: KeyboardEvent) => {
    if (matches(e, keys.mute)) { e.preventDefault(); toggleMute(); }
    else if (matches(e, keys.deafen)) { e.preventDefault(); toggleDeafen(); }
  };

  async function load() {
    try {
      const [ps, rs, th] = await Promise.all([api.people(), api.rooms(), api.treehouse()]);
      people = new Map(ps.map((p) => [p.id, p]));
      rooms = rs;
      treehouse = th;
      const self = people.get(me.id);
      // You're online by definition while this screen is open, even before the live connection registers.
      if (self) { self.online = true; Object.assign(me, { display_name: self.display_name, color: self.color, avatar: self.avatar }); }
      // Rooms that emptied lose their chat; drop what we held.
      for (const r of rooms) if (r.kind === "voice" && !r.members.some((m) => m.user_id === me.id) && r.id !== call.roomId) cache.delete(r.id);
      renderSidebar();
      if (view.kind === "voice" || !lists.size) renderMain();
      else for (const ch of lists.keys()) refreshLists(ch);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const unsubscribe = api.subscribe(onEvent);
  const unsubscribeCall = call.on(onCall);
  const unsubscribePopout = popout.on(renderBar);
  addEventListener("keydown", onKey);
  void setupPushToTalk();
  addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  renderSidebar();
  renderMain();
  void load();
  preloadSounds();
  popout.setLeaveHandler(() => void leave());

  return () => {
    unsubscribe();
    unsubscribeCall();
    unsubscribePopout();
    for (const [track, el] of videoEls) track.detach(el);
    videoEls.clear();
    removeEventListener("keydown", onKey);
    pttCleanup?.();
    removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    deckMentions = 0;
    reportUnread();
    document.querySelectorAll(".popover, .emoji-pop").forEach((el) => el.remove());
  };
});
