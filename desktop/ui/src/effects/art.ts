// The pictures behind each mask, drawn once with a 2D canvas. Face paint is
// drawn in the face model's texture space (see faceMesh.ts), placed by the
// same landmark numbers the tracker returns, so it lines up with any face.
// Props (ears, glasses) are flat pictures placed on the face every frame.
import { UVS } from "./faceMesh";

export type Paint = "skull" | "cat";
export type Prop = "ears" | "shades";

type Pt = [number, number];

const SIZE = 1024;
const P = (i: number): Pt => [UVS[i * 2] * SIZE, UVS[i * 2 + 1] * SIZE];
const lerp = (a: Pt, b: Pt, k: number): Pt => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const centroid = (pts: Pt[]): Pt => {
  const s = pts.reduce<Pt>((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
  return [s[0] / pts.length, s[1] / pts.length];
};
const scaled = (pts: Pt[], k: number, c = centroid(pts)): Pt[] => pts.map((p) => lerp(c, p, k));

// Landmark rings (MediaPipe face mesh numbering).
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_B = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
const BROW_A = [70, 63, 105, 66, 107];
const BROW_B = [300, 293, 334, 296, 336];

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  return [c, ctx];
}

function path(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/** Fill a shape with a soft edge: only its blurred shadow is drawn, shifted back into place. */
function softFill(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, blur: number) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = SIZE * 4;
  ctx.translate(-SIZE * 4, 0);
  path(ctx, pts);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
}

function flower(ctx: CanvasRenderingContext2D, [x, y]: Pt, r: number, petal: string, heart: string, petals = 6) {
  ctx.fillStyle = petal;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.62, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = heart;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

/** Cut a hole (eyes, open mouth) so the real face shows through. */
function cut(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  path(ctx, pts);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
}

function skull(ctx: CanvasRenderingContext2D) {
  const oval = FACE_OVAL.map(P);
  const faceW = dist(P(234), P(454));
  const ink = "#3a2238";
  softFill(ctx, scaled(oval, 0.96), "rgba(250, 244, 238, 0.94)", 28);

  // Eye sockets with a ring of petals.
  for (const ring of [EYE_A, EYE_B]) {
    const eye = ring.map(P);
    const c = centroid(eye);
    const w = dist(eye[0], eye[8]);
    const rx = w * 0.95, ry = w * 0.72, cy = c[1] - w * 0.08;
    ctx.fillStyle = "#f7b733";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c[0] + Math.cos(a) * rx * 1.12, cy + Math.sin(a) * ry * 1.16, w * 0.15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#e9435e";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c[0] + Math.cos(a) * rx * 1.12, cy + Math.sin(a) * ry * 1.16, w * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(74, 42, 90, 0.92)";
    ctx.beginPath();
    ctx.ellipse(c[0], cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Upside-down heart over the nose.
  const l = P(98), r = P(327), base = P(2);
  const nw = dist(l, r);
  const top = lerp(base, P(6), 0.5);
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(top[0], top[1]);
  ctx.quadraticCurveTo(l[0] - nw * 0.15, l[1] - nw * 0.1, l[0], base[1]);
  ctx.arc(lerp(l, base, 0.5)[0], base[1], dist(l, base) / 2, Math.PI, 0, true);
  ctx.arc(lerp(base, r, 0.5)[0], base[1], dist(base, r) / 2, Math.PI, 0, true);
  ctx.quadraticCurveTo(r[0] + nw * 0.15, r[1] - nw * 0.1, top[0], top[1]);
  ctx.fill();

  // Lips and stitches.
  path(ctx, LIPS_OUTER.map(P));
  ctx.fillStyle = "rgba(194, 24, 91, 0.85)";
  ctx.fill();
  const a = P(61), b = P(291);
  const a2 = lerp(b, a, 1.4), b2 = lerp(a, b, 1.4);
  const len = dist(a2, b2), nx = -(b2[1] - a2[1]) / len, ny = (b2[0] - a2[0]) / len;
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineWidth = faceW * 0.008;
  ctx.beginPath();
  ctx.moveTo(a2[0], a2[1]);
  ctx.lineTo(b2[0], b2[1]);
  const tick = faceW * 0.03;
  for (let i = 0; i <= 12; i++) {
    const p = lerp(a2, b2, i / 12);
    ctx.moveTo(p[0] - nx * tick, p[1] - ny * tick);
    ctx.lineTo(p[0] + nx * tick, p[1] + ny * tick);
  }
  ctx.stroke();

  // Flowers and dots.
  flower(ctx, P(151), faceW * 0.045, "#e9435e", "#f7b733");
  flower(ctx, P(199), faceW * 0.03, "#f7b733", "#e9435e", 5);
  flower(ctx, P(187), faceW * 0.04, "#ff8a3d", "#f7b733");
  flower(ctx, P(411), faceW * 0.04, "#ff8a3d", "#f7b733");
  ctx.fillStyle = "#e9435e";
  for (const brow of [BROW_A, BROW_B]) {
    for (const i of brow) {
      const [x, y] = P(i);
      ctx.beginPath();
      ctx.arc(x, y - faceW * 0.05, faceW * 0.011, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const ring of [EYE_A, EYE_B]) cut(ctx, scaled(ring.map(P), 1.12));
  cut(ctx, LIPS_INNER.map(P));
}

function cat(ctx: CanvasRenderingContext2D) {
  const faceW = dist(P(234), P(454));
  // Blush.
  for (const i of [50, 280]) {
    const [x, y] = P(i);
    const g = ctx.createRadialGradient(x, y, 0, x, y, faceW * 0.1);
    g.addColorStop(0, "rgba(255, 120, 160, 0.45)");
    g.addColorStop(1, "rgba(255, 120, 160, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - faceW * 0.1, y - faceW * 0.1, faceW * 0.2, faceW * 0.2);
  }
  // Nose: a rounded pink triangle on the tip.
  const l = P(98), r = P(327), base = P(2);
  const top = lerp(base, P(5), 0.9);
  const tri: Pt[] = [lerp(top, l, 0.85), lerp(top, r, 0.85), lerp(top, base, 0.95)];
  ctx.fillStyle = ctx.strokeStyle = "#ff8fb1";
  ctx.lineJoin = "round";
  ctx.lineWidth = faceW * 0.03;
  path(ctx, tri);
  ctx.fill();
  ctx.stroke();
  // Mouth line and whiskers.
  const ink = "rgba(42, 32, 48, 0.9)";
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineWidth = faceW * 0.008;
  ctx.beginPath();
  ctx.moveTo(...tri[2]);
  ctx.lineTo(...P(0));
  ctx.stroke();
  for (const [root, side] of [[P(203), -1], [P(423), 1]] as const) {
    for (const tilt of [-0.22, 0, 0.22]) {
      const ang = tilt * side;
      const len = faceW * 0.34;
      ctx.beginPath();
      ctx.moveTo(root[0] + side * faceW * 0.02, root[1] + tilt * faceW * 0.08);
      ctx.lineTo(root[0] + side * Math.cos(ang) * len, root[1] + Math.sin(ang) * len * side + tilt * faceW * 0.08);
      ctx.stroke();
    }
    ctx.fillStyle = ink;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(root[0] - side * faceW * (0.03 + i * 0.025), root[1] - faceW * 0.035 + (i % 2) * faceW * 0.02, faceW * 0.007, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const paints = new Map<Paint, HTMLCanvasElement>();
/** Face paint in the face model's texture space, 1024 × 1024. */
export function paintArt(kind: Paint): HTMLCanvasElement {
  let c = paints.get(kind);
  if (!c) {
    const [el, ctx] = canvas(SIZE, SIZE);
    (kind === "skull" ? skull : cat)(ctx);
    paints.set(kind, c = el);
  }
  return c;
}

function ears(ctx: CanvasRenderingContext2D) {
  // s: size, 1 for the ear and smaller for the pink inside.
  const ear = (cx: number, lean: number, color: string, s: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    const tip = 110 + (1 - s) * 140;
    ctx.moveTo(cx - 125 * s, 300);
    ctx.quadraticCurveTo(cx - 70 * s + lean * 0.6, 190, cx + lean, tip);
    ctx.quadraticCurveTo(cx + 70 * s + lean * 0.6, 190, cx + 125 * s, 300);
    ctx.closePath();
    ctx.fill();
  };
  for (const [cx, lean] of [[128, -40], [384, 40]] as const) {
    ear(cx, lean, "#f29b4b", 1);
    ear(cx, lean * 0.8, "#ffc4d6", 0.5);
  }
}

function shades(ctx: CanvasRenderingContext2D) {
  const lens = (x: number) => {
    ctx.beginPath();
    ctx.roundRect(x, 60, 420, 250, [40, 40, 130, 130]);
    const g = ctx.createLinearGradient(0, 60, 0, 310);
    g.addColorStop(0, "#202a4a");
    g.addColorStop(1, "#3d2a5c");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 22;
    ctx.strokeStyle = "#11131c";
    ctx.stroke();
    // Glint.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
    ctx.beginPath();
    ctx.moveTo(x + 60, 60);
    ctx.lineTo(x + 170, 60);
    ctx.lineTo(x + 40, 310);
    ctx.lineTo(x - 70, 310);
    ctx.fill();
    ctx.restore();
  };
  lens(50);
  lens(554);
  ctx.lineWidth = 24;
  ctx.strokeStyle = "#11131c";
  ctx.beginPath();
  ctx.moveTo(470, 120);
  ctx.quadraticCurveTo(512, 95, 554, 120);
  ctx.stroke();
}

/** Where a prop's picture sits relative to the face (see placeProp). */
export const PROP_SIZE: Record<Prop, [number, number]> = { ears: [512, 300], shades: [1024, 360] };

const props = new Map<Prop, HTMLCanvasElement>();
export function propArt(kind: Prop): HTMLCanvasElement {
  let c = props.get(kind);
  if (!c) {
    const [w, h] = PROP_SIZE[kind];
    const [el, ctx] = canvas(w, h);
    (kind === "ears" ? ears : shades)(ctx);
    props.set(kind, c = el);
  }
  return c;
}

/**
 * The four corners (top-left, top-right, bottom-right, bottom-left) of a prop
 * on a frame, x and y from 0 to 1. `pts` are the tracked landmarks.
 */
export function placeProp(kind: Prop, pts: ArrayLike<number>, width: number, height: number, out: Float32Array) {
  const px = (i: number): Pt => [pts[i * 2] * width, pts[i * 2 + 1] * height];
  const left = px(234), right = px(454);
  const faceW = dist(left, right);
  const eyeL = px(33), eyeR = px(263);
  const ex = eyeR[0] - eyeL[0], ey = eyeR[1] - eyeL[1];
  const el = Math.hypot(ex, ey) || 1;
  const rx = ex / el, ry = ey / el; // along the eyes
  const ux = ry, uy = -rx;          // up the face
  const [aw, ah] = PROP_SIZE[kind];
  let cx: number, cy: number, w: number;
  if (kind === "shades") {
    const c = centroid([eyeL, eyeR, px(133), px(362)]);
    [cx, cy, w] = [c[0], c[1], faceW * 1.02];
  } else {
    // Ear bases just under the hairline (landmark 10), the rest above the head.
    const top = px(10);
    w = faceW * 1.3;
    const up = w * (ah / aw) * 0.55;
    [cx, cy] = [top[0] + ux * up, top[1] + uy * up];
  }
  const h = w * (ah / aw);
  const hw = w / 2, hh = h / 2;
  const corners: Pt[] = [
    [cx - rx * hw + ux * hh, cy - ry * hw + uy * hh],
    [cx + rx * hw + ux * hh, cy + ry * hw + uy * hh],
    [cx + rx * hw - ux * hh, cy + ry * hw - uy * hh],
    [cx - rx * hw - ux * hh, cy - ry * hw - uy * hh],
  ];
  corners.forEach(([x, y], i) => { out[i * 2] = x / width; out[i * 2 + 1] = y / height; });
}
