import { describe, it, expect } from "vitest";
import { resolveNativeLockdownConfirmation, shouldBlockExamContentRendering } from "./secureExamNativeLockdown";

// v1.7.5 P0 — see this module's own doc comment for the physical-test
// failure this exists to fix (POLICY_NOT_READY overlay produced by a
// stale mount-time downgrade), and the release-blocking follow-up
// review this file also covers (protected content must never be
// FETCHED — not merely never rendered — before native lockdown is
// confirmed ACTIVE+READY and policy-compatible).

describe("resolveNativeLockdownConfirmation", () => {
  it("REQUIRED TEST A/B: a non-gated exam is always NOT_APPLICABLE, regardless of native state", () => {
    expect(resolveNativeLockdownConfirmation({ gated: false, bridgeAvailable: true, nativeState: null, requireSingleDisplay: false })).toBe(
      "NOT_APPLICABLE",
    );
    expect(resolveNativeLockdownConfirmation({ gated: false, bridgeAvailable: false, nativeState: null, requireSingleDisplay: true })).toBe(
      "NOT_APPLICABLE",
    );
    expect(
      resolveNativeLockdownConfirmation({
        gated: false,
        bridgeAvailable: true,
        nativeState: { active: false, ready: false, requireSingleDisplay: false },
        requireSingleDisplay: false,
      }),
    ).toBe("NOT_APPLICABLE");
  });

  it("REQUIRED TEST 1/6: a gated exam with native ALREADY active+ready+policy-compatible is CONFIRMED — this is the successful Phase 2 handoff, preserved, never downgraded", () => {
    expect(
      resolveNativeLockdownConfirmation({
        gated: true,
        bridgeAvailable: true,
        nativeState: { active: true, ready: true, requireSingleDisplay: true },
        requireSingleDisplay: true,
      }),
    ).toBe("CONFIRMED");
    // Policy does not require single-display — native's own value is
    // irrelevant to this classification either way.
    expect(
      resolveNativeLockdownConfirmation({
        gated: true,
        bridgeAvailable: true,
        nativeState: { active: true, ready: true, requireSingleDisplay: false },
        requireSingleDisplay: false,
      }),
    ).toBe("CONFIRMED");
    expect(
      resolveNativeLockdownConfirmation({
        gated: true,
        bridgeAvailable: true,
        nativeState: { active: true, ready: true, requireSingleDisplay: true },
        requireSingleDisplay: false,
      }),
    ).toBe("CONFIRMED");
  });

  it("REQUIRED TEST 2/3: a gated exam with native NOT active+ready (direct load / reload / Tether restart) is REACTIVATION_REQUIRED", () => {
    expect(
      resolveNativeLockdownConfirmation({
        gated: true,
        bridgeAvailable: true,
        nativeState: { active: false, ready: false, requireSingleDisplay: false },
        requireSingleDisplay: false,
      }),
    ).toBe("REACTIVATION_REQUIRED");
    // REQUIRED TEST 3 — the exact bug this fixes: active:true but
    // ready:false (what the old blind mount-time cover used to assert)
    // must NOT be treated as confirmed.
    expect(
      resolveNativeLockdownConfirmation({
        gated: true,
        bridgeAvailable: true,
        nativeState: { active: true, ready: false, requireSingleDisplay: false },
        requireSingleDisplay: false,
      }),
    ).toBe("REACTIVATION_REQUIRED");
  });

  it("REQUIRED TEST 4: active+ready but a policy-incompatible native state (requireSingleDisplay false when the frozen policy requires true) is REACTIVATION_REQUIRED — active+ready alone is never sufficient", () => {
    expect(
      resolveNativeLockdownConfirmation({
        gated: true,
        bridgeAvailable: true,
        nativeState: { active: true, ready: true, requireSingleDisplay: false },
        requireSingleDisplay: true,
      }),
    ).toBe("REACTIVATION_REQUIRED");
  });

  it("a gated exam with a null nativeState (query threw/failed) is REACTIVATION_REQUIRED, never assumed confirmed", () => {
    expect(resolveNativeLockdownConfirmation({ gated: true, bridgeAvailable: true, nativeState: null, requireSingleDisplay: false })).toBe(
      "REACTIVATION_REQUIRED",
    );
  });

  it("REQUIRED TEST 5: a gated exam whose build predates the query bridge entirely is UNSUPPORTED_BUILD — fails closed, never assumed confirmed", () => {
    expect(resolveNativeLockdownConfirmation({ gated: true, bridgeAvailable: false, nativeState: null, requireSingleDisplay: false })).toBe(
      "UNSUPPORTED_BUILD",
    );
    // Bridge unavailability takes priority even if a nativeState were
    // somehow supplied — the missing bridge is itself the disqualifying
    // fact.
    expect(
      resolveNativeLockdownConfirmation({
        gated: true,
        bridgeAvailable: false,
        nativeState: { active: true, ready: true, requireSingleDisplay: true },
        requireSingleDisplay: true,
      }),
    ).toBe("UNSUPPORTED_BUILD");
  });
});

describe("shouldBlockExamContentRendering", () => {
  it("REQUIRED TEST 7: never blocks outside Tether (an ordinary browser session) regardless of state — v1.7.5 machinery does not apply there", () => {
    for (const state of ["PENDING", "STATUS_UNAVAILABLE", "NOT_APPLICABLE", "CONFIRMED", "REACTIVATION_REQUIRED", "UNSUPPORTED_BUILD"] as const) {
      expect(shouldBlockExamContentRendering(false, state)).toBe(false);
    }
  });

  it("REQUIRED TESTS 1/6/9: inside Tether, NOT_APPLICABLE and CONFIRMED both render content normally", () => {
    expect(shouldBlockExamContentRendering(true, "NOT_APPLICABLE")).toBe(false);
    expect(shouldBlockExamContentRendering(true, "CONFIRMED")).toBe(false);
  });

  it("REQUIRED TESTS 2/3/4: inside Tether, PENDING/STATUS_UNAVAILABLE/REACTIVATION_REQUIRED/UNSUPPORTED_BUILD all withhold content", () => {
    expect(shouldBlockExamContentRendering(true, "PENDING")).toBe(true);
    expect(shouldBlockExamContentRendering(true, "STATUS_UNAVAILABLE")).toBe(true);
    expect(shouldBlockExamContentRendering(true, "REACTIVATION_REQUIRED")).toBe(true);
    expect(shouldBlockExamContentRendering(true, "UNSUPPORTED_BUILD")).toBe(true);
  });
});
