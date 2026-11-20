// The one active voice call: a LiveKit Room plus your own mic, camera and
// screen flags. The server decides who may join (voice token) and who is in
// a room (LiveKit webhooks); this module only connects, publishes and plays.
import {
  AudioPresets, ConnectionQuality, ConnectionState, DisconnectReason, LocalAudioTrack, LocalVideoTrack, Participant, RemoteParticipant,
  RemoteTrack, Room, RoomEvent, ScreenSharePresets, Track, VideoPresets, createLocalAudioTrack,
  type LocalTrackPublication, type RoomOptions, type TrackPublication,
} from "livekit-client";
import { api } from "./api";
import { errorText, isApiError, type ApiError } from "./api/types";
import { t } from "./i18n";
import { nativeScreenSound, startScreenSound, type ScreenSound, type SoundProblem } from "./screenSound";
import { effectsSupported, lookIsOn, NO_LOOK, type EffectProblem, type Look, type Mask } from "./effects/support";
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
  /** A device couldn't be used. `denied` means the OS or the user said no.
   *  `sound`: the screen is shared, only its sound couldn't be. */
  | { type: "capture"; kind: Capture; problem: "denied" | "missing" | "unsupported" | "failed"; sound?: boolean }
  /** The call ended without you pressing Leave, with a sentence for the user. */
  | { type: "ended"; message: string }
  /** The camera effect was switched off because it couldn't run (or ran too slowly) here. */
  | { type: "effect"; problem: EffectProblem };

/** One person's video in the call: their camera or their screen. */
export interface Video { userId: number; source: "camera" | "screen"; track: Track; local: boolean }

const REFRESH_MS = 10 * 60 * 1000;

let room: Room | null = null;
let roomId: number | null = null;
let status: CallStatus = "idle";
let refreshTimer = 0;
/** Who LiveKit says is talking, except you: your own talking comes from the meter below. */
let speakingIds = new Set<number>();
/** You're talking, measured from your own mic here: instant, and independent of the server. */
let selfSpeaking = false;
let weak = false;
const local = { muted: false, deafened: false, camera: false, screen: false };
let mutedBeforeDeafen = false;
const listeners = new Set<(e: CallEvent) => void>();
/** The computer's sound captured natively for the screen share (macOS app). */
let screenSound: ScreenSound | null = null;
let soundGen = 0;
/** Turned off when this Mac turns out not to support it (older than macOS 13). */
let nativeSoundWorks = nativeScreenSound;

