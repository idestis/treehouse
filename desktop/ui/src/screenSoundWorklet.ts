// Audio worklet: plays the computer's sound that Rust captures (macOS) into
// the screen-share audio track. Chunks arrive as 20 ms of 48 kHz stereo
// interleaved i16; a small jitter buffer smooths out IPC timing.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

const SOURCE_RATE = 48_000;
const CAPACITY = SOURCE_RATE; // 1 s per channel
const START = (SOURCE_RATE * 80) / 1000; // wait for 80 ms before playing (also after running dry)
const MAX = (SOURCE_RATE * 250) / 1000; // more than 250 ms queued: drop back to 80 ms (clock drift)

class Pcm extends AudioWorkletProcessor {
  private l = new Float32Array(CAPACITY);
  private r = new Float32Array(CAPACITY);
  private read = 0;
  private write = 0;
  private size = 0;
  private playing = false;
  /** Source frames per output frame (1 when the context runs at 48 kHz). */
  private step = SOURCE_RATE / sampleRate;
  private carry = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => { if (e.data instanceof ArrayBuffer) this.push(e.data); };
  }

  private push(buf: ArrayBuffer) {
    const s = new Int16Array(buf, 0, buf.byteLength >> 1);
    for (let i = 0; i + 1 < s.length; i += 2) {
      if (this.size === CAPACITY) { this.read = (this.read + 1) % CAPACITY; this.size--; }
      this.l[this.write] = s[i] / 32768;
      this.r[this.write] = s[i + 1] / 32768;
      this.write = (this.write + 1) % CAPACITY;
      this.size++;
    }
    if (this.size > MAX) {
      const drop = this.size - START;
      this.read = (this.read + drop) % CAPACITY;
      this.size -= drop;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const left = out?.[0];
    if (!left) return true;
    const right = out[1] ?? left;
    if (!this.playing) {
      if (this.size < START) return true; // silence (outputs start zeroed)
      this.playing = true;
    }
    for (let i = 0; i < left.length; i++) {
      if (this.size === 0) {
        // Ran dry: silence, then wait for the buffer to fill again.
        this.playing = false;
        left.fill(0, i);
        right.fill(0, i);
        break;
      }
      left[i] = this.l[this.read];
      right[i] = this.r[this.read];
      this.carry += this.step;
      const used = Math.min(Math.floor(this.carry), this.size);
      this.carry -= used;
      this.read = (this.read + used) % CAPACITY;
      this.size -= used;
    }
    return true;
  }
}

registerProcessor("treehouse-screen-sound", Pcm);

export {}; // a module, so the declarations above stay local
