// Voice room join and leave sounds (files in ui/public/sounds). Played on top of the
// conversation at your output volume, through your chosen speakers.
import type { SoundName } from "./api/types";
import { prefs } from "./voice";

export type JoinSound = SoundName;

/** One list for both pickers: anything can be a join or a leave sound. */
export const SOUNDS: { value: SoundName; label: string }[] = [
  { value: "ding", label: "Ding" },
  { value: "doink", label: "Doink" },
  { value: "quack", label: "Quack" },
  { value: "hewya", label: "Hewya!" },
  { value: "yeah-boy", label: "Yeah boy!" },
  { value: "fart", label: "Fart" },
  { value: "mmbye", label: "Mm-bye" },
  { value: "female-bye", label: "Bye!" },
  { value: "kiddo-bye", label: "Bye bye (kiddo)" },
  { value: "none", label: "No sound" },
];
export const JOIN_SOUNDS = SOUNDS;

const cache = new Map<string, HTMLAudioElement>();

export function playSound(sound: SoundName | null | undefined) {
  if (!sound || sound === "none") return;
  let base = cache.get(sound);
  if (!base) {
    base = new Audio(`/sounds/${sound}.mp3`);
    base.preload = "auto";
    cache.set(sound, base);
  }
  // A fresh element each time, so two people joining at once both play.
  const a = base.cloneNode(true) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  a.volume = Math.min(1, prefs.outputVolume / 100);
  if (prefs.speaker && a.setSinkId) void a.setSinkId(prefs.speaker).catch(() => {});
  void a.play().catch(() => { /* autoplay blocked or no output device */ });
}

export const playJoinSound = playSound;
