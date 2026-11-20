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
export const prefs = {
  get mic() { return read(MIC_KEY); },
  set mic(v: string) { write(MIC_KEY, v); },
  get speaker() { return read(OUT_KEY); },
  set speaker(v: string) { write(OUT_KEY, v); },
};
