import { describe, it, expect } from "vitest";
import {
  computeDisplayViolationModal,
  isGenuineDisplayViolationReason,
  displayStatusOnInitialQueryFailure,
  DISPLAY_VIOLATION_TITLE,
  DISPLAY_VIOLATION_UNAVAILABLE_TITLE,
} from "./displayViolationOverlay";

// Tether v1.7.6 — Native Display State Bridge, exam-page presentation.
// See apps/lockdown/src/displayEnforcement.test.ts /
// displayEnforcementLogic.test.ts for the native-side coverage; these are
// the pure, web-app-side unit tests for the modal-copy derivation the
// exam page renders from window.sesLockdown's bounded {state, reason,
// displayCount} bridge status.

describe("computeDisplayViolationModal", () => {
  it("null when there is no status yet (a fresh mount before the initial getDisplayEnforcementStatus() query resolves)", () => {
    expect(computeDisplayViolationModal(null)).toBeNull();
  });

  it("null for state:OK, regardless of reason", () => {
    expect(computeDisplayViolationModal({ state: "OK", reason: null, displayCount: 1 })).toBeNull();
  });

  it("every genuine multi-display reason produces the specific 'Additional display detected' copy", () => {
    for (const reason of ["ADDITIONAL_ELECTRON_DISPLAY", "WINDOWS_TOPOLOGY_EXTEND", "WINDOWS_TOPOLOGY_CLONE", "MULTIPLE_ACTIVE_TARGETS"]) {
      const modal = computeDisplayViolationModal({ state: "BLOCKED", reason, displayCount: 2 });
      expect(modal).not.toBeNull();
      expect(modal!.title).toBe(DISPLAY_VIOLATION_TITLE);
      expect(modal!.neutral).toBe(false);
    }
  });

  it("TOPOLOGY_CHECK_UNAVAILABLE produces neutral wording and never claims a second display exists", () => {
    const modal = computeDisplayViolationModal({ state: "BLOCKED", reason: "TOPOLOGY_CHECK_UNAVAILABLE", displayCount: 1 });
    expect(modal).not.toBeNull();
    expect(modal!.title).toBe(DISPLAY_VIOLATION_UNAVAILABLE_TITLE);
    expect(modal!.neutral).toBe(true);
    expect(modal!.title.toLowerCase() + modal!.message.toLowerCase()).not.toContain("additional display");
  });

  it("an unrecognized BLOCKED reason (e.g. a future native build) fails CLOSED with neutral wording — never hides the modal, never claims a display exists", () => {
    const modal = computeDisplayViolationModal({ state: "BLOCKED", reason: "SOME_FUTURE_REASON", displayCount: 0 });
    expect(modal).not.toBeNull();
    expect(modal!.neutral).toBe(true);
    expect(modal!.title).toBe(DISPLAY_VIOLATION_UNAVAILABLE_TITLE);
  });

  it("a BLOCKED status with a null reason (should never happen from the native bridge, but must still fail closed) also gets the neutral modal, never null", () => {
    const modal = computeDisplayViolationModal({ state: "BLOCKED", reason: null, displayCount: 0 });
    expect(modal).not.toBeNull();
    expect(modal!.neutral).toBe(true);
  });

  it("every returned modal includes the calm integrity-review-signal / answers-preserved / not-submitted / timer-continues note", () => {
    const modal = computeDisplayViolationModal({ state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_EXTEND", displayCount: 2 });
    expect(modal!.note.toLowerCase()).toContain("integrity review signal");
    expect(modal!.note.toLowerCase()).toContain("preserved");
    expect(modal!.note.toLowerCase()).toContain("not been submitted");
    expect(modal!.note.toLowerCase()).toContain("timer continues");
    expect(modal!.note.toLowerCase()).toContain("not an automatic misconduct finding");
  });
});

// Pre-commit audit fix (PR #26) — items 4/5/6/7: a REJECTED
// getDisplayEnforcementStatus() IPC query must fail closed, never
// silently do nothing, and never fabricate genuine display evidence.
describe("displayStatusOnInitialQueryFailure — pre-commit audit fix (PR #26)", () => {
  it("returns a bounded BLOCKED/TOPOLOGY_CHECK_UNAVAILABLE status, defaulting displayCount to 0", () => {
    expect(displayStatusOnInitialQueryFailure()).toEqual({ state: "BLOCKED", reason: "TOPOLOGY_CHECK_UNAVAILABLE", displayCount: 0 });
  });

  it("accepts an explicit displayCount when one is already known", () => {
    expect(displayStatusOnInitialQueryFailure(2)).toEqual({ state: "BLOCKED", reason: "TOPOLOGY_CHECK_UNAVAILABLE", displayCount: 2 });
  });

  it("Part 4/5: feeding this into computeDisplayViolationModal produces the neutral 'could not be verified' copy — NEVER 'Additional display detected'", () => {
    const modal = computeDisplayViolationModal(displayStatusOnInitialQueryFailure());
    expect(modal).not.toBeNull();
    expect(modal!.neutral).toBe(true);
    expect(modal!.title).toBe(DISPLAY_VIOLATION_UNAVAILABLE_TITLE);
    expect(modal!.title).not.toBe(DISPLAY_VIOLATION_TITLE);
    expect((modal!.title + modal!.message).toLowerCase()).not.toContain("additional display");
  });

  it("Part 6: a later state:OK status clears the modal that this failure state produced", () => {
    const failureModal = computeDisplayViolationModal(displayStatusOnInitialQueryFailure());
    expect(failureModal).not.toBeNull();
    const clearedModal = computeDisplayViolationModal({ state: "OK", reason: null, displayCount: 1 });
    expect(clearedModal).toBeNull();
  });

  it("Part 7: a later genuine BLOCKED status replaces the neutral failure modal with the specific 'Additional display detected' copy", () => {
    const failureModal = computeDisplayViolationModal(displayStatusOnInitialQueryFailure());
    expect(failureModal!.neutral).toBe(true);
    const genuineModal = computeDisplayViolationModal({ state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_EXTEND", displayCount: 2 });
    expect(genuineModal!.neutral).toBe(false);
    expect(genuineModal!.title).toBe(DISPLAY_VIOLATION_TITLE);
  });

  it("is never locally dismissible — has no button/action field, matching every other displayViolationOverlay modal state", () => {
    const modal = computeDisplayViolationModal(displayStatusOnInitialQueryFailure());
    expect(Object.keys(modal!).sort()).toEqual(["message", "neutral", "note", "title"]);
  });
});

describe("isGenuineDisplayViolationReason", () => {
  it("true only for the four reasons backed by real multi-display evidence", () => {
    expect(isGenuineDisplayViolationReason("ADDITIONAL_ELECTRON_DISPLAY")).toBe(true);
    expect(isGenuineDisplayViolationReason("WINDOWS_TOPOLOGY_EXTEND")).toBe(true);
    expect(isGenuineDisplayViolationReason("WINDOWS_TOPOLOGY_CLONE")).toBe(true);
    expect(isGenuineDisplayViolationReason("MULTIPLE_ACTIVE_TARGETS")).toBe(true);
  });

  it("false for TOPOLOGY_CHECK_UNAVAILABLE and any unrecognized string", () => {
    expect(isGenuineDisplayViolationReason("TOPOLOGY_CHECK_UNAVAILABLE")).toBe(false);
    expect(isGenuineDisplayViolationReason("POLICY_NOT_READY")).toBe(false);
    expect(isGenuineDisplayViolationReason("anything-else")).toBe(false);
  });
});
