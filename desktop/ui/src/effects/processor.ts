// Camera effects as a LiveKit track processor: the camera goes in, a canvas
// with the effect drawn on it goes out, and LiveKit sends that instead.
//
// Built to be light on CPU and battery:
// - nothing runs for "No effect" (call.ts removes the processor entirely);
// - only the one model the effect needs is loaded and run;
// - output is capped at 24 frames a second, and a frame is only drawn when
//   the camera has a new one;
// - the models see a small copy of the frame and run on at most every other
//   frame (12 a second), less on a slow computer or with no face in view; the
//   face in between is predicted from how it was moving;
// - drawing is all on the GPU, with the low-power GPU asked for, and the
//   picture sent is 540p (less to draw, and less for the video encoder).
import type { Track, TrackProcessor, VideoProcessorOptions } from "livekit-client";
import { paintArt, placeProp, propArt, type Paint, type Prop } from "./art";
import { Renderer, type Overlay } from "./gl";
import { faceModel, segmentModel, type FaceModel, type SegmentModel } from "./models";
import type { EffectProblem, Look, Mask } from "./support";

const FPS = 24;
const FACE_POINTS = 468;
/** Model runs every Nth frame: 2 normally (12 a second), up to 4 on a slow computer. */
const MIN_STRIDE = 2;
const MAX_STRIDE = 4;
/** Milliseconds per model run: slower runs less often, faster runs more often, and too slow gives up. */
const SLOW_MS = 14;
const FAST_MS = 7;
const TOO_SLOW_MS = 40;
/** The first runs compile shaders and warm caches; they don't count. */
const WARMUP_RUNS = 6;
/** Width of the copy of the frame the models see. */
const FACE_INPUT = 480;
const SEG_INPUT = 256;
/** Output width with an effect on: 540p is plenty for the call tiles, and cheaper to draw and to encode. */
const OUTPUT_WIDTH = 960;

const MASK_ART: Record<Mask, { paint?: Paint; props?: Prop[] }> = {
  skull: { paint: "skull" },
  cat: { paint: "cat", props: ["ears"] },
  shades: { props: ["shades"] },
};

// ─── one shared clock ───
const ticks = new Set<() => void>();
let ticker: Worker | null = null;
function onTick(fn: () => void): () => void {
  if (!ticker) {
    ticker = new Worker(new URL("./ticker.worker.ts", import.meta.url), { type: "module" });
    ticker.onmessage = () => { for (const f of ticks) f(); };
    ticker.postMessage(Math.round(1000 / FPS));
  }
  ticks.add(fn);
  return () => {
    ticks.delete(fn);
    if (!ticks.size && ticker) { ticker.terminate(); ticker = null; }
  };
}

/** Kept in the page but out of sight: some web views only update media and canvases that are in the document. */
function hidden<T extends HTMLElement>(el: T): T {
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
  document.body.appendChild(el);
  return el;
}

