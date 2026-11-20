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
  return Number.isFinite(n) && read(k) !== "" ? Math.min(200, Math.max(0, n)) : 100;
};

export const prefs = {
  get mic() { return read(MIC_KEY); },
  set mic(v: string) { write(MIC_KEY, v); },
  get speaker() { return read(OUT_KEY); },
  set speaker(v: string) { write(OUT_KEY, v); },
  /** Microphone volume in percent (0–200), applied after the fixed processing. */
  get micGain() { return percent(MIC_GAIN_KEY); },
  set micGain(v: number) { write(MIC_GAIN_KEY, String(Math.round(v))); },
  /** Output volume in percent (0–200) for everyone you hear. */
  get outputVolume() { return percent(OUT_GAIN_KEY); },
  set outputVolume(v: number) { write(OUT_GAIN_KEY, String(Math.round(v))); },
};
