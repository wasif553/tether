/**
 * Camera Startup Lifecycle v2 — see docs/on-device-ai-integrity-detection-v1.md
 * ("Camera startup lifecycle"). Pure, dependency-free, deterministic: no
 * DOM, no MediaStream, no browser APIs — everything here operates on
 * plain numbers/booleans/strings the caller derives from the real
 * `<video>`/`MediaStreamTrack` objects (see the client wiring in
 * src/app/student/exams/[id]/page.tsx).
 *
 * This module fixes the root cause of the intermittent first-start
 * "camera blocked/unavailable" failure: the PREVIOUS implementation
 * marked the camera "granted"/ready the instant `getUserMedia()`
 * resolved — before `video.play()`, before metadata, before any actual
 * rendered frame existed — and only gated AI-detection *emission* behind
 * a flat 3-second timer. This module instead defines an explicit
 * lifecycle whose READY state requires several consecutive REAL rendered
 * frames, plus a warm-up period measured from that point (never from
 * permission grant or stream acquisition).
 */

export const CAMERA_LIFECYCLE_STATES = [
  "IDLE",
  "REQUESTING_PERMISSION",
  "PERMISSION_GRANTED",
  "STREAM_RECEIVED",
  "VIDEO_ATTACHED",
  "WAITING_FOR_PLAYBACK",
  "WAITING_FOR_FIRST_FRAME",
  "WARMING_UP",
  "READY",
  "RETRYING",
  "FAILED",
] as const;
export type CameraLifecycleState = (typeof CAMERA_LIFECYCLE_STATES)[number];

// ---------------------------------------------------------------------------
// Rendered-frame validation
// ---------------------------------------------------------------------------

/** HTMLMediaElement.HAVE_CURRENT_DATA — a real (if possibly stale) frame exists. */
export const HAVE_CURRENT_DATA = 2;

export type RenderedFrameCheckInput = {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  paused: boolean;
  trackReadyState: "live" | "ended" | undefined;
};

/**
 * A frame counts as genuinely rendered only when every one of these
 * holds — dimensions/readyState alone (the old check) are necessary but
 * not sufficient, since a `<video>` can report HAVE_CURRENT_DATA with
 * non-zero dimensions while still paused or before playback time has
 * actually advanced (exactly the gap that produced false starts).
 */
export function isRenderedFrameValid(input: RenderedFrameCheckInput): boolean {
  return (
    input.readyState >= HAVE_CURRENT_DATA &&
    input.videoWidth > 0 &&
    input.videoHeight > 0 &&
    input.currentTime > 0 &&
    !input.paused &&
    input.trackReadyState === "live"
  );
}

/** Consecutive rendered frames required before startup can proceed past WAITING_FOR_FIRST_FRAME. */
export const REQUIRED_CONSECUTIVE_RENDERED_FRAMES = 3;

/** Pure counter step — resets to 0 on any invalid observation, so a transient bad frame never "banks" partial progress. */
export function nextConsecutiveRenderedFrameCount(previousCount: number, frameValid: boolean): number {
  return frameValid ? previousCount + 1 : 0;
}

export function hasReachedFrameReadiness(
  consecutiveCount: number,
  required: number = REQUIRED_CONSECUTIVE_RENDERED_FRAMES,
): boolean {
  return consecutiveCount >= required;
}

// ---------------------------------------------------------------------------
// Warm-up (stable-frame settling period)
// ---------------------------------------------------------------------------

/** Time to let auto-exposure/auto-focus settle AFTER frame readiness is first reached — never from permission grant or stream acquisition. */
export const CAMERA_WARMUP_MS = 2_500;

/**
 * A SECOND, independent warm-up used only for the hidden AI-detection
 * sampling `<video>` element (see docs/on-device-ai-integrity-detection-v1.md,
 * "Detection-sampling element readiness"). That element is a distinct
 * decode/render pipeline from the primary preview element the lifecycle
 * above warms up — attaching an already-stable MediaStream to a brand
 * new `<video>` sink still needs its own moment to start delivering
 * genuinely stable frames, even though the camera hardware itself is
 * already settled. Shorter than CAMERA_WARMUP_MS because the stream is
 * already live and stable by the time this applies — this only covers
 * the new element's own attach/first-decode lag, not camera hardware
 * settling.
 */
