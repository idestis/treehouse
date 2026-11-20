import { invoke } from "@tauri-apps/api/core";
import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  ConnectionQuality,
} from "livekit-client";

// ---------- voice quality ----------
// Everything that makes voice sound clean is decided here, so nobody has to
// fiddle with settings: echo removal, noise removal, auto volume, Opus at
// 48 kbit/s mono, DTX (silence costs nothing) and RED (redundant packets, so a
// lost packet doesn’t become a click or gap). The server forwards packets
// as-is, without re-encoding, so what you send is exactly what friends hear.
const AUDIO_CAPTURE = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: true, // used where the webview supports it, ignored elsewhere
  channelCount: 1,
  sampleRate: 48000,
};

const PUBLISH = {
  dtx: true,
  red: true,
  audioPreset: { maxBitrate: 48_000 },
  stopMicTrackOnMute: false, // unmuting is instant
};

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
const screens = ["loading", "pair", "room"];
function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
}
function setStatus(text, tone = "info") {
  const el = $("status");
  el.hidden = !text;
  el.textContent = text || "";
  el.dataset.tone = tone;
}
function initial(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}
function colorOf(participant) {
  try {
    return JSON.parse(participant.metadata || "{}").color || "#64748B";
  } catch {
    return "#64748B";
  }
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- startup ----------
let me = null;
let room = null;

async function start() {
  show("loading");
  try {
    const session = await invoke("session");
    if (session) enterRoomScreen(session);
    else await enterPairScreen();
  } catch (e) {
    await enterPairScreen(String(e));
  }
}

// ---------- pairing ----------
async function enterPairScreen(error) {
  show("pair");
  const last = await invoke("last_server").catch(() => null);
  if (last) $("pair-server").value = last.replace(/^https:\/\//, "");
  showPairError(error);
  ($("pair-server").value ? $("pair-code") : $("pair-server")).focus();
}

function showPairError(msg) {
  $("pair-error").hidden = !msg;
  $("pair-error").textContent = msg || "";
}

$("pair-code").addEventListener("input", (e) => {
  // Auto-format as ABCD-1234 while typing.
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  e.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
});

$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("pair-btn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  showPairError("");
  try {
    const session = await invoke("pair", {
      server: $("pair-server").value,
      code: $("pair-code").value,
    });
    $("pair-code").value = "";
    enterRoomScreen(session);
  } catch (err) {
    showPairError(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect";
  }
});

// ---------- room screen ----------
function enterRoomScreen(session) {
  me = session.me;
  $("me-name").textContent = me.display_name;
  $("me-avatar").textContent = initial(me.display_name);
  $("me-avatar").style.setProperty("--c", me.color);
  show("room");
  showLobby();
  setStatus(session.offline ? "Can’t reach the server right now. You can still try to join." : "", "warn");
}

function showLobby() {
  $("lobby").hidden = false;
  $("call").hidden = true;
  $("controls").hidden = true;
  $("join-btn").disabled = false;
  $("join-btn").querySelector("span").textContent = "Join";
}

function showCall() {
  $("lobby").hidden = true;
  $("call").hidden = false;
  $("controls").hidden = false;
}

$("join-btn").addEventListener("click", join);
$("leave-btn").addEventListener("click", () => room?.disconnect());

async function join() {
  const btn = $("join-btn");
  btn.disabled = true;
  btn.querySelector("span").textContent = "Joining…";
  setStatus("");

  try {
    const { url, token } = await invoke("voice_token");

    room = new Room({
      audioCaptureDefaults: {
        ...AUDIO_CAPTURE,
        deviceId: store.get("mic") || undefined,
      },
      audioOutput: { deviceId: store.get("speaker") || undefined },
      publishDefaults: PUBLISH,
      adaptiveStream: true,
      dynacast: true,
    });
    wireRoom(room);

    await room.connect(url, token);
    await room.startAudio(); // we’re inside a click, so playback is allowed
    await room.localParticipant.setMicrophoneEnabled(true);

    showCall();
    renderTiles();
    updateMicButton();
  } catch (err) {
    const msg = String(err?.message || err);
    if (/pair it again|isn’t paired/i.test(msg)) {
      await room?.disconnect();
      room = null;
      return enterPairScreen(msg);
    }
    if (/permission|NotAllowed/i.test(msg)) {
      setStatus("Treehouse needs your microphone. Allow it in your computer’s privacy settings, then try again.", "error");
    } else {
      setStatus(`Couldn’t join: ${msg}`, "error");
    }
    await room?.disconnect();
    room = null;
    showLobby();
  }
}

function wireRoom(r) {
  r.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      $("audio-sink").appendChild(el);
    }
  })
    .on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
    })
    .on(RoomEvent.ParticipantConnected, renderTiles)
    .on(RoomEvent.ParticipantDisconnected, renderTiles)
    .on(RoomEvent.ParticipantMetadataChanged, renderTiles)
    .on(RoomEvent.TrackMuted, () => { renderTiles(); updateMicButton(); })
    .on(RoomEvent.TrackUnmuted, () => { renderTiles(); updateMicButton(); })
    .on(RoomEvent.LocalTrackPublished, () => { renderTiles(); updateMicButton(); })
    .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) {
        setStatus(quality === ConnectionQuality.Poor ? "Your connection is weak. Friends may hear you break up." : "", "warn");
      }
    })
    .on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Reconnecting) setStatus("Connection lost. Reconnecting…", "warn");
      if (state === ConnectionState.Connected) setStatus("");
    })
    .on(RoomEvent.Disconnected, () => {
      $("audio-sink").replaceChildren();
      $("tiles").replaceChildren();
      room = null;
      showLobby();
    })
    .on(RoomEvent.MediaDevicesError, () => {
      setStatus("Treehouse can’t use your microphone. Check that it’s plugged in and allowed.", "error");
    });
}

