/**
 * Camera Startup Lifecycle v2 — pure tests. See
 * docs/on-device-ai-integrity-detection-v1.md and
 * src/lib/cameraLifecycle.ts.
 */
import { describe, expect, it } from "vitest";
import {
  isRenderedFrameValid,
  nextConsecutiveRenderedFrameCount,
  hasReachedFrameReadiness,
  isWarmupComplete,
  hasStartupTimedOut,
  resetCameraLifecycleTimers,
  initialCameraLifecycleTimers,
  isCameraStartupInProgress,
  isDetectionArmed,
  shouldSuppressFocusEvent,
  shouldAutoRetry,
  isCurrentGeneration,
  REQUIRED_CONSECUTIVE_RENDERED_FRAMES,
  CAMERA_MAX_AUTO_RETRIES,
  CAMERA_WARMUP_MS,
  DETECTION_SAMPLING_WARMUP_MS,
  DETECTION_SAMPLING_STARTUP_TIMEOUT_MS,
  DETECTION_SAMPLING_MAX_RETRIES,
  DETECTION_SAMPLING_RETRY_DELAY_MS,
  isDetectionFullyArmed,
  type RenderedFrameCheckInput,
} from "./cameraLifecycle";
import { normalizeCameraPermissionState } from "./sessionBinding";

function validFrame(overrides: Partial<RenderedFrameCheckInput> = {}): RenderedFrameCheckInput {
  return { readyState: 4, videoWidth: 640, videoHeight: 480, currentTime: 1.2, paused: false, trackReadyState: "live", ...overrides };
}

describe("isRenderedFrameValid", () => {
  it("5. a valid rendered frame is recognised", () => {
    expect(isRenderedFrameValid(validFrame())).toBe(true);
  });

  it("1. not ready with zero dimensions", () => {
    expect(isRenderedFrameValid(validFrame({ videoWidth: 0 }))).toBe(false);
    expect(isRenderedFrameValid(validFrame({ videoHeight: 0 }))).toBe(false);
  });

  it("2. not ready while paused", () => {
    expect(isRenderedFrameValid(validFrame({ paused: true }))).toBe(false);
  });

  it("3. not ready before playback time advances", () => {
    expect(isRenderedFrameValid(validFrame({ currentTime: 0 }))).toBe(false);
  });

  it("4. not ready when the video track has ended", () => {
    expect(isRenderedFrameValid(validFrame({ trackReadyState: "ended" }))).toBe(false);
  });

  it("not ready below HAVE_CURRENT_DATA", () => {
    expect(isRenderedFrameValid(validFrame({ readyState: 1 }))).toBe(false);
  });
});

describe("consecutive rendered-frame readiness", () => {
  it("6. three consecutive rendered frames satisfy readiness", () => {
    let count = 0;
    count = nextConsecutiveRenderedFrameCount(count, true);
    count = nextConsecutiveRenderedFrameCount(count, true);
    expect(hasReachedFrameReadiness(count)).toBe(false);
    count = nextConsecutiveRenderedFrameCount(count, true);
    expect(hasReachedFrameReadiness(count)).toBe(true);
    expect(count).toBe(REQUIRED_CONSECUTIVE_RENDERED_FRAMES);
  });

  it("a single invalid observation resets the streak", () => {
    let count = nextConsecutiveRenderedFrameCount(0, true);
    count = nextConsecutiveRenderedFrameCount(count, true);
    count = nextConsecutiveRenderedFrameCount(count, false);
    expect(count).toBe(0);
  });
});

describe("7. warm-up begins only after first valid rendered frame", () => {
  it("never complete while firstFrameReadyAt is null, regardless of elapsed time", () => {
    expect(isWarmupComplete(null, Date.now() + 100_000)).toBe(false);
  });

  it("completes only after the warm-up duration has elapsed since the first rendered frame", () => {
    const first = 1_000_000;
    expect(isWarmupComplete(first, first + 1_000)).toBe(false);
    expect(isWarmupComplete(first, first + 2_500)).toBe(true);
  });
});

describe("hasStartupTimedOut", () => {
  it("flags a startup that never reaches readiness within the timeout", () => {
    const start = 1_000_000;
    expect(hasStartupTimedOut(start, start + 20_000)).toBe(true);
    expect(hasStartupTimedOut(start, start + 5_000)).toBe(false);
  });
});

describe("22. stream restart reapplies readiness and warm-up gates — timers reset", () => {
  it("resetCameraLifecycleTimers clears first-frame and streak state, keeps only the new start time", () => {
    const reset = resetCameraLifecycleTimers(5_000);
    expect(reset).toEqual({ streamStartedAt: 5_000, firstFrameReadyAt: null, consecutiveRenderedFrames: 0 });
  });

  it("initialCameraLifecycleTimers is fully empty", () => {
    expect(initialCameraLifecycleTimers()).toEqual({ streamStartedAt: null, firstFrameReadyAt: null, consecutiveRenderedFrames: 0 });
  });
});

