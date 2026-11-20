// Notification preferences (per computer) and the mention chime.
// "Busy" pauses notifications too; the in-app @ badge in the sidebar always shows.

const KEY = "treehouse.notifications";

export function notificationsOn(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}

export function setNotifications(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* preference only */ }
}

let ctx: AudioContext | null = null;

/** A soft two-note chime, made in code (no audio files). */
export function chime(volume = 1) {
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = t + i * 0.11;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12 * volume, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch { /* no audio available */ }
}
