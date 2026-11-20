// The main window: sidebar, The Deck, voice rooms and room chat.
// Everything shown comes from the server; buttons hidden here are still
// refused by the server.
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import type { Gif, LiveEvent, Me, Message, Person, Presence, Room, Treehouse } from "../api/types";
import { errorText } from "../api/types";
import { go, register, session } from "../app";
import { personAvatar } from "../avatars";
import { chime, notificationsOn, setNotifications } from "../notify";
import { format as formatKey, load as loadHotkeys, matches } from "../hotkeys";
import { h, icon, mount, time, toast } from "../dom";

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
  let view: View = { kind: "deck" };
  let roomChatOpen = false;
  let deckMentions = 0;
  const local = { muted: false, deafened: false, camera: false };
  const cache = new Map<number, Message[]>();

  const deck = () => rooms.find((r) => r.kind === "deck");
  const voiceRooms = () => rooms.filter((r) => r.kind === "voice");
  const myVoiceRoom = () => voiceRooms().find((r) => r.members.some((m) => m.user_id === me.id));
  const person = (id: number): Person => people.get(id) ?? { id, username: "gone", display_name: "Someone", color: "#7C8BA8", role: "member", online: false, avatar: null, status: "online", status_emoji: null, status_text: null, join_sound: "none" };

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
        d && h("button", { class: `sb-row ${view.kind === "deck" ? "active" : ""}`, onclick: () => show({ kind: "deck" }) },
          icon("hash", 20, "muted"), h("span", { class: "grow" }, d.slug),
          deckMentions > 0 && view.kind !== "deck" && h("span", { class: "badge lantern" }, `@${deckMentions}`)),
        h("p", { class: "sb-label" }, "Voice rooms"),
        voiceRooms().map((r) => [
          h("button", { class: `sb-row ${view.kind === "voice" && view.roomId === r.id ? "active" : ""}`, onclick: () => openRoom(r) },
            icon("speaker", 20, "muted"), h("span", { class: "grow" }, r.name),
            r.members.length > 0 && h("span", { class: "badge leaf" }, String(r.members.length))),
          r.members.length > 0 && h("ul", { class: "sb-members" }, r.members.map((m) => {
            const p = person(m.user_id);
            return h("li", null,
              personAvatar(p, 24),
              h("span", { class: "grow" }, p.display_name, p.id === me.id ? " (you)" : ""),
              m.muted && icon("micOff", 18, "ember"),
              m.camera && icon("video", 18, "leaf"));
          })),
        ]),
      ),
      current && h("div", { class: "sb-voice" },
        h("div", { class: "grow col" }, h("span", { class: "leaf strong" }, h("span", { class: "dot" }), "Voice connected"), h("span", { class: "small" }, current.name)),
        h("button", { class: "icon-btn danger", "aria-label": "Leave voice", title: "Leave voice", onclick: () => leave() }, icon("hangup", 22))),
      h("footer", { class: "sb-me" },
        h("button", { class: "me-button", type: "button", "aria-haspopup": "menu", "aria-label": "Your status and settings", onclick: (e: Event) => statusMenu(e.currentTarget as HTMLElement) },
          h("span", { class: "me-avatar" }, personAvatar(me, 40), h("span", { class: `online-dot ${me.status}` })),
          h("span", { class: "grow col min0" }, h("strong", null, me.display_name),
            h("span", { class: "muted small ellipsis" }, me.status_text || me.status_emoji ? `${me.status_emoji ?? ""} ${me.status_text ?? ""}`.trim() : PRESENCE_LABEL[me.status]))),
        h("button", { class: `icon-btn ${local.muted ? "ember" : ""}`, "aria-pressed": String(local.muted), "aria-label": `${local.muted ? "Unmute" : "Mute"} (${formatKey(keys.mute)})`, title: `${local.muted ? "Unmute" : "Mute"} (${formatKey(keys.mute)})`, onclick: toggleMute }, icon(local.muted ? "micOff" : "mic", 22)),
        h("button", { class: `icon-btn ${local.deafened ? "ember" : ""}`, "aria-pressed": String(local.deafened), "aria-label": `${local.deafened ? "Undeafen" : "Deafen"} (${formatKey(keys.deafen)})`, title: `${local.deafened ? "Undeafen" : "Deafen"} (${formatKey(keys.deafen)})`, onclick: toggleDeafen }, icon(local.deafened ? "headphonesOff" : "headphones", 22)),
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
    const inIt = r.members.some((m) => m.user_id === me.id);
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

    const gifPicker = async (q: string) => {
      pop.dataset.kind = "gif";
      pop.hidden = false;
      const grid = h("div", { class: "gif-grid" }, h("p", { class: "muted pad" }, "Looking for GIFs…"));
      const load = async () => {
        try {
          const gifs = await api.gifs(q);
          mount(grid, gifs.length ? gifs.map((g) => h("button", { type: "button", class: "gif-pick", "aria-label": `Send ${g.title}`, onclick: () => void sendGif(g) }, h("img", { src: g.preview_url, alt: g.title }))) : h("p", { class: "muted pad" }, "No GIFs for that. Try other words."));
        } catch (e) { mount(grid, h("p", { class: "muted pad" }, errorText(e))); }
      };
      mount(pop,
        h("div", { class: "row between pop-head" }, h("strong", null, `GIFs for “${q}”`),
          h("div", { class: "row gap-10" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => void load() }, "Shuffle"),
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

    input.addEventListener("input", () => { slashIndex = 0; renderSlash(); });
    input.addEventListener("keydown", (e) => {
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
    if (!room) { show({ kind: "deck" }); return; }
    const n = room.members.length;
    mount(main,
      h("header", { class: "main-head" },
        h("div", { class: "col grow" }, h("h1", { class: "title" }, room.name), h("p", { class: "muted" }, n ? `${n} in voice` : "Nobody here yet")),
        h("button", { class: `btn outline-lantern ${roomChatOpen ? "on" : ""}`, "aria-pressed": String(roomChatOpen), onclick: () => { roomChatOpen = !roomChatOpen; renderMain(); } }, icon("chat", 20), "Room chat"),
        h("button", { class: "btn outline-ember", onclick: () => leave() }, "Leave")),
      stage(room));
    side.hidden = !roomChatOpen;
    if (roomChatOpen) {
      mount(side,
        h("header", { class: "rc-head" },
          h("div", { class: "col grow" }, h("h2", { class: "rc-title" }, "Room chat"), h("p", { class: "muted small" }, `Only for people in ${room.name}. Cleared when everyone leaves.`)),
          h("button", { class: "icon-btn", "aria-label": "Close room chat", onclick: () => { roomChatOpen = false; renderMain(); } }, icon("close", 22))),
        messageList(room.id, true),
        composer(room.id, "Message the room"));
    }
  }

  function stage(room: Room) {
    const n = room.members.length;
    // 1 fills the stage, 2 side by side, 3–4 a 2×2 grid, 5–6 a 3×2 grid.
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    const rowsN = Math.max(1, Math.ceil(n / cols));
    return h("section", { class: "stage", style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rowsN}, 1fr)` } },
      room.members.map((m) => {
        const p = person(m.user_id);
        const you = p.id === me.id;
        return h("div", { class: `tile ${m.camera ? "camera" : ""}`, style: { background: `color-mix(in srgb, ${p.color} 22%, #182238)` } },
          m.camera && h("span", { class: "live" }, h("span", { class: "dot" }), "Live"),
          !m.camera && personAvatar(p, 0, "huge"),
          h("div", { class: "tile-bar" },
            personAvatar(p, 28),
            h("strong", { class: "grow" }, p.display_name, you ? " (you)" : ""),
            h("span", { class: `tile-ic ${m.muted ? "off" : ""}` }, icon(m.muted ? "micOff" : "mic", 20)),
            h("span", { class: `tile-ic ${m.camera ? "on" : ""}` }, icon(m.camera ? "video" : "videoOff", 20)),
          ));
      }),
      n === 0 && h("p", { class: "muted center" }, "Nobody here yet."));
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

  async function openRoom(r: Room) {
    if (r.members.some((m) => m.user_id === me.id)) return show({ kind: "voice", roomId: r.id });
    try {
      await api.voiceToken(r.id);
      // LiveKit connects here once voice lands (milestone 7); occupancy comes back as a "voice" event.
      roomChatOpen = false;
      show({ kind: "voice", roomId: r.id });
    } catch (e) { toast(errorText(e), "error"); }
  }

  async function leave() {
    const r = myVoiceRoom();
    if (!r) return;
    // Leaving disconnects from LiveKit, which tells the server (milestone 7).
    if (view.kind === "voice") show({ kind: "deck" });
  }

  function setOwn(patch: Partial<{ muted: boolean; deafened: boolean }>) {
    Object.assign(local, patch);
    const m = myVoiceRoom()?.members.find((x) => x.user_id === me.id);
    if (m) m.muted = local.muted;
    renderSidebar();
    if (view.kind === "voice") renderMain();
  }
  function toggleMute() { setOwn({ muted: !local.muted }); }
  function toggleDeafen() { setOwn(local.deafened ? { deafened: false } : { deafened: true, muted: true }); }

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
      case "people": case "rooms": void load(); break;
      case "offline": if (!offline) { offline = true; renderSidebar(); } break;
      case "ready": if (offline) { offline = false; void load(); } break;
      case "signed_out": session.me = null; go({ name: "signin" }); break;
    }
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
      for (const r of rooms) if (r.kind === "voice" && !r.members.some((m) => m.user_id === me.id)) cache.delete(r.id);
      renderSidebar();
      if (view.kind === "voice" || !lists.size) renderMain();
      else for (const ch of lists.keys()) refreshLists(ch);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const unsubscribe = api.subscribe(onEvent);
  addEventListener("keydown", onKey);
  addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  renderSidebar();
  renderMain();
  void load();

  return () => {
    unsubscribe();
    removeEventListener("keydown", onKey);
    removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    deckMentions = 0;
    reportUnread();
    document.querySelectorAll(".popover, .emoji-pop").forEach((el) => el.remove());
  };
});
