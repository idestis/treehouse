// What call.ts needs to know about effects without loading them: the effects
// code and MediaPipe are fetched only when someone first picks an effect.
export const MASKS = ["skull", "cat", "shades"] as const;
export type Mask = typeof MASKS[number];

/** Two independent choices: blur behind you, and a mask on your face. */
export interface Look { blur: boolean; mask: Mask | null }
export const NO_LOOK: Look = { blur: false, mask: null };
export const lookIsOn = (l: Look) => l.blur || l.mask !== null;
export type EffectProblem = "slow" | "failed";

export function effectsSupported(): boolean {
  try {
    const c = document.createElement("canvas");
    const ok = typeof c.captureStream === "function" && !!c.getContext("webgl2") && typeof Worker === "function";
    c.width = c.height = 0; // let the test context go
    return ok;
  } catch { return false; }
}
