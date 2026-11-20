// Voice room join and leave sounds (files in ui/public/sounds). Played on top of the
// conversation at your output volume, through your chosen speakers.
import type { SoundName } from "./api/types";
import { prefs } from "./voice";

export type JoinSound = SoundName;

/** Greetings to come in… */
export const JOIN_SOUNDS: { value: SoundName; label: string }[] = [
  { value: "ding", label: "Ding" },
  { value: "doink", label: "Doink" },
  { value: "quack", label: "Quack" },
  { value: "hewya", label: "Hewya!" },
  { value: "yeah-boy", label: "Yeah boy!" },
  { value: "fart", label: "Fart" },
  { value: "none", label: "No sound" },
];

/** …goodbyes to go. */
export const LEAVE_SOUNDS: { value: SoundName; label: string }[] = [
  { value: "mmbye", label: "Mm-bye" },
  { value: "female-bye", label: "Bye!" },
  { value: "kiddo-bye", label: "Bye bye (kiddo)" },
  { value: "none", label: "No sound" },
];

/**
 * Per-file gain (dB) so every sound plays at about -18 dBFS: measured RMS of the
 * audible part, with boosts capped so peaks stay under -1 dBFS. Re-measure when
 * adding a file (see docs/decisions.md for the method).
 */
const GAIN_DB: Record<Exclude<SoundName, "none">, number> = {
  ding: -1.0,
  doink: 5.0,
  fart: 4.5,
  "female-bye": 10.1,
  hewya: -1.0,
  "kiddo-bye": -6.9,
  mmbye: -0.2,
  quack: -4.2,
  "yeah-boy": 3.6,
};

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

function context(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    // Follow the chosen speakers where the web view allows it (not on macOS WKWebView).
    const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (prefs.speaker && withSink.setSinkId) void withSink.setSinkId(prefs.speaker).catch(() => {});
  }
  return ctx;
}

function load(sound: string): Promise<AudioBuffer | null> {
  let b = buffers.get(sound);
  if (!b) {
    b = fetch(`/sounds/${sound}.mp3`)
      .then((r) => r.arrayBuffer())
      .then((data) => context().decodeAudioData(data))
      .catch(() => null);
    buffers.set(sound, b);
  }
  return b;
}

/** Join, leave and test sounds: levelled per file, at your Sounds volume. Overlapping plays mix. */
export function playSound(sound: SoundName | null | undefined) {
  if (!sound || sound === "none") return;
  const volume = prefs.soundsVolume / 100;
  if (volume <= 0) return;
  void load(sound).then((buffer) => {
    if (!buffer) return;
    const c = context();
    void c.resume().catch(() => {});
    const src = c.createBufferSource();
    src.buffer = buffer;
    const gain = c.createGain();
    gain.gain.value = 10 ** (GAIN_DB[sound] / 20) * volume;
    src.connect(gain).connect(c.destination);
    src.start();
  });
}

export const playJoinSound = playSound;
