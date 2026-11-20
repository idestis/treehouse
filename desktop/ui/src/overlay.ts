// The "people on top" window (desktop app only; the window is made in
// overlay.rs, opened from popout.ts). It shows everyone in your voice call:
// their camera when it's on, otherwise their picture, lit while they talk.
//
// Web views can't share media, so this window has its own LiveKit connection.
// Its token is hidden and watch-only (the server only gives it while you're
// in the room), it subscribes to cameras only, and never plays sound: the
// main window already does.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DisconnectReason, Room, RoomEvent, Track,
  type Participant, type RemoteParticipant,
} from "livekit-client";
import { api } from "./api";
import { isApiError, type Person, type VoiceGrant } from "./api/types";
import { personAvatar, type HasAvatar } from "./avatars";
import { h, icon, mount } from "./dom";

const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 5000;
const GAP = 6;

/** People's own voice connections are named by their user id; anything else (overlays) isn't a person. */
const isPerson = (p: Participant) => /^\d+$/.test(p.identity);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The server says the call is over for you: left, timed out, or the room is gone. */
const callOver = (e: unknown) => isApiError(e) && (e.status === 403 || e.status === 404 || e.status === 409);

export function startOverlay(root: HTMLElement, firstRoom: number) {
  document.documentElement.classList.add("overlay");
  root.className = "overlay-root";
  addEventListener("contextmenu", (e) => e.preventDefault());
  addEventListener("keydown", (e) => {
    const reload = e.key === "F5" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r");
    if (reload) e.preventDefault();
    if (e.key === "Escape") void close();
  });

  let roomId = firstRoom;
  let lk: Room | null = null;
  /** Your user id: your own tile is left out. */
  let me = 0;
  let people = new Map<number, Person>();
  let roomName = "";
  let speaking = new Set<string>();
  let refreshTimer = 0;
  let retryTimer = 0;
  let closing = false;
  let problem = "";
  const videoEls = new Map<Track, HTMLVideoElement>();

  const title = h("span", { class: "ov-title ellipsis" }, "Voice");
  const bar = h("div", { class: "ov-bar", "data-tauri-drag-region": "deep" },
    title,
    h("button", { class: "ov-close", type: "button", title: "Close", "aria-label": "Close the people window", onclick: () => void close() }, icon("close", 16)));
  // Drag the window from anywhere; tiles have no buttons.
  const grid = h("div", { class: "ov-grid", "data-tauri-drag-region": "deep" });
  mount(root, bar, grid);
  new ResizeObserver(layout).observe(grid);

  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(refreshTimer);
    clearTimeout(retryTimer);
    const r = lk;
    lk = null;
    await r?.disconnect().catch(() => {});
    void invoke("overlay_close").catch(() => {});
  }

  /** Right after you join, the server may not know yet (LiveKit tells it a moment later): ask again a few times. */
  async function grant(id: number): Promise<VoiceGrant> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api.voiceToken(id, { overlay: true });
      } catch (e) {
        if (isApiError(e) && e.status === 409 && attempt < 3 && roomId === id) { await sleep(1500); continue; }
        throw e;
      }
    }
  }

  function retry(id: number) {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => { if (roomId === id && !lk && !closing) void connect(id); }, RETRY_MS);
  }

  async function connect(id: number) {
    clearInterval(refreshTimer);
    clearTimeout(retryTimer);
    const old = lk;
    lk = null;
    roomId = id;
    speaking = new Set();
    if (old) await old.disconnect().catch(() => {});
    render();
    void loadInfo(id);

    let g: VoiceGrant;
    try {
      g = await grant(id);
    } catch (e) {
      if (roomId !== id || closing) return;
      if (callOver(e)) return void close();
      problem = "Can’t reach the treehouse. Trying again…";
      render();
      return retry(id);
    }
    if (roomId !== id || closing) return;
    me = parseInt(g.identity, 10);
    const r = new Room({ adaptiveStream: true, dynacast: false, disconnectOnPageLeave: true });
    lk = r;
    wire(r);
    try {
      await r.connect(g.url, g.token, { autoSubscribe: false });
    } catch {
      if (lk !== r) return;
      lk = null;
      problem = "Can’t reach voice. Trying again…";
      render();
      return retry(id);
    }
    if (lk !== r) { void r.disconnect(); return; }
    problem = "";
    for (const p of r.remoteParticipants.values()) pick(p);
    render();
    startRefresh(id);
  }

  /** People's names and pictures, and the room's name. Best effort: LiveKit's names fill in meanwhile. */
  async function loadInfo(id: number) {
    try {
      const [list, rooms] = await Promise.all([api.people(), api.rooms()]);
      people = new Map(list.map((p) => [p.id, p]));
      roomName = rooms.find((r) => r.id === id)?.name ?? "";
      if (roomId === id) render();
    } catch { /* keep what we have */ }
  }

  /** Still in the call? The main window closes this one when you leave; this covers everything else. */
  function startRefresh(id: number) {
    refreshTimer = window.setInterval(async () => {
      if (roomId !== id) return;
      try {
        await api.voiceToken(id, { overlay: true });
      } catch (e) {
        if (callOver(e)) void close();
      }
    }, REFRESH_MS);
  }

  /** Cameras only: never microphones (the main window plays sound) and never screens. */
  function pick(p: RemoteParticipant) {
    const show = isPerson(p) && Number(p.identity) !== me;
    for (const pub of p.trackPublications.values()) {
      const want = show && pub.kind === Track.Kind.Video && pub.source === Track.Source.Camera;
      if (pub.isDesired !== want) pub.setSubscribed(want);
    }
  }

  function wire(r: Room) {
    const mine = () => lk === r;
    const redraw = () => { if (mine()) render(); };
    r.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => { if (mine()) { pick(p); render(); } })
      .on(RoomEvent.ParticipantDisconnected, redraw)
      .on(RoomEvent.TrackPublished, (_pub, p: RemoteParticipant) => { if (mine()) { pick(p); render(); } })
      .on(RoomEvent.TrackUnpublished, redraw)
      .on(RoomEvent.TrackSubscribed, redraw)
      .on(RoomEvent.TrackUnsubscribed, redraw)
      .on(RoomEvent.TrackMuted, redraw)
      .on(RoomEvent.TrackUnmuted, redraw)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (!mine()) return;
        speaking = new Set(speakers.map((s) => s.identity));
        for (const el of grid.querySelectorAll<HTMLElement>(".ov-tile")) el.classList.toggle("speaking", speaking.has(el.dataset.identity ?? ""));
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!mine() || closing) return;
        lk = null;
        if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED) return void close();
        // Anything else (network, server restart): ask the server again; it closes us if the call is over.
        problem = "Voice disconnected. Trying again…";
        render();
        retry(roomId);
      });
  }

  function render() {
    title.textContent = roomName || "Voice";
    const r = lk;
    if (!r) { note(problem || "Connecting…"); return; }
    const list = [...r.remoteParticipants.values()].filter((p) => isPerson(p) && Number(p.identity) !== me);
    if (!list.length) { note("Nobody else is here yet."); return; }
    const used = new Set<Track>();
    mount(grid, list.map((p) => tile(p, used)));
    for (const [track, el] of videoEls) {
      if (!used.has(track)) { track.detach(el); videoEls.delete(track); }
    }
    layout();
  }

  function note(text: string) {
    for (const [track, el] of videoEls) track.detach(el);
    videoEls.clear();
    mount(grid, h("p", { class: "ov-note" }, text));
    grid.style.gridTemplateColumns = "";
    grid.style.gridTemplateRows = "";
  }

  function tile(p: RemoteParticipant, used: Set<Track>) {
    const id = Number(p.identity);
    const person: HasAvatar = people.get(id) ?? { id, display_name: p.name || "Someone", color: "#2a3757", avatar: null };
    const pub = p.getTrackPublication(Track.Source.Camera);
    const track = pub?.track && pub.isSubscribed && !pub.isMuted ? pub.track : undefined;
    const muted = !p.isMicrophoneEnabled;
    return h("div", {
      class: `ov-tile ${track ? "camera" : ""} ${speaking.has(p.identity) ? "speaking" : ""}`,
      "data-identity": p.identity,
      title: person.display_name,
      style: { background: `color-mix(in srgb, ${person.color} 22%, #182238)` },
    },
    track ? video(track, used) : personAvatar(person, 0, `ov-av ${muted ? "dim" : ""}`),
    h("div", { class: "ov-name" },
      muted && h("span", { class: "ov-muted", title: "Muted" }, icon("micOff", 13)),
      h("span", { class: "ellipsis" }, person.display_name)));
  }

  function video(track: Track, used: Set<Track>): HTMLVideoElement {
    used.add(track);
    let el = videoEls.get(track);
    if (!el) {
      el = track.attach() as HTMLVideoElement;
      el.muted = true;
      el.playsInline = true;
      el.autoplay = true;
      el.className = "ov-video";
      videoEls.set(track, el);
    }
    return el;
  }

  /** As many columns as make the tiles biggest (about 4:3): a stack in a tall window, a row in a wide one. */
  function layout() {
    const n = grid.querySelectorAll(".ov-tile").length;
    if (!n) return;
    const w = grid.clientWidth - 2 * GAP;
    const ht = grid.clientHeight - 2 * GAP;
    let best = 1;
    let bestSize = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const size = Math.min((w - GAP * (cols - 1)) / cols, ((ht - GAP * (rows - 1)) / rows) * (4 / 3));
      if (size > bestSize) { bestSize = size; best = cols; }
    }
    grid.style.gridTemplateColumns = `repeat(${best}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${Math.ceil(n / best)}, minmax(0, 1fr))`;
  }

  // The main window moved you to another room while this stayed open.
  void listen<number>("overlay-room", (e) => { if (e.payload !== roomId && !closing) void connect(e.payload); });

  void connect(firstRoom);
}
