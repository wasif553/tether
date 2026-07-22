/**
 * Screen-share Evidence Mode v1 — pure lifecycle module. See
 * docs/screen-share-evidence-v1.md.
 *
 * Pure, dependency-free, deterministic: no DOM, no MediaStream, no
 * browser APIs — everything here operates on plain strings/booleans the
 * caller derives from the real `MediaStream`/`MediaStreamTrack` objects
 * (see the client wiring in src/hooks/useScreenShareLifecycle.ts). This
 * is the single source of truth for state transitions, so the hook
 * itself stays a thin adapter over real browser events rather than
 * embedding decision logic inline in the exam page (as the task
 * explicitly asks for — "a dedicated screen-share lifecycle controller
 * or hook, rather than mixing all logic into the exam page").
 */
import type { ScreenShareMode } from "@/lib/screenSharePolicy";

export const SCREEN_SHARE_LIFECYCLE_STATES = [
  "IDLE",
  "REQUESTING",
  "ACTIVE",
  "INTERRUPTED",
  "PERMISSION_DENIED",
  "UNAVAILABLE",
  "SURFACE_REJECTED",
  "STOPPED",
] as const;
export type ScreenShareLifecycleState = (typeof SCREEN_SHARE_LIFECYCLE_STATES)[number];

/** States in which the required-sharing gate is satisfied — the student may proceed/continue. */
export function isScreenShareSatisfied(state: ScreenShareLifecycleState): boolean {
  return state === "ACTIVE";
}

/** States in which a blocking recovery overlay should be shown (Part — "required screen sharing stops"). Never PERMISSION_DENIED/UNAVAILABLE/SURFACE_REJECTED alone — those are handled by the pre-exam gate, not a mid-exam blocking overlay, unless they occur AFTER the attempt has already started (see the hook). */
export function requiresBlockingOverlay(state: ScreenShareLifecycleState): boolean {
  return state === "INTERRUPTED";
}

// ---------------------------------------------------------------------------
// getDisplayMedia() error classification (Part — permission denial vs.
// unavailable). Never assumes a specific browser's exact DOMException
// shape beyond the standard `.name` — unrecognised names fail safe to
// UNAVAILABLE (a clear "can't do this right now" message) rather than
// PERMISSION_DENIED (which implies "ask again the normal way").
// ---------------------------------------------------------------------------

export type GetDisplayMediaFailureReason = "PERMISSION_DENIED" | "UNAVAILABLE";

export function classifyGetDisplayMediaError(errorName: string | undefined): GetDisplayMediaFailureReason {
  if (errorName === "NotAllowedError" || errorName === "SecurityError") return "PERMISSION_DENIED";
  return "UNAVAILABLE";
}

/** True when the browser exposes no getDisplayMedia() at all (older/unsupported browser) — checked before ever attempting to call it. */
export function isScreenShareApiSupported(hasGetDisplayMedia: boolean): boolean {
  return hasGetDisplayMedia;
}

// ---------------------------------------------------------------------------
// Display-surface validation (Part — "prefer or require displaySurface
// === 'monitor'"). MediaStreamTrack.getSettings().displaySurface is
// widely but not universally implemented — undefined means the browser
// doesn't expose it, which must never be silently treated as either
// confirmed-monitor or confirmed-not-monitor.
// ---------------------------------------------------------------------------

export type DisplaySurfaceCheckResult = "MONITOR_CONFIRMED" | "NOT_MONITOR_REJECTED" | "UNVERIFIABLE_ACCEPTED";

/**
 * `displaySurface` is `"monitor" | "window" | "browser" | "application" |
 * undefined` (spec-defined values, loosely typed here as `string |
 * undefined` since not every browser's TS lib.dom version agrees). When
 * `mode` is not REQUIRED, the surface is never rejected (screen sharing
 * is optional — this app never second-guesses what the student chose to
 * share). When REQUIRED and the browser cannot report a surface type at
 * all, the safest compatible flow (per the task) is to ACCEPT rather
 * than block a student whose browser simply doesn't expose this —
 * `UNVERIFIABLE_ACCEPTED` signals the caller to show a clear limitation
 * notice rather than silently proceeding as if it were confirmed.
 */
