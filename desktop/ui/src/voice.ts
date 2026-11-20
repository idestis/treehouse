// Fixed voice settings (spec §10), from reference/prototype/desktop/ui/main.js.
// Used for the mic test now and for LiveKit when voice lands (milestone 7).

export const AUDIO_CAPTURE = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: true, // used where the webview supports it, ignored elsewhere
  channelCount: 1,
  sampleRate: 48000,
};

export const PUBLISH = {
  dtx: true,
  red: true,
  audioPreset: { maxBitrate: 48_000 },
  stopMicTrackOnMute: false, // unmuting is instant
};

// Chosen devices are a per-computer preference, not account data.
const MIC_KEY = "treehouse.mic";
const OUT_KEY = "treehouse.speaker";
const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* preference only */ } };
const MIC_GAIN_KEY = "treehouse.micGain";
const OUT_GAIN_KEY = "treehouse.outputVolume";
const percent = (k: string) => {
  const n = Number(read(k));
  return Number.isFinite(n) && read(k) !== "" ? Math.min(k === OUT_GAIN_KEY ? 100 : 200, Math.max(0, n)) : 100;
};

export const prefs = {
  get mic() { return read(MIC_KEY); },
  set mic(v: string) { write(MIC_KEY, v); },
  get speaker() { return read(OUT_KEY); },
  set speaker(v: string) { write(OUT_KEY, v); },
  /** Microphone volume in percent (0–200), applied after the fixed processing. */
  get micGain() { return percent(MIC_GAIN_KEY); },
  set micGain(v: number) { write(MIC_GAIN_KEY, String(Math.round(v))); },
  /** Open a voice room = join it right away (otherwise: double-click or the Join button). */
  get autoJoin() { return read("treehouse.autoJoin") === "1"; },
  set autoJoin(v: boolean) { write("treehouse.autoJoin", v ? "1" : "0"); },
  /** Join with the microphone muted. */
  get joinMuted() { return read("treehouse.joinMuted") === "1"; },
  set joinMuted(v: boolean) { write("treehouse.joinMuted", v ? "1" : "0"); },
  /** Turn the camera on when joining (off by default, spec §10). */
  get joinCamera() { return read("treehouse.joinCamera") === "1"; },
  set joinCamera(v: boolean) { write("treehouse.joinCamera", v ? "1" : "0"); },
  /** Screen sharing: sharp text (1080p, 15 fps) or smooth motion for games (1080p, 30 fps). */
  get screenMode(): "text" | "motion" { return read("treehouse.screenMode") === "motion" ? "motion" : "text"; },
  set screenMode(v: "text" | "motion") { write("treehouse.screenMode", v); },
  /** Join, leave and mention sounds, separate from people's voices (0–100, default 70). */
  get soundsVolume() { const n = Number(read("treehouse.soundsVolume")); return read("treehouse.soundsVolume") !== "" && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 70; },
  set soundsVolume(v: number) { write("treehouse.soundsVolume", String(Math.round(v))); },
  /** Desktop app: open the small "people on top" window when you start sharing (on by default). */
  get overlayWhileSharing() { return read("treehouse.overlayWhileSharing") !== "0"; },
  set overlayWhileSharing(v: boolean) { write("treehouse.overlayWhileSharing", v ? "1" : "0"); },
  /** Share the computer's sound with the screen: on by default for "Watching or playing", off for "Reading together". */
  screenSound(mode: "text" | "motion"): boolean {
    const v = read(`treehouse.screenSound.${mode}`);
    return v === "" ? mode === "motion" : v === "1";
  },
  setScreenSound(mode: "text" | "motion", on: boolean) { write(`treehouse.screenSound.${mode}`, on ? "1" : "0"); },
  /** Output volume in percent (0–100) for everyone you hear. */
  get outputVolume() { return percent(OUT_GAIN_KEY); },
  set outputVolume(v: number) { write(OUT_GAIN_KEY, String(Math.round(v))); },
};
