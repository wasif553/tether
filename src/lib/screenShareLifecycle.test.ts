/**
 * Screen-share Evidence Mode v1 — pure lifecycle tests. See
 * docs/screen-share-evidence-v1.md.
 */
import { describe, expect, it } from "vitest";
import {
  nextScreenShareLifecycleState,
  shouldEmitLifecycleEvent,
  integrityEventTypeForState,
  isRestorationTransition,
  classifyGetDisplayMediaError,
  evaluateDisplaySurface,
  isScreenShareApiSupported,
  isScreenShareSatisfied,
  requiresBlockingOverlay,
  type ScreenShareLifecycleState,
} from "./screenShareLifecycle";

describe("monitor versus window/tab handling", () => {
  it("confirms a monitor surface when REQUIRED", () => {
    expect(evaluateDisplaySurface("monitor", "REQUIRED")).toBe("MONITOR_CONFIRMED");
  });

  it("rejects a window/browser/application surface when REQUIRED", () => {
    expect(evaluateDisplaySurface("window", "REQUIRED")).toBe("NOT_MONITOR_REJECTED");
    expect(evaluateDisplaySurface("browser", "REQUIRED")).toBe("NOT_MONITOR_REJECTED");
    expect(evaluateDisplaySurface("application", "REQUIRED")).toBe("NOT_MONITOR_REJECTED");
  });

  it("accepts (does not reject) when the browser cannot report a surface at all — safest compatible flow", () => {
    expect(evaluateDisplaySurface(undefined, "REQUIRED")).toBe("UNVERIFIABLE_ACCEPTED");
  });

  it("never rejects a surface when sharing is not REQUIRED (screen sharing is otherwise optional)", () => {
    expect(evaluateDisplaySurface("window", "OFF")).toBe("UNVERIFIABLE_ACCEPTED");
    expect(evaluateDisplaySurface(undefined, "OFF")).toBe("UNVERIFIABLE_ACCEPTED");
  });
});

describe("getDisplayMedia() error classification", () => {
  it("NotAllowedError/SecurityError are permission denials", () => {
    expect(classifyGetDisplayMediaError("NotAllowedError")).toBe("PERMISSION_DENIED");
    expect(classifyGetDisplayMediaError("SecurityError")).toBe("PERMISSION_DENIED");
  });

  it("any other/unknown error name fails safe to UNAVAILABLE", () => {
    expect(classifyGetDisplayMediaError("NotFoundError")).toBe("UNAVAILABLE");
    expect(classifyGetDisplayMediaError("AbortError")).toBe("UNAVAILABLE");
    expect(classifyGetDisplayMediaError(undefined)).toBe("UNAVAILABLE");
  });

  it("API support check", () => {
    expect(isScreenShareApiSupported(true)).toBe(true);
    expect(isScreenShareApiSupported(false)).toBe(false);
  });
});

describe("state machine — start/stop/error transitions", () => {
  it("START_REQUESTED moves to REQUESTING from IDLE", () => {
    expect(nextScreenShareLifecycleState("IDLE", { type: "START_REQUESTED" })).toBe("REQUESTING");
  });

  it("STREAM_ACQUIRED with a confirmed/unverifiable surface moves to ACTIVE", () => {
    expect(nextScreenShareLifecycleState("REQUESTING", { type: "STREAM_ACQUIRED", surfaceResult: "MONITOR_CONFIRMED" })).toBe("ACTIVE");
    expect(nextScreenShareLifecycleState("REQUESTING", { type: "STREAM_ACQUIRED", surfaceResult: "UNVERIFIABLE_ACCEPTED" })).toBe("ACTIVE");
  });

  it("STREAM_ACQUIRED with a rejected surface moves to SURFACE_REJECTED, not ACTIVE", () => {
    expect(nextScreenShareLifecycleState("REQUESTING", { type: "STREAM_ACQUIRED", surfaceResult: "NOT_MONITOR_REJECTED" })).toBe("SURFACE_REJECTED");
  });

  it("REQUEST_FAILED maps to the correct terminal state per reason", () => {
    expect(nextScreenShareLifecycleState("REQUESTING", { type: "REQUEST_FAILED", reason: "PERMISSION_DENIED" })).toBe("PERMISSION_DENIED");
    expect(nextScreenShareLifecycleState("REQUESTING", { type: "REQUEST_FAILED", reason: "UNAVAILABLE" })).toBe("UNAVAILABLE");
  });

  it("API_UNSUPPORTED moves straight to UNAVAILABLE", () => {
    expect(nextScreenShareLifecycleState("IDLE", { type: "API_UNSUPPORTED" })).toBe("UNAVAILABLE");
  });
});

