// MediaPipe models for camera effects, loaded on first use and kept for the
// rest of the session. Everything ships inside the app: the runtime (served
// at /mediapipe by vite.config.ts) and the two models in public/effects. No
// frame, face or picture ever leaves this computer.
import { FaceLandmarker, ImageSegmenter, type NormalizedLandmark } from "@mediapipe/tasks-vision";

const FILESET = { wasmLoaderPath: "/mediapipe/vision_wasm_internal.js", wasmBinaryPath: "/mediapipe/vision_wasm_internal.wasm" };

export type Delegate = "GPU" | "CPU";

export interface FaceModel {
  delegate: Delegate;
  /** The 478 face points of the one face in view, x and y from 0 to 1, or null. */
  detect(frame: TexImageSource, at: number): NormalizedLandmark[] | null;
}

export interface SegmentModel {
  delegate: Delegate;
  /** How sure the model is that each pixel is you (0–1), row by row. */
  segment(frame: TexImageSource, at: number): { data: Float32Array; width: number; height: number } | null;
}

/** GPU first (much cheaper), CPU when this computer's web view can't run it. */
async function withDelegate<T>(make: (delegate: Delegate, canvas: HTMLCanvasElement) => Promise<T>): Promise<[T, Delegate]> {
  try {
    // An ordinary canvas, not the OffscreenCanvas MediaPipe would pick: older
    // macOS web views have OffscreenCanvas without WebGL.
    return [await make("GPU", document.createElement("canvas")), "GPU"];
  } catch (e) {
    console.warn("effects: GPU not available, using CPU", e);
    return [await make("CPU", document.createElement("canvas")), "CPU"];
  }
}

let face: Promise<FaceModel> | null = null;
let seg: Promise<SegmentModel> | null = null;

export function faceModel(): Promise<FaceModel> {
  face ??= withDelegate((delegate, canvas) => FaceLandmarker.createFromOptions(FILESET, {
    baseOptions: { modelAssetPath: "/effects/face_landmarker.task", delegate },
    canvas,
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  })).then(([m, delegate]) => ({
    delegate,
    detect: (frame, at) => m.detectForVideo(frame, at).faceLandmarks[0] ?? null,
  }));
  face.catch(() => { face = null; }); // a later try may work (files arrive with an update)
  return face;
}

/**
 * Always on the CPU. The model is tiny (as fast as the GPU here), and a GPU
 * mask has to be read back as floats, which the macOS web view can refuse.
 */
export function segmentModel(): Promise<SegmentModel> {
  seg ??= ImageSegmenter.createFromOptions(FILESET, {
    baseOptions: { modelAssetPath: "/effects/selfie_segmenter.tflite", delegate: "CPU" },
    canvas: document.createElement("canvas"),
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  }).then((m) => ({
    delegate: "CPU" as const,
    segment: (frame, at) => {
      const r = m.segmentForVideo(frame, at);
      const mask = r.confidenceMasks?.[0];
      try {
        // A copy: the mask's own memory goes away with close().
        return mask ? { data: mask.getAsFloat32Array().slice(), width: mask.width, height: mask.height } : null;
      } finally { r.close(); }
    },
  }));
  seg.catch(() => { seg = null; });
  return seg;
}