export class EffectsProcessor implements TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  readonly name = "treehouse-effects";
  processedTrack?: MediaStreamTrack;

  private source: MediaStreamTrack | null = null;
  private video = hidden(document.createElement("video"));
  private out = hidden(document.createElement("canvas"));
  private small = document.createElement("canvas");
  // The models read this copy back on the CPU: keep it there, not on the GPU.
  private smallCtx = this.small.getContext("2d", { alpha: false, willReadFrequently: true });
  private renderer: Renderer | null = null;
  private stopTick: (() => void) | null = null;
  /** Set when the camera delivers a picture (where the web view can tell us). */
  private fresh = true;
  private lastFresh = 0;
  private lastDraw = 0;
  private watching = false;
  private lastStamp = 0;
  private n = 0;
  private stopped = false;

  private face: FaceModel | null = null;
  private seg: SegmentModel | null = null;

  /** Landmarks as drawn this frame (x, y per point, 0–1). */
  private points = new Float32Array(FACE_POINTS * 2);
  /** Smoothed landmarks from the last model run, and their movement per frame. */
  private anchor = new Float32Array(FACE_POINTS * 2);
  private velocity = new Float32Array(FACE_POINTS * 2);
  private sinceRun = 0;
  private hasPoints = false;
  private lastFace = 0;
  private lastFaceFrame = 0;
  private alpha = 0;
  private props = new Map<Prop, Float32Array>();

  private mask: Uint8Array | null = null;

  /** How often the model runs (every Nth frame), adapted to this computer. */
  private stride = MIN_STRIDE;
  private runs = 0;
  private avgMs = 0;
  private slowStreak = 0;

  /** The last look asked for; `look` is the one being drawn. */
  private wanted: Look;
  private warmTimer = 0;

  constructor(private look: Look, private report: (p: EffectProblem) => void) {
    this.wanted = look;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.disablePictureInPicture = true;
  }

  async init(opts: VideoProcessorOptions): Promise<void> {
    try {
      this.renderer = new Renderer(this.out);
    } catch (e) {
      console.warn("effects: no WebGL2", e);
      throw e; // setProcessor fails, and call.ts reports it
    }
    this.out.addEventListener("webglcontextlost", () => this.onProblem("failed"));
    await this.useTrack(opts.track);
    this.processedTrack = this.out.captureStream().getVideoTracks()[0];
    this.stopTick = onTick(() => this.frame());
    if (await this.load(this.look)) this.warmOther();
  }

  /**
   * Each model brings its own copy of the runtime, which takes seconds to
   * start. Start the unused one quietly once this one is running, so adding
   * blur or a mask later is instant.
   */
  private warmOther() {
    this.warmTimer = window.setTimeout(() => {
      void (this.look.blur ? faceModel() : segmentModel()).catch(() => { /* tried again when picked */ });
    }, 4000);
  }

  async restart(opts: VideoProcessorOptions): Promise<void> {
    await this.useTrack(opts.track);
  }

  async destroy(): Promise<void> {
    // Releasing the GPU context below fires "context lost": that's us, not a problem to report.
    this.stopped = true;
    this.stopTick?.();
    this.stopTick = null;
    clearTimeout(this.warmTimer);
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.video.srcObject = null;
    this.video.remove();
    this.out.remove();
    this.renderer?.dispose();
    this.renderer = null;
  }

  /**
   * Change blur or the mask without a new processor (the camera never
   * blinks). The current look stays on until the new one's models are ready.
   */
  setLook(look: Look) {
    if (look.blur === this.wanted.blur && look.mask === this.wanted.mask) return;
    this.wanted = look;
    void this.load(look).then((ok) => {
      if (!ok || this.wanted !== look) return;
      if (look.blur && !this.look.blur) this.mask = null;
      if (look.mask !== this.look.mask) this.alpha = 0;
      this.look = look;
      this.stride = MIN_STRIDE;
      this.runs = 0;
      this.avgMs = 0;
      this.slowStreak = 0;
    });
  }

  /** Tell call.ts once; it takes the processor off and the camera goes on without it. */
  private onProblem(p: EffectProblem) {
    if (this.stopped) return;
    this.stopped = true;
    this.report(p);
  }

  private async useTrack(track: MediaStreamTrack) {
    this.source = track;
    this.video.srcObject = new MediaStream([track]);
    await this.video.play().catch(() => { /* starts with the next frame anyway */ });
    this.watchFrames();
  }

  /** Note each new camera picture, so a frame is only drawn when there's something new. */
  private watchFrames() {
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (this.watching || typeof v.requestVideoFrameCallback !== "function") return;
    this.watching = true;
    const next = () => {
      if (!this.renderer) { this.watching = false; return; }
      this.fresh = true;
      this.lastFresh = performance.now();
      v.requestVideoFrameCallback!(next);
    };
    v.requestVideoFrameCallback(next);
  }

  /** Get the models a look needs. Returns whether they're ready. */
  private async load(want: Look): Promise<boolean> {
    try {
      if (want.blur) this.seg ??= await segmentModel();
      if (want.mask) this.face ??= await faceModel();
      return true;
    } catch (e) {
      console.error("effects: model failed to load", want, e);
      if (this.wanted === want) this.onProblem("failed");
      return false;
    }
  }

  // ─── every tick ───

  private frame() {
    const v = this.video, r = this.renderer;
    if (!r || this.stopped || this.source?.readyState !== "live" || v.readyState < 2 || !v.videoWidth) return;
    const now = performance.now();
    // Ticks that queued up while the page was busy arrive together: take one.
    if (now - this.lastDraw < 1000 / FPS - 8) return;
    // Only when the camera has a new picture (a dim room can drop it to 15 fps).
    // Frame callbacks pause while the window is hidden: then draw every tick,
    // or your camera would freeze for everyone else.
    const callbacksLive = this.watching && now - this.lastFresh < 250;
    if (callbacksLive && !this.fresh) return;
    this.fresh = false;
    this.lastDraw = now;
    const scale = Math.min(1, OUTPUT_WIDTH / v.videoWidth);
    r.resize(Math.round(v.videoWidth * scale), Math.round(v.videoHeight * scale));
    this.n++;

    const blur = this.look.blur && !!this.seg;
    const mask = this.look.mask && this.face ? this.look.mask : null;
    // With both on, the two models take turns, so a frame never runs both.
    if (blur && this.turn(now, false, 1)) this.runSegment(now);
    const ran = !!mask && this.turn(now, true, 0) && this.runFace(now);
    if (mask && this.hasPoints && !ran) this.predict();

    const overlays: Overlay[] = [];
    if (mask && this.hasPoints) {
      const art = MASK_ART[mask];
      // Fade in when a face appears and out shortly after it's gone.
      const seen = now - this.lastFace < 300;
      this.alpha = Math.max(0, Math.min(1, this.alpha + (seen ? 0.25 : -0.2)));
      if (art.paint) overlays.push({ art: paintArt(art.paint), points: this.points, mesh: true });
      for (const kind of art.props ?? []) {
        let corners = this.props.get(kind);
        if (!corners) this.props.set(kind, corners = new Float32Array(8));
        placeProp(kind, this.points, v.videoWidth, v.videoHeight, corners);
        overlays.push({ art: propArt(kind), points: corners, mesh: false });
      }
    }
    try {
      r.draw(v, blur && !!this.mask, overlays, this.alpha);
    } catch (e) {
      console.error("effects: draw failed", this.look, e);
      this.onProblem("failed");
    }
  }

  /** Whether a model runs this frame. `slot` offsets blur from the face when both are on. */
  private turn(now: number, face: boolean, slot: number): boolean {
    // Without a face in view, look for one only a few times a second.
    const stride = face && now - this.lastFace > 1000 ? 8 : this.stride;
    const both = this.look.blur && this.look.mask !== null;
    return this.n % stride === (both ? slot % stride : 0);
  }

  private stamp(now: number): number {
    return (this.lastStamp = Math.max(now, this.lastStamp + 1)); // MediaPipe wants rising timestamps
  }

  private runSegment(now: number) {
    const t0 = performance.now();
    try {
      const m = this.seg!.segment(this.shrink(SEG_INPUT), this.stamp(now));
      if (m) this.takeMask(m.data, m.width, m.height);
    } catch (e) {
      console.error("effects: blur model run failed", e);
      this.onProblem("failed");
      return;
    }
    this.budget(performance.now() - t0);
  }

  private runFace(now: number): boolean {
    const t0 = performance.now();
    try {
      const lm = this.face!.detect(this.shrink(FACE_INPUT), this.stamp(now));
      if (lm && lm.length >= FACE_POINTS) {
        this.takePoints(lm, this.video.videoWidth, this.video.videoHeight);
        this.lastFace = now;
      }
    } catch (e) {
      console.error("effects: face model run failed", e);
      this.onProblem("failed");
      return false;
    }
    this.budget(performance.now() - t0);
    return true;
  }

  /** Run the model less often on a slow computer; give up if even that is too much. */
  private budget(ms: number) {
    if (++this.runs <= WARMUP_RUNS) return;
    this.avgMs = this.avgMs ? this.avgMs * 0.85 + ms * 0.15 : ms;
    if (this.runs % 10 !== 0) return; // decide about once a second
    if (this.avgMs > SLOW_MS && this.stride < MAX_STRIDE) this.stride++;
    else if (this.avgMs < FAST_MS && this.stride > MIN_STRIDE) this.stride--;
    if (this.stride === MAX_STRIDE && this.avgMs > TOO_SLOW_MS) {
      if (++this.slowStreak >= 3) this.onProblem("slow");
    } else this.slowStreak = 0;
  }

  private shrink(width: number): HTMLCanvasElement {
    const v = this.video;
    const h = Math.round((width * v.videoHeight) / v.videoWidth);
    if (this.small.width !== width || this.small.height !== h) { this.small.width = width; this.small.height = h; }
    this.smallCtx?.drawImage(v, 0, 0, width, h);
    return this.small;
  }

  private takeMask(data: Float32Array, w: number, h: number) {
    const fresh = !this.mask || this.mask.length !== data.length;
    if (fresh) this.mask = new Uint8Array(data.length);
    const m = this.mask!;
    // A little of the last mask stays in, so the edge doesn't flicker.
    for (let i = 0; i < data.length; i++) {
      const v = data[i] * 255;
      m[i] = fresh ? v : m[i] * 0.4 + v * 0.6;
    }
    this.renderer?.setMask(m, w, h);
  }

  /** Smooth jitter when still, follow at once when moving; note the movement for predict(). */
  private takePoints(lm: { x: number; y: number }[], w: number, h: number) {
    const a = this.anchor, vel = this.velocity;
    const frames = Math.max(1, this.sinceRun);
    this.sinceRun = 0;
    if (!this.hasPoints || this.n - this.lastFaceFrame > 12) {
      for (let i = 0; i < FACE_POINTS; i++) { a[i * 2] = lm[i].x; a[i * 2 + 1] = lm[i].y; }
      vel.fill(0);
    } else {
      let move = 0;
      for (const i of [1, 33, 263, 61, 291, 152, 10]) move += Math.hypot((lm[i].x - a[i * 2]) * w, (lm[i].y - a[i * 2 + 1]) * h);
      const k = Math.min(1, Math.max(0.4, move / 7 / 6)); // 6 px average movement → no smoothing
      for (let i = 0; i < FACE_POINTS * 2; i++) {
        const next = a[i] + ((i & 1 ? lm[i >> 1].y : lm[i >> 1].x) - a[i]) * k;
        vel[i] = (next - a[i]) / frames;
        a[i] = next;
      }
    }
    this.points.set(a);
    this.hasPoints = true;
    this.lastFaceFrame = this.n;
  }

  /** Between model runs, keep the face moving the way it was (for a few frames at most). */
  private predict() {
    if (++this.sinceRun > MAX_STRIDE) return;
    const a = this.anchor, vel = this.velocity, p = this.points, s = this.sinceRun;
    for (let i = 0; i < FACE_POINTS * 2; i++) p[i] = a[i] + vel[i] * s;
  }
}