/** Movie and game sound: stereo, music bitrate, never cut in silences. */
const SOUND_PUBLISH = { audioPreset: AudioPresets.musicHighQualityStereo, dtx: false, red: false } as const;

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
  /** Camera effects work in this web view (WebGL2, canvas capture, workers). */
  get effectsAvailable(): boolean { return effectsAvailable ??= effectsSupported(); },
  /** This call's camera effects. Not remembered: every call starts with none. */
  get look(): Look { return look; },
  /** Whether a screen share here can carry the computer's sound. */
  get screenSoundAvailable(): boolean {
    return nativeScreenSound ? nativeSoundWorks : !navigator.userAgent.includes("Mac");
  },
  /** User ids talking right now, loudest first. */
  get speaking(): number[] {
    const ids = [...speakingIds];
    if (selfSpeaking && room) ids.unshift(idOf(room.localParticipant));
    return ids;
  },

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

  /** Whether someone's screen share carries sound (a screen-share audio track is published). */
  screenHasSound(userId: number): boolean {
    if (!room) return false;
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    const p = all.find((x) => idOf(x) === userId);
    return !!p?.getTrackPublication(Track.Source.ScreenShareAudio);
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

  /** Settings → Sound sliders, applied live to a call in progress. */
  setMicGain(percent: number) {
    if (micGain) micGain.gain.value = percent / 100;
    else if (percent !== 100 && room) {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (pub?.track) void withMicGain(pub.track as LocalAudioTrack).then(() => { if (room) startMeter(room); });
    }
  },
  setOutputVolume(percent: number) {
    for (const el of audioSink.querySelectorAll("audio")) el.volume = percent / 100;
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
        throw fail(t("call.connectFailed"));
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
      // Left or switched to another room meanwhile: that choice wins, nothing to report.
      if (roomId !== id) { await r?.disconnect().catch(() => {}); return; }
      await teardown();
      throw isApiError(e) ? e : fail(t("call.joinFailed"));
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
      if (on) await applyEffect();
    } catch (e) {
      local.camera = false;
      await room?.localParticipant.setCameraEnabled(false).catch(() => {});
      emit({ type: "capture", kind: "camera", problem: captureProblem(e) });
    }
    emit({ type: "local" });
    emit({ type: "tracks" });
    report();
  },

  /** Blur and mask for this call: applied now, or when the camera turns on. */
  async setLook(change: { blur?: boolean; mask?: Mask | null }): Promise<void> {
    if (status === "idle" || !call.effectsAvailable) return;
    look = { ...look, ...change };
    emit({ type: "local" });
    await applyEffect();
  },

  async setScreenShare(on: boolean): Promise<void> {
    if (!room || status === "idle") return;
    if (on && !navigator.mediaDevices?.getDisplayMedia) {
      emit({ type: "capture", kind: "screen", problem: "unsupported" });
      return;
    }
    const r = room;
    const withSound = on && prefs.screenSound(prefs.screenMode) && call.screenSoundAvailable;
    // macOS app: the sound is captured natively. The audio context is made
    // now, while the click is fresh, so the web view lets it run.
    let ctx: AudioContext | null = null;
    if (withSound && nativeScreenSound) {
      try { ctx = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" }); } catch { ctx = null; }
    }
    if (!on) stopScreenSound();
    const webSound = withSound && !nativeScreenSound;
    try {
      // Sharp text (default): full 1080p, fewer frames, keep resolution when the network is tight.
      // Smooth motion (games): 1080p at 30 fps, drop resolution before frames.
      const motion = prefs.screenMode === "motion";
      const preset = motion ? ScreenSharePresets.h1080fps30 : ScreenSharePresets.h1080fps15;
      await r.localParticipant.setScreenShareEnabled(on,
        // Windows: getDisplayMedia carries the system sound, untouched by voice processing.
        { audio: webSound ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
          systemAudio: webSound ? "include" : "exclude", selfBrowserSurface: "exclude", surfaceSwitching: "include",
          contentHint: motion ? "motion" : "detail", resolution: preset.resolution },
        {
          screenShareEncoding: { maxBitrate: motion ? 4_500_000 : 3_000_000, maxFramerate: motion ? 30 : 15 },
          degradationPreference: motion ? "maintain-framerate" : "maintain-resolution",
          ...SOUND_PUBLISH,
        });
      local.screen = on;
      if (on && ctx && room === r) { void startNativeSound(r, ctx); ctx = null; }
    } catch (e) {
      local.screen = false;
      const problem = captureProblem(e);
      // Closing the picker also says NotAllowedError; only a system refusal is worth a message.
      const bySystem = e instanceof Error && /system/i.test(e.message);
      if (problem !== "denied" || bySystem) emit({ type: "capture", kind: "screen", problem });
    }
    void ctx?.close().catch(() => {});
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
    startMeter(room);
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

// ─── camera effects ──────────────────────────────────────────────────

let effectsAvailable: boolean | undefined;
let look: Look = NO_LOOK;
let effectQueue: Promise<void> = Promise.resolve();

/** Put the chosen effect on the camera, switch it, or take it off. One change at a time. */
function applyEffect(): Promise<void> {
  effectQueue = effectQueue.then(async () => {
    const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return;
    const want = local.camera ? look : NO_LOOK;
    const current = track.getProcessor();
    try {
      if (!lookIsOn(want)) { if (current) await track.stopProcessor(); return; }
      const { EffectsProcessor } = await import("./effects/processor");
      if (current instanceof EffectsProcessor) { current.setLook(want); return; }
      if (current) await track.stopProcessor();
      // Problems found later wait their turn behind this change.
      const later = (problem: EffectProblem) => { effectQueue = effectQueue.then(() => dropEffect(track, problem)); };
      await track.setProcessor(new EffectsProcessor(want, later));
    } catch (e) {
      console.warn("camera effect failed", e);
      await dropEffect(track, "failed");
    }
  });
  return effectQueue;
}

/** The effect can't run here: the camera carries on without it. */
async function dropEffect(track: LocalVideoTrack, problem: EffectProblem) {
  look = NO_LOOK;
  await track.stopProcessor().catch(() => {});
  emit({ type: "local" });
  emit({ type: "effect", problem });
}

/** Microphone volume (Settings → Sound) as a gain stage after the fixed processing. */
let micGain: GainNode | null = null;
function gainProcessor() {
  let processed: MediaStreamTrack | undefined;
  const p = {
    name: "treehouse-mic-gain",
    get processedTrack() { return processed; },
    async init(opts: { track: MediaStreamTrack; audioContext: AudioContext }) {
      const ctx = opts.audioContext;
      micGain = ctx.createGain();
      micGain.gain.value = prefs.micGain / 100;
      const dst = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(new MediaStream([opts.track])).connect(micGain).connect(dst);
      processed = dst.stream.getAudioTracks()[0];
    },
    async restart(opts: { track: MediaStreamTrack; audioContext: AudioContext }) { await p.destroy(); await p.init(opts); },
    async destroy() { micGain?.disconnect(); micGain = null; processed?.stop(); processed = undefined; },
  };
  return p;
}

async function withMicGain(track: LocalAudioTrack) {
  if (prefs.micGain === 100) return;
  try {
    await track.setAudioContext(new AudioContext());
    await track.setProcessor(gainProcessor());
  } catch { /* the level stays at 100% if the web view can't process audio */ }
}

async function publishMic(r: Room) {
  let track: LocalAudioTrack | null = null;
  try {
    track = await createLocalAudioTrack({ ...AUDIO_CAPTURE, deviceId: prefs.mic || undefined });
    await withMicGain(track);
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

/** Start the macOS app's native sound for the screen share that was just published. */
async function startNativeSound(r: Room, ctx: AudioContext) {
  const gen = ++soundGen;
  const current = () => gen === soundGen && room === r && local.screen;
  let sound: ScreenSound | null = null;
  try {
    sound = await startScreenSound(ctx, () => {
      // Capture stopped on its own (permission taken away): keep the picture, drop the sound.
      if (gen !== soundGen || room !== r) return;
      stopScreenSound();
      unpublishScreenSound(r);
      emit({ type: "capture", kind: "screen", problem: "failed", sound: true });
    });
    if (!current()) { sound.stop(); return; }
    screenSound = sound;
    await r.localParticipant.publishTrack(sound.track,
      { source: Track.Source.ScreenShareAudio, name: "screen-audio", forceStereo: true, ...SOUND_PUBLISH });
    if (!current()) unpublishScreenSound(r);
  } catch (e) {
    if (screenSound === sound) stopScreenSound();
    else sound?.stop();
    if (gen !== soundGen || room !== r) return;
    const why: SoundProblem = e === "permission" || e === "unsupported" ? e : "failed";
    if (why === "unsupported") nativeSoundWorks = false;
    emit({ type: "capture", kind: "screen", problem: why === "permission" ? "denied" : why, sound: true });
  }
}

function stopScreenSound() {
  soundGen++;
  const s = screenSound;
  screenSound = null;
  s?.stop();
}

function unpublishScreenSound(r: Room) {
  const pub = r.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  if (pub?.track) void r.localParticipant.unpublishTrack(pub.track).catch(() => {});
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
        emit({ type: "ended", message: errorText(e) });
      }
    }
  }, REFRESH_MS);
}