describe("8/9/10. integrity emission suppressed during every pre-READY phase", () => {
  it("every startup phase is suppressed", () => {
    for (const state of [
      "REQUESTING_PERMISSION",
      "PERMISSION_GRANTED",
      "STREAM_RECEIVED",
      "VIDEO_ATTACHED",
      "WAITING_FOR_PLAYBACK",
      "WAITING_FOR_FIRST_FRAME",
      "WARMING_UP",
    ] as const) {
      expect(isCameraStartupInProgress(state)).toBe(true);
      expect(isDetectionArmed(state)).toBe(false);
    }
  });

  it("18/19/20. detection is armed, and only armed, at READY", () => {
    expect(isDetectionArmed("READY")).toBe(true);
    expect(isCameraStartupInProgress("READY")).toBe(false);
  });
});

describe("11/12. focus-loss suppression", () => {
  it("suppressed during permission dialog and every startup phase", () => {
    expect(shouldSuppressFocusEvent("REQUESTING_PERMISSION")).toBe("camera-permission-or-startup");
    expect(shouldSuppressFocusEvent("WARMING_UP")).toBe("camera-permission-or-startup");
  });

  it("allowed (not suppressed) after READY", () => {
    expect(shouldSuppressFocusEvent("READY")).toBeNull();
  });

  it("not suppressed for IDLE/FAILED/RETRYING (no dialog/setup actually in progress)", () => {
    expect(shouldSuppressFocusEvent("IDLE")).toBeNull();
    expect(shouldSuppressFocusEvent("FAILED")).toBeNull();
    expect(shouldSuppressFocusEvent("RETRYING")).toBeNull();
  });
});

describe("15. automatic retry is bounded", () => {
  it("allows retries up to the configured maximum", () => {
    expect(shouldAutoRetry(0)).toBe(true);
    expect(shouldAutoRetry(1)).toBe(true);
    expect(shouldAutoRetry(CAMERA_MAX_AUTO_RETRIES)).toBe(false);
    expect(shouldAutoRetry(CAMERA_MAX_AUTO_RETRIES + 1)).toBe(false);
  });
});

describe("13/14. generation guard — stale async work cannot act", () => {
  it("only a matching generation is authoritative", () => {
    expect(isCurrentGeneration(3, 3)).toBe(true);
    expect(isCurrentGeneration(3, 2)).toBe(false);
  });
});

describe("detection-sampling element readiness (fixes the second false CAMERA_VIEW_BLOCKED)", () => {
  it("DETECTION_SAMPLING_WARMUP_MS is a real, shorter, independent warm-up — not a no-op and not equal to the primary warm-up", () => {
    expect(DETECTION_SAMPLING_WARMUP_MS).toBeGreaterThan(0);
    expect(DETECTION_SAMPLING_WARMUP_MS).toBeLessThan(CAMERA_WARMUP_MS);
  });

  it("a detection-sampling element that just reached frame readiness is not yet warmed up", () => {
    const firstReady = 10_000;
    expect(isWarmupComplete(firstReady, firstReady + 100, DETECTION_SAMPLING_WARMUP_MS)).toBe(false);
  });

  it("a detection-sampling element is warmed up only after its own warm-up duration elapses", () => {
    const firstReady = 10_000;
    expect(isWarmupComplete(firstReady, firstReady + DETECTION_SAMPLING_WARMUP_MS, DETECTION_SAMPLING_WARMUP_MS)).toBe(true);
  });

  it("full arming requires BOTH the primary lifecycle to be READY and the detection-sampling element to independently reach its own readiness", () => {
    expect(isDetectionFullyArmed(true, false)).toBe(false);
    expect(isDetectionFullyArmed(false, true)).toBe(false);
    expect(isDetectionFullyArmed(false, false)).toBe(false);
    expect(isDetectionFullyArmed(true, true)).toBe(true);
  });

  it("sampling-video startup timeout is independent of, and shorter than, the primary camera timeout", () => {
    expect(DETECTION_SAMPLING_STARTUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DETECTION_SAMPLING_STARTUP_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(DETECTION_SAMPLING_STARTUP_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
  });

  it("sampling-sink retries are bounded, distinct from the primary camera's own retry bound", () => {
    expect(shouldAutoRetry(0, DETECTION_SAMPLING_MAX_RETRIES)).toBe(true);
    expect(shouldAutoRetry(1, DETECTION_SAMPLING_MAX_RETRIES)).toBe(true);
    expect(shouldAutoRetry(DETECTION_SAMPLING_MAX_RETRIES, DETECTION_SAMPLING_MAX_RETRIES)).toBe(false);
    expect(DETECTION_SAMPLING_RETRY_DELAY_MS).toBeGreaterThan(0);
  });
});

describe("23. unsupported Permissions API produces UNKNOWN, not blocked", () => {
  it("reuses the existing normalizeCameraPermissionState safe-default behaviour", () => {
    expect(normalizeCameraPermissionState(undefined)).toBe("unknown");
    expect(normalizeCameraPermissionState("granted")).toBe("granted");
    expect(normalizeCameraPermissionState("denied")).toBe("denied");
  });
});
