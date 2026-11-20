// The one active voice call: a LiveKit Room plus your own mic, camera and
// screen flags. The server decides who may join (voice token) and who is in
// a room (LiveKit webhooks); this module only connects, publishes and plays.
import {
  ConnectionQuality, ConnectionState, DisconnectReason, LocalAudioTrack, Participant, RemoteParticipant,
  RemoteTrack, Room, RoomEvent, ScreenSharePresets, Track, VideoPresets, createLocalAudioTrack,
  type LocalTrackPublication, type RoomOptions, type TrackPublication,
} from "livekit-client";
import { api } from "./api";
import { isApiError, type ApiError } from "./api/types";
import { AUDIO_CAPTURE, PUBLISH, prefs } from "./voice";

export type CallStatus = "idle" | "connecting" | "connected" | "reconnecting";
export type Capture = "microphone" | "camera" | "screen";

export type CallEvent =
  /** Connection status or the room changed. */
  | { type: "status" }
  /** Your own mute, deafen, camera or screen flags changed. */
  | { type: "local" }
  /** Someone's camera or screen appeared, went away, or was paused. */
  | { type: "tracks" }
  /** Who is talking changed. */
  | { type: "speaking" }
  /** Your connection got weak or recovered. */
  | { type: "quality"; poor: boolean }
  /** A device couldn't be used. `denied` means the OS or the user said no. */
  | { type: "capture"; kind: Capture; problem: "denied" | "missing" | "unsupported" | "failed" }
  /** The call ended without you pressing Leave, with a sentence for the user. */
  | { type: "ended"; message: string };

/** One person's video in the call: their camera or their screen. */
export interface Video { userId: number; source: "camera" | "screen"; track: Track; local: boolean }

const REFRESH_MS = 10 * 60 * 1000;

let room: Room | null = null;
let roomId: number | null = null;
let status: CallStatus = "idle";
let refreshTimer = 0;
let speakingIds = new Set<number>();
let weak = false;
const local = { muted: false, deafened: false, camera: false, screen: false };
let mutedBeforeDeafen = false;
const listeners = new Set<(e: CallEvent) => void>();

/** Hidden home for remote audio elements; outside the screens so switching screens never stops sound. */
const audioSink = (() => {
  const el = document.createElement("div");
  el.id = "call-audio";
  el.hidden = true;
  document.body.appendChild(el);
  return el;
})();

function emit(e: CallEvent) {
  for (const fn of listeners) {
    try { fn(e); } catch (err) { console.error(err); }
  }
}

const idOf = (p: Participant): number => Number(p.identity);

function fail(message: string): ApiError {
  return { error: "voice", message, status: 0 };
}

function captureProblem(e: unknown): "denied" | "missing" | "failed" {
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "missing";
  return "failed";
}

// ─── reading ─────────────────────────────────────────────────────────

