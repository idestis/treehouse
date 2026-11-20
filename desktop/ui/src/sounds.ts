// Voice room join sounds (files in ui/public/sounds). Played on top of the
// conversation at your output volume, through your chosen speakers.
import { prefs } from "./voice";

export type JoinSound = "ding" | "fart" | "quack" | "hewya" | "none";

export const JOIN_SOUNDS: { value: JoinSound; label: string }[] = [
  { value: "ding", label: "Ding" },
  { value: "quack", label: "Quack" },
  { value: "hewya", label: "Hewya!" },
  { value: "fart", label: "Fart" },
  { value: "none", label: "No sound" },
];

const cache = new Map<string, HTMLAudioElement>();

export function playJoinSound(sound: JoinSound | null | undefined) {
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