function wire(r: Room) {
  const mine = () => room === r;
  r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (!mine()) return;
    // A screen share's sound changes what the stage shows ("With sound").
    if (track.source === Track.Source.ScreenShareAudio) emit({ type: "tracks" });
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach() as HTMLAudioElement;
      el.muted = local.deafened;
      el.volume = prefs.outputVolume / 100;
      void setSink(el, prefs.speaker);
      audioSink.appendChild(el);
    } else emit({ type: "tracks" });
  })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) track.detach().forEach((el) => el.remove());
      if (track.source === Track.Source.ScreenShareAudio && mine()) emit({ type: "tracks" });
      else if (mine()) emit({ type: "tracks" });
    })
    .on(RoomEvent.TrackMuted, () => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.TrackUnmuted, () => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
      if (!mine()) return;
      if (pub.source === Track.Source.Microphone) startMeter(r);
      emit({ type: "tracks" });
    })
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      if (!mine()) return;
      // "Stop sharing" from the system bar ends the share without going through us.
      if (pub.source === Track.Source.ScreenShare) {
        // The picture ended: its sound goes with it (a live track is only being republished).
        if (pub.track?.mediaStreamTrack.readyState !== "live") { stopScreenSound(); unpublishScreenSound(r); }
        if (local.screen) { local.screen = false; emit({ type: "local" }); report(); }
      }
      if (pub.source === Track.Source.Camera && local.camera) { local.camera = false; emit({ type: "local" }); report(); }
      emit({ type: "tracks" });
    })
    .on(RoomEvent.ParticipantConnected, (_p: RemoteParticipant) => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.ParticipantDisconnected, (_p: RemoteParticipant) => mine() && emit({ type: "tracks" }))
    .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      if (!mine()) return;
      speakingIds = new Set(speakers.filter((p) => !p.isLocal).map(idOf));
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