export const call = {
  get status(): CallStatus { return status; },
  /** The voice room you're connected (or connecting) to. */
  get roomId(): number | null { return roomId; },
  get muted(): boolean { return local.muted || local.deafened; },
  get deafened(): boolean { return local.deafened; },
  get camera(): boolean { return local.camera; },
  get screen(): boolean { return local.screen; },
  get weak(): boolean { return weak; },
  /** User ids talking right now, loudest first. */
  get speaking(): number[] { return [...speakingIds]; },

  /** Everyone LiveKit sees in the room (you first), with live mic state. */
  participants(): { userId: number; muted: boolean; camera: boolean; screen: boolean; local: boolean }[] {
    if (!room) return [];
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    return all.map((p) => ({
      userId: idOf(p),
      muted: p.isLocal ? call.muted : !p.isMicrophoneEnabled,
      camera: p.isCameraEnabled,
      screen: p.isScreenShareEnabled,
      local: p.isLocal,
    }));
  },

  /** Cameras and screens that can be shown right now. */
  videos(): Video[] {
    if (!room) return [];
    const out: Video[] = [];
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    for (const p of all) {
      for (const [source, kind] of [[Track.Source.Camera, "camera"], [Track.Source.ScreenShare, "screen"]] as const) {
        const pub: TrackPublication | undefined = p.getTrackPublication(source);
        if (pub?.track && !pub.isMuted && (p.isLocal || pub.isSubscribed)) out.push({ userId: idOf(p), source: kind, track: pub.track, local: p.isLocal });
      }
    }
    return out;
  },

  on(fn: (e: CallEvent) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ─── joining and leaving ───────────────────────────────────────────

  /** Join a voice room. Throws an ApiError-shaped object whose message can be shown as-is. */
  async join(id: number): Promise<void> {
    if (roomId === id && status !== "idle") return;
    if (room) await call.leave();
    roomId = id;
    status = "connecting";
    emit({ type: "status" });

    let r: Room | null = null;
    try {
      const grant = await api.voiceToken(id);
      if (roomId !== id) return; // left or switched while asking
      r = new Room(roomOptions());
      room = r;
      wire(r);
      try {
        await r.connect(grant.url, grant.token, { autoSubscribe: true });
      } catch {
        throw fail("Couldn’t connect to voice. Check your internet and try again.");
      }
      if (room !== r) return;
      // Usually inside a click, so the browser lets sound play; if not, the next click unlocks it.
      void r.startAudio().catch(() => {});
      status = "connected";
      emit({ type: "status" });
      await publishMic(r);
      report();
      startRefresh(id);
    } catch (e) {
      if (room === r || room === null) await teardown();
      throw isApiError(e) ? e : fail("Couldn’t join voice. Try again.");
    }
  },

  /** Hang up. The server learns from LiveKit that you left. */
  async leave(): Promise<void> {
    await teardown();
  },

  // ─── your own flags ────────────────────────────────────────────────

  async setMuted(muted: boolean): Promise<void> {
    if (!muted && local.deafened) { local.deafened = false; applyDeafen(); }
    local.muted = muted;
    await applyMic();
    emit({ type: "local" });
    report();
  },

  /** Deafen silences everyone for you and mutes your mic; undeafen puts your mic back how it was. */
  async setDeafened(deafened: boolean): Promise<void> {
    if (deafened === local.deafened) return;
    if (deafened) { mutedBeforeDeafen = local.muted; local.muted = true; }
    else local.muted = mutedBeforeDeafen;
    local.deafened = deafened;
    applyDeafen();
    await applyMic();
    emit({ type: "local" });
    report();
  },

  async setCamera(on: boolean): Promise<void> {
    if (!room || status === "idle") return;
    try {
      await room.localParticipant.setCameraEnabled(on,
        { resolution: VideoPresets.h720.resolution },
        { simulcast: true, videoEncoding: VideoPresets.h720.encoding });
      local.camera = on;
    } catch (e) {
      local.camera = false;
      await room?.localParticipant.setCameraEnabled(false).catch(() => {});
      emit({ type: "capture", kind: "camera", problem: captureProblem(e) });
    }
    emit({ type: "local" });
    emit({ type: "tracks" });
    report();
  },

  async setScreenShare(on: boolean): Promise<void> {
    if (!room || status === "idle") return;
    if (on && !navigator.mediaDevices?.getDisplayMedia) {
      emit({ type: "capture", kind: "screen", problem: "unsupported" });
      return;
    }
    try {
      await room.localParticipant.setScreenShareEnabled(on,
        // System audio where the platform offers it (Windows); macOS web views share picture only.
        { audio: true, systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "include", contentHint: "motion",
          resolution: ScreenSharePresets.h720fps30.resolution },
        { screenShareEncoding: ScreenSharePresets.h720fps30.encoding });
      local.screen = on;
    } catch (e) {
      local.screen = false;
      const problem = captureProblem(e);
      // Closing the picker also says NotAllowedError; only a system refusal is worth a message.
      const bySystem = e instanceof Error && /system/i.test(e.message);
      if (problem !== "denied" || bySystem) emit({ type: "capture", kind: "screen", problem });
    }
    emit({ type: "local" });
    emit({ type: "tracks" });
    report();
  },

  /** Switch microphone or speakers mid-call after a change in Settings. */
  async useDevice(kind: "audioinput" | "audiooutput", deviceId: string): Promise<void> {
    if (kind === "audiooutput") {
      for (const el of audioSink.querySelectorAll("audio")) void setSink(el, deviceId);
      return;
    }
    if (!room) return;
    await room.switchActiveDevice(kind, deviceId || "default").catch(() => {});
  },
};

// ─── internals ───────────────────────────────────────────────────────

function roomOptions(): Partial<RoomOptions> {
  return {
    adaptiveStream: true, // only fetch video at the size it's shown
    dynacast: true, // stop sending layers nobody watches
    audioCaptureDefaults: { ...AUDIO_CAPTURE, deviceId: prefs.mic || undefined },
    audioOutput: { deviceId: prefs.speaker || undefined },
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    // Simulcast lets LiveKit send a lower layer to people on weak connections.
    publishDefaults: { ...PUBLISH, simulcast: true, videoEncoding: VideoPresets.h720.encoding },
    disconnectOnPageLeave: true,
  };
}

async function publishMic(r: Room) {
  let track: LocalAudioTrack | null = null;
  try {
    track = await createLocalAudioTrack({ ...AUDIO_CAPTURE, deviceId: prefs.mic || undefined });
    // Start muted when you asked for it, so not a moment of sound goes out.
    if (call.muted) await track.mute();
    if (room !== r) { track.stop(); return; }
    await r.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
  } catch (e) {
    track?.stop();
    if (room !== r) return;
    local.muted = true;
    emit({ type: "local" });
    emit({ type: "capture", kind: "microphone", problem: captureProblem(e) });
  }
}

async function applyMic() {
  const pub: LocalTrackPublication | undefined = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (!room || status === "idle") return;
  if (!pub?.track) {
    // No mic yet (denied earlier); try again on unmute.
    if (!call.muted) await publishMic(room);
    return;
  }
  if (call.muted) await pub.mute();
  else await pub.unmute();
}

function applyDeafen() {
  for (const el of audioSink.querySelectorAll("audio")) el.muted = local.deafened;
}

async function setSink(el: HTMLMediaElement, deviceId: string) {
  const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof withSink.setSinkId !== "function") return; // macOS web view: system output only
  await withSink.setSinkId(deviceId || "").catch(() => {});
}