export const DETECTION_SAMPLING_WARMUP_MS = 1_000;

/** If READY is never reached within this long after the stream started, startup is considered failed (never an indefinite spinner). */
export const CAMERA_READY_TIMEOUT_MS = 15_000;

export function isWarmupComplete(
  firstFrameReadyAt: number | null,
  now: number,
  warmupMs: number = CAMERA_WARMUP_MS,
): boolean {
  if (firstFrameReadyAt == null) return false;
  return now - firstFrameReadyAt >= warmupMs;
}

export function hasStartupTimedOut(
  streamStartedAt: number | null,
  now: number,
  timeoutMs: number = CAMERA_READY_TIMEOUT_MS,
): boolean {
  if (streamStartedAt == null) return false;
  return now - streamStartedAt > timeoutMs;
}

// ---------------------------------------------------------------------------
// Lifecycle timer bookkeeping — a plain, resettable struct so "reset on
// every genuine stream restart" (Part 4/12) is one pure function call.
// ---------------------------------------------------------------------------

export type CameraLifecycleTimers = {
  streamStartedAt: number | null;
  firstFrameReadyAt: number | null;
  consecutiveRenderedFrames: number;
};

export function initialCameraLifecycleTimers(): CameraLifecycleTimers {
  return { streamStartedAt: null, firstFrameReadyAt: null, consecutiveRenderedFrames: 0 };
}

/** A fresh stream (initial start OR restart after loss) always gets an entirely new warm-up window — never inherits timing from a previous stream. */
export function resetCameraLifecycleTimers(streamStartedAt: number): CameraLifecycleTimers {
  return { streamStartedAt, firstFrameReadyAt: null, consecutiveRenderedFrames: 0 };
}

// ---------------------------------------------------------------------------
// Startup-phase membership / suppression rules
// ---------------------------------------------------------------------------

const STARTUP_LIFECYCLE_STATES = new Set<CameraLifecycleState>([
  "REQUESTING_PERMISSION",
  "PERMISSION_GRANTED",
  "STREAM_RECEIVED",
  "VIDEO_ATTACHED",
  "WAITING_FOR_PLAYBACK",
  "WAITING_FOR_FIRST_FRAME",
  "WARMING_UP",
]);

export function isCameraStartupInProgress(state: CameraLifecycleState): boolean {
  return STARTUP_LIFECYCLE_STATES.has(state);
}

/** AI-integrity emission (backend event, local overlay, evidence upload) is armed ONLY at READY — never merely "not obviously broken". */
export function isDetectionArmed(state: CameraLifecycleState): boolean {
  return state === "READY";
}

export type FocusSuppressionReason = "camera-permission-or-startup";

/**
 * Part 7 — the getUserMedia() permission prompt (and the subsequent
 * stream/video setup) can itself trigger a window blur or
 * visibilitychange. Focus-loss integrity events are suppressed for
 * exactly this reason during every startup phase, and ONLY during those
 * phases — a genuine focus loss after the camera is READY is never
 * suppressed.
 */
export function shouldSuppressFocusEvent(state: CameraLifecycleState): FocusSuppressionReason | null {
  return isCameraStartupInProgress(state) ? "camera-permission-or-startup" : null;
}

// ---------------------------------------------------------------------------
// Retry bounds
// ---------------------------------------------------------------------------

export const CAMERA_MAX_AUTO_RETRIES = 2;
export const CAMERA_RETRY_DELAY_MS = 750;

export function shouldAutoRetry(attemptNumber: number, maxRetries: number = CAMERA_MAX_AUTO_RETRIES): boolean {
  return attemptNumber < maxRetries;
}

// ---------------------------------------------------------------------------
// Generation guard — Part 8. A monotonically increasing counter; only the
// call whose captured generation still matches the current one may act.
// ---------------------------------------------------------------------------

export function isCurrentGeneration(current: number, captured: number): boolean {
  return current === captured;
}