// ─── your own talking ────────────────────────────────────────────────
// LiveKit's speaker list comes back from the server, a beat late, and only
// when it hears your audio; your own glow is measured here instead.

const SPEECH_DBFS = -50; // louder than this (after noise suppression) counts as talking
const HOLD_MS = 450;     // stay lit through the gaps between words

let meter: { track: MediaStreamTrack; ctx: AudioContext; timer: number } | null = null;

/** Measure the mic you're sending now. Safe to call again: a new track restarts it. */
function startMeter(r: Room) {
  const t = r.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
  const track = t?.sender?.track ?? t?.mediaStreamTrack; // what goes out, after the volume slider
  if (!track || meter?.track === track) return;
  stopMeter();
  let ctx: AudioContext;
  try { ctx = new AudioContext(); } catch { return; }
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
  // A context made outside a click may start paused; the next click wakes it.
  if (ctx.state === "suspended") addEventListener("pointerdown", () => void ctx.resume().catch(() => {}), { once: true });
  const buf = new Float32Array(analyser.fftSize);
  let lastLoud = 0;
  const timer = window.setInterval(() => {
    if (room !== r) { stopMeter(); return; }
    let loud = false;
    if (!call.muted) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      loud = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-9) > SPEECH_DBFS;
    }
    const now = performance.now();
    if (loud) lastLoud = now;
    const talking = !call.muted && now - lastLoud < HOLD_MS;
    if (talking !== selfSpeaking) { selfSpeaking = talking; emit({ type: "speaking" }); }
  }, 80);
  meter = { track, ctx, timer };
}

function stopMeter() {
  if (meter) { clearInterval(meter.timer); void meter.ctx.close().catch(() => {}); meter = null; }
  selfSpeaking = false;
}

function endedText(reason?: DisconnectReason): string {
  switch (reason) {
    case DisconnectReason.PARTICIPANT_REMOVED: return t("call.endedRemoved");
    case DisconnectReason.DUPLICATE_IDENTITY: return t("call.endedElsewhere");
    case DisconnectReason.ROOM_DELETED: return t("call.endedDeleted");
    case DisconnectReason.SERVER_SHUTDOWN: return t("call.endedRestart");
    default: return t("call.endedOther");
  }
}

async function teardown() {
  clearInterval(refreshTimer);
  stopScreenSound();
  const r = room;
  room = null;
  roomId = null;
  status = "idle";
  speakingIds = new Set();
  stopMeter();
  weak = false;
  local.camera = false;
  local.screen = false;
  look = NO_LOOK; // effects last one call
  audioSink.replaceChildren();
  emit({ type: "status" });
  emit({ type: "tracks" });
  if (r) await r.disconnect().catch(() => {});
}