/** Tell the server your flags; it shows them to everyone. Best effort: the next change sends them again. */
function report() {
  if (roomId === null || status === "idle") return;
  void api.voiceState(roomId, { muted: call.muted, camera: local.camera, screen: local.screen }).catch(() => {});
}

function startRefresh(id: number) {
  clearInterval(refreshTimer);
  refreshTimer = window.setInterval(async () => {
    if (roomId !== id) return;
    try {
      await api.voiceToken(id);
    } catch (e) {
      // Refused (timed out, room deleted): hang up. Network trouble: try again next time.
      if (isApiError(e) && (e.status === 403 || e.status === 404) && roomId === id) {
        await teardown();
        emit({ type: "ended", message: e.message });
      }
    }
  }, REFRESH_MS);
}

function wire(r: Room) {
  const mine = () => room === r;
  r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (!mine()) return;
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach() as HTMLAudioElement;
      el.muted = local.deafened;
      void setSink(el, prefs.speaker);
      audioSink.appendChild(el);
    } else emit({ type: "tracks" });
  })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
      else if (mine()) emit({ type: "tracks" });
    })
    .on(RoomEvent.TrackMuted, () => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.TrackUnmuted, () => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.LocalTrackPublished, () => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      if (!mine()) return;
      // "Stop sharing" from the system bar ends the share without going through us.
      if (pub.source === Track.Source.ScreenShare && local.screen) { local.screen = false; emit({ type: "local" }); report(); }
      if (pub.source === Track.Source.Camera && local.camera) { local.camera = false; emit({ type: "local" }); report(); }
      emit({ type: "tracks" });
    })
    .on(RoomEvent.ParticipantConnected, (_p: RemoteParticipant) => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.ParticipantDisconnected, (_p: RemoteParticipant) => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      if (!mine()) return;
      speakingIds = new Set(speakers.map(idOf));
      emit({ type: "speaking" });
    })
    .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
      if (!mine() || !p.isLocal) return;
      const poor = q === ConnectionQuality.Poor || q === ConnectionQuality.Lost;
      if (poor !== weak) { weak = poor; emit({ type: "quality", poor }); }
    })
    .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
      if (!mine()) return;
      if (s === ConnectionState.Reconnecting || s === ConnectionState.SignalReconnecting) status = "reconnecting";
      else if (s === ConnectionState.Connected) status = "connected";
      else return;
      emit({ type: "status" });
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      // Sound was blocked until a click; the next click anywhere turns it on.
      if (mine() && !r.canPlaybackAudio) addEventListener("pointerdown", () => void r.startAudio().catch(() => {}), { once: true });
    })
    .on(RoomEvent.MediaDevicesError, (e: Error) => {
      if (mine()) emit({ type: "capture", kind: "microphone", problem: captureProblem(e) });
    })
    .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (!mine() || status === "connecting") return;
      void teardown();
      emit({ type: "ended", message: endedText(reason) });
    });
}

function endedText(reason?: DisconnectReason): string {
  switch (reason) {
    case DisconnectReason.PARTICIPANT_REMOVED: return "You were moved out of the voice room.";
    case DisconnectReason.DUPLICATE_IDENTITY: return "You joined voice from another computer, so this one left.";
    case DisconnectReason.ROOM_DELETED: return "This voice room was deleted.";
    case DisconnectReason.SERVER_SHUTDOWN: return "The voice server restarted. Join again in a moment.";
    default: return "Voice disconnected. Join the room again.";
  }
}

async function teardown() {
  clearInterval(refreshTimer);
  const r = room;
  room = null;
  roomId = null;
  status = "idle";
  speakingIds = new Set();
  weak = false;
  local.camera = false;
  local.screen = false;
  audioSink.replaceChildren();
  emit({ type: "status" });
  emit({ type: "tracks" });
  if (r) await r.disconnect().catch(() => {});
}
