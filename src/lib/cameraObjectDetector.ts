/**
 * Optional Student Verification + On-Device AI Camera Integrity
 * Detection v1 — see docs/on-device-ai-integrity-detection-v1.md.
 *
 * Thin, client-only wrapper around a lightweight browser object
 * detection model (TensorFlow.js + COCO-SSD) used to check for a
 * possible phone or additional person in the existing camera preview
 * stream. Chosen over MediaPipe Tasks Vision / ONNX Runtime Web because
 * it is the smallest, most Next.js/Turbopack-compatible option that
 * still recognizes both "cell phone" and "person" classes out of the
 * box (COCO-SSD's default label set) without a custom model.
 *
 * Hard rules enforced by this module:
 * - The model is only ever loaded in the browser (dynamic import,
 *   never at module scope, never during SSR).
 * - A failed load NEVER throws to the caller — `loadCameraObjectDetector`
 *   resolves to `null`, and the caller must treat that as "AI camera
 *   checks unavailable" rather than crashing the exam.
 * - `detect()` only ever returns class names + confidence scores. It
 *   never returns pixel data, and this module never uploads the video
 *   frame anywhere — inference runs entirely on-device.
 */
import type { DetectedObject } from "@/lib/cameraIntegrityDetection";

export type CameraObjectDetector = {
  modelName: string;
  modelVersion: string;
  detect(video: HTMLVideoElement): Promise<DetectedObject[]>;
  dispose(): void;
};

/**
 * Loads the detector. Resolves to `null` (never rejects) if the model
 * or its dependencies fail to load for any reason — a slow network, an
 * unsupported browser, a blocked CDN, etc. Callers must treat `null` as
 * "unavailable," not as an error to surface to the student as a crash.
 */
export async function loadCameraObjectDetector(): Promise<CameraObjectDetector | null> {
  if (typeof window === "undefined") return null;

  try {
    const [tf, cocoSsd] = await Promise.all([
      import("@tensorflow/tfjs"),
      import("@tensorflow-models/coco-ssd"),
    ]);
    await tf.ready();
    const model = await cocoSsd.load({ base: "lite_mobilenet_v2" });

    return {
      modelName: "coco-ssd",
      modelVersion: "lite_mobilenet_v2",
      async detect(video: HTMLVideoElement): Promise<DetectedObject[]> {
        try {
          const predictions = await model.detect(video);
          return predictions.map((p) => ({ className: p.class, score: p.score }));
        } catch {
          // A single failed inference pass (e.g. the video element is
          // momentarily not ready) should never crash the exam — treat
          // it as "nothing detected this check," not an unavailable model.
          return [];
        }
      },
      dispose() {
        model.dispose?.();
      },
    };
  } catch {
    return null;
  }
}
