// The computer's sound for screen sharing on macOS. The macOS web view's
// getDisplayMedia shares only the picture, so Rust captures the sound with
// ScreenCaptureKit (src-tauri/src/system_audio.rs) and streams it here; an
// audio worklet turns it into a MediaStreamTrack that the call publishes as
// the screen-share audio. Windows gets sound from getDisplayMedia itself.
import { Channel, invoke } from "@tauri-apps/api/core";
import workletUrl from "./screenSoundWorklet.ts?worker&url";

/** Sound is captured natively here (the macOS app); elsewhere getDisplayMedia carries it. */
export const nativeScreenSound = "__TAURI_INTERNALS__" in window && navigator.userAgent.includes("Mac");

/** Why the sound couldn't start: Screen Recording not allowed, an old macOS, or anything else. */
export type SoundProblem = "permission" | "unsupported" | "failed";

export interface ScreenSound {
  track: MediaStreamTrack;
  /** Stop capturing and free everything. Safe to call twice. */
  stop(): void;
}

const asProblem = (e: unknown): SoundProblem => (e === "permission" || e === "unsupported" ? e : "failed");

/**
 * Start capturing. Create `ctx` while the click that started sharing is
 * still fresh, so the web view lets it run. `onEnded` runs when capture
 * stops on its own (for example the permission was taken away).
 * Throws a SoundProblem.
 */
export async function startScreenSound(ctx: AudioContext, onEnded: () => void): Promise<ScreenSound> {
  let stopped = false;
  let node: AudioWorkletNode | null = null;
  let track: MediaStreamTrack | null = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void invoke("system_audio_stop").catch(() => {});
    node?.port.close();
    node?.disconnect();
    track?.stop();
    void ctx.close().catch(() => {});
  };
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(ctx, "treehouse-screen-sound", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const dst = ctx.createMediaStreamDestination();
    node.connect(dst);
    track = dst.stream.getAudioTracks()[0] ?? null;
    if (!track) throw "failed";
    const port = node.port;
    const channel = new Channel<ArrayBuffer | string>((m) => {
      if (stopped) return;
      if (m instanceof ArrayBuffer) port.postMessage(m, [m]);
      else { stop(); onEnded(); } // "stopped"
    });
    await invoke("system_audio_start", { channel });
    if (stopped) throw "failed";
    await ctx.resume().catch(() => {});
    return { track, stop };
  } catch (e) {
    stop();
    throw asProblem(e);
  }
}