// ---------- people tiles ----------
function participants() {
  if (!room) return [];
  return [room.localParticipant, ...room.remoteParticipants.values()];
}

function renderTiles() {
  const list = $("tiles");
  const people = participants();
  const seen = new Set();

  for (const p of people) {
    seen.add(p.identity);
    let li = list.querySelector(`[data-id="${CSS.escape(p.identity)}"]`);
    if (!li) {
      li = document.createElement("li");
      li.className = "tile";
      li.dataset.id = p.identity;
      li.innerHTML = `<span class="avatar xl"></span><span class="name"></span><span class="muted-badge" title="Muted" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg></span>`;
      list.appendChild(li);
    }
    const name = p.isLocal ? `${p.name || me.display_name} (you)` : p.name || p.identity;
    const avatar = li.querySelector(".avatar");
    avatar.textContent = initial(p.name || p.identity);
    li.style.setProperty("--c", p.isLocal ? me.color : colorOf(p));
    li.querySelector(".name").textContent = name;
    const muted = !p.isMicrophoneEnabled;
    li.querySelector(".muted-badge").hidden = !muted;
    li.classList.toggle("is-muted", muted);
    li.setAttribute("aria-label", `${name}${muted ? ", muted" : ""}`);
  }
  for (const li of [...list.children]) {
    if (!seen.has(li.dataset.id)) li.remove();
  }
  $("alone").hidden = people.length > 1;
  list.dataset.count = String(Math.min(people.length, 6));
}

// Speaking glow follows the live audio level of each person.
function animateLevels() {
  for (const p of participants()) {
    const li = $("tiles").querySelector(`[data-id="${CSS.escape(p.identity)}"]`);
    if (!li) continue;
    const level = p.isSpeaking ? Math.min(1, 0.35 + p.audioLevel * 2.5) : 0;
    const prev = Number(li.style.getPropertyValue("--level") || 0);
    const next = prev + (level - prev) * 0.35; // smooth it out
    li.style.setProperty("--level", next.toFixed(3));
    li.classList.toggle("speaking", next > 0.08);
  }
  requestAnimationFrame(animateLevels);
}
requestAnimationFrame(animateLevels);

// ---------- mic ----------
async function toggleMic() {
  if (!room) return;
  const lp = room.localParticipant;
  await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled);
  updateMicButton();
  renderTiles();
}

function updateMicButton() {
  if (!room) return;
  const on = room.localParticipant.isMicrophoneEnabled;
  const btn = $("mic-btn");
  btn.classList.toggle("on", on);
  btn.classList.toggle("off", !on);
  btn.setAttribute("aria-pressed", String(!on));
  $("mic-label").textContent = on ? "Mute" : "Unmute";
  btn.title = on ? "Mute (Ctrl+M)" : "Unmute (Ctrl+M)";
}

$("mic-btn").addEventListener("click", toggleMic);
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") {
    e.preventDefault();
    toggleMic();
  }
});

// ---------- menu ----------
function closeMenu() {
  $("menu").hidden = true;
  $("me-btn").setAttribute("aria-expanded", "false");
}
$("me-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("menu").hidden;
  $("menu").hidden = !open;
  $("me-btn").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (!$("menu").contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());

$("do-unpair").addEventListener("click", async () => {
  closeMenu();
  if (!confirm("Disconnect this computer? You’ll need a new pairing code to use it again.")) return;
  await room?.disconnect();
  await invoke("unpair").catch(() => {});
  enterPairScreen();
});

// ---------- sound settings ----------
$("open-sound").addEventListener("click", async () => {
  closeMenu();
  await fillDevices();
  $("sound").showModal();
});

async function fillDevices() {
  const fill = async (kind, select, key) => {
    const devices = await Room.getLocalDevices(kind, true).catch(() => []);
    const chosen = store.get(key) || "default";
    select.replaceChildren(
      ...devices.map((d, i) => {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || (kind === "audioinput" ? `Microphone ${i + 1}` : `Speaker ${i + 1}`);
        o.selected = d.deviceId === chosen;
        return o;
      }),
    );
    return devices.length;
  };
  await fill("audioinput", $("mic-select"), "mic");
  const outputs = await fill("audiooutput", $("speaker-select"), "speaker");
  // Some systems (macOS webview) can’t pick an output device; hide the row there.
  $("speaker-row").hidden = outputs === 0 || !("setSinkId" in HTMLMediaElement.prototype);
}

$("mic-select").addEventListener("change", async (e) => {
  store.set("mic", e.target.value);
  await room?.switchActiveDevice("audioinput", e.target.value);
});
$("speaker-select").addEventListener("change", async (e) => {
  store.set("speaker", e.target.value);
  await room?.switchActiveDevice("audiooutput", e.target.value);
});

start();