describe("track-ended lifecycle handling", () => {
  it("TRACK_ENDED interrupts an ACTIVE share", () => {
    expect(nextScreenShareLifecycleState("ACTIVE", { type: "TRACK_ENDED" })).toBe("INTERRUPTED");
  });

  it("TRACK_ENDED in any other state is a no-op (not a new interruption)", () => {
    for (const state of ["IDLE", "REQUESTING", "PERMISSION_DENIED", "UNAVAILABLE", "SURFACE_REJECTED", "STOPPED"] as ScreenShareLifecycleState[]) {
      expect(nextScreenShareLifecycleState(state, { type: "TRACK_ENDED" })).toBe(state);
    }
    // Already-interrupted stays interrupted — idempotent, not a fresh event.
    expect(nextScreenShareLifecycleState("INTERRUPTED", { type: "TRACK_ENDED" })).toBe("INTERRUPTED");
  });
});

describe("mute/unmute handling", () => {
  it("TRACK_MUTED interrupts an ACTIVE share, same as TRACK_ENDED", () => {
    expect(nextScreenShareLifecycleState("ACTIVE", { type: "TRACK_MUTED" })).toBe("INTERRUPTED");
  });

  it("TRACK_UNMUTED alone never restores — RESTORED is a separate, explicit action", () => {
    expect(nextScreenShareLifecycleState("INTERRUPTED", { type: "TRACK_UNMUTED" })).toBe("INTERRUPTED");
  });
});

describe("restoration flow", () => {
  it("RESTORED moves INTERRUPTED back to ACTIVE", () => {
    expect(nextScreenShareLifecycleState("INTERRUPTED", { type: "RESTORED" })).toBe("ACTIVE");
  });

  it("RESTORED is a no-op from any other state", () => {
    expect(nextScreenShareLifecycleState("ACTIVE", { type: "RESTORED" })).toBe("ACTIVE");
    expect(nextScreenShareLifecycleState("IDLE", { type: "RESTORED" })).toBe("IDLE");
  });

  it("isRestorationTransition is true only for INTERRUPTED -> ACTIVE, distinct from a fresh start", () => {
    expect(isRestorationTransition("INTERRUPTED", "ACTIVE")).toBe(true);
    expect(isRestorationTransition("REQUESTING", "ACTIVE")).toBe(false);
    expect(isRestorationTransition("IDLE", "ACTIVE")).toBe(false);
  });
});

describe("interruption deduplication — idempotent lifecycle events", () => {
  it("shouldEmitLifecycleEvent is true only on an actual state change", () => {
    expect(shouldEmitLifecycleEvent("ACTIVE", "INTERRUPTED")).toBe(true);
    expect(shouldEmitLifecycleEvent("INTERRUPTED", "INTERRUPTED")).toBe(false);
  });

  it("repeated TRACK_ENDED/TRACK_MUTED callbacks for the same interruption never re-emit (state doesn't change again)", () => {
    let state: ScreenShareLifecycleState = "ACTIVE";
    state = nextScreenShareLifecycleState(state, { type: "TRACK_ENDED" });
    expect(state).toBe("INTERRUPTED");
    const before = state;
    state = nextScreenShareLifecycleState(state, { type: "TRACK_MUTED" }); // a second, redundant callback
    expect(shouldEmitLifecycleEvent(before, state)).toBe(false);
  });
});

describe("event-type mapping and satisfied/overlay predicates", () => {
  it("maps each terminal state to its IntegrityEventType", () => {
    expect(integrityEventTypeForState("ACTIVE")).toBe("SCREEN_SHARE_STARTED");
    expect(integrityEventTypeForState("INTERRUPTED")).toBe("SCREEN_SHARE_INTERRUPTED");
    expect(integrityEventTypeForState("PERMISSION_DENIED")).toBe("SCREEN_SHARE_PERMISSION_DENIED");
    expect(integrityEventTypeForState("UNAVAILABLE")).toBe("SCREEN_SHARE_UNAVAILABLE");
    expect(integrityEventTypeForState("SURFACE_REJECTED")).toBe("SCREEN_SHARE_SURFACE_REJECTED");
    expect(integrityEventTypeForState("REQUESTING")).toBeNull();
    expect(integrityEventTypeForState("IDLE")).toBeNull();
    expect(integrityEventTypeForState("STOPPED")).toBeNull();
  });

  it("only ACTIVE satisfies the required-sharing gate", () => {
    expect(isScreenShareSatisfied("ACTIVE")).toBe(true);
    for (const state of ["IDLE", "REQUESTING", "INTERRUPTED", "PERMISSION_DENIED", "UNAVAILABLE", "SURFACE_REJECTED", "STOPPED"] as ScreenShareLifecycleState[]) {
      expect(isScreenShareSatisfied(state)).toBe(false);
    }
  });

  it("only INTERRUPTED requires the blocking overlay", () => {
    expect(requiresBlockingOverlay("INTERRUPTED")).toBe(true);
    expect(requiresBlockingOverlay("ACTIVE")).toBe(false);
    expect(requiresBlockingOverlay("PERMISSION_DENIED")).toBe(false);
  });
});