export function evaluateDisplaySurface(
  displaySurface: string | undefined,
  mode: ScreenShareMode,
): DisplaySurfaceCheckResult {
  if (mode !== "REQUIRED") return displaySurface === "monitor" ? "MONITOR_CONFIRMED" : "UNVERIFIABLE_ACCEPTED";
  if (displaySurface === undefined) return "UNVERIFIABLE_ACCEPTED";
  return displaySurface === "monitor" ? "MONITOR_CONFIRMED" : "NOT_MONITOR_REJECTED";
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export type ScreenShareLifecycleAction =
  | { type: "START_REQUESTED" }
  | { type: "STREAM_ACQUIRED"; surfaceResult: DisplaySurfaceCheckResult }
  | { type: "REQUEST_FAILED"; reason: GetDisplayMediaFailureReason }
  | { type: "API_UNSUPPORTED" }
  | { type: "TRACK_ENDED" }
  | { type: "TRACK_MUTED" }
  | { type: "TRACK_UNMUTED" }
  | { type: "RESTORED" }
  | { type: "STOPPED_CLEANLY" };

/**
 * A single, pure, exhaustively-typed reducer — the entire lifecycle state
 * machine in one place, independently testable without a browser. The
 * hook (src/hooks/useScreenShareLifecycle.ts) calls this on every real
 * browser event and only reports an integrity event to the server when
 * the RESULTING state actually differs from the current one (see
 * `shouldEmitLifecycleEvent` below) — repeated browser callbacks for the
 * same underlying condition (e.g. multiple `mute` events while already
 * interrupted) are naturally idempotent because the state simply doesn't
 * change again.
 */
export function nextScreenShareLifecycleState(
  current: ScreenShareLifecycleState,
  action: ScreenShareLifecycleAction,
): ScreenShareLifecycleState {
  switch (action.type) {
    case "START_REQUESTED":
      return "REQUESTING";
    case "STREAM_ACQUIRED":
      return action.surfaceResult === "NOT_MONITOR_REJECTED" ? "SURFACE_REJECTED" : "ACTIVE";
    case "REQUEST_FAILED":
      return action.reason === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "UNAVAILABLE";
    case "API_UNSUPPORTED":
      return "UNAVAILABLE";
    case "TRACK_ENDED":
    case "TRACK_MUTED":
      // Only a currently-ACTIVE share can become INTERRUPTED — a mute/end
      // callback arriving in any other state (e.g. after the student has
      // already cleanly stopped sharing at submission) is a no-op, not a
      // new interruption.
      return current === "ACTIVE" ? "INTERRUPTED" : current;
    case "TRACK_UNMUTED":
      // Unmute alone does not restore — RESTORED is a separate, explicit
      // action fired only once the stream is confirmed live again (Part
      // — "record restoration as a separate event"), not merely inferred
      // from an unmute callback, which some browsers fire spuriously.
      return current;
    case "RESTORED":
      return current === "INTERRUPTED" ? "ACTIVE" : current;
    case "STOPPED_CLEANLY":
      return "STOPPED";
  }
}

/** True only when a transition actually changes state — the hook's guard against reporting a duplicate lifecycle event for a repeated browser callback. */
export function shouldEmitLifecycleEvent(
  previous: ScreenShareLifecycleState,
  next: ScreenShareLifecycleState,
): boolean {
  return previous !== next;
}

/** Maps a resulting state (from a state CHANGE only — see shouldEmitLifecycleEvent) to the IntegrityEventType to report, or null if this state has no dedicated event of its own (e.g. REQUESTING). */
export function integrityEventTypeForState(state: ScreenShareLifecycleState): string | null {
  switch (state) {
    case "ACTIVE":
      return "SCREEN_SHARE_STARTED";
    case "INTERRUPTED":
      return "SCREEN_SHARE_INTERRUPTED";
    case "PERMISSION_DENIED":
      return "SCREEN_SHARE_PERMISSION_DENIED";
    case "UNAVAILABLE":
      return "SCREEN_SHARE_UNAVAILABLE";
    case "SURFACE_REJECTED":
      return "SCREEN_SHARE_SURFACE_REJECTED";
    default:
      return null;
  }
}

/**
 * RESTORED is reported separately from the state-change map above,
 * because the transition INTERRUPTED -> ACTIVE must be labelled
 * "restored," not "started" (Part — "record restoration as a separate
 * event"), even though the resulting STATE is the same ACTIVE state a
 * fresh start reaches.
 */
export function isRestorationTransition(
  previous: ScreenShareLifecycleState,
  next: ScreenShareLifecycleState,
): boolean {
  return previous === "INTERRUPTED" && next === "ACTIVE";
}
