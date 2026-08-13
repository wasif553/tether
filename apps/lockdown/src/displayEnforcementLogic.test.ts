import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  resolveDisplayEnforcementState,
  resolveCombinedDisplayEnforcementState,
  resolveReadinessGatedDisplayEnforcementState,
  debounceDisplayEvent,
  resolveDisplayEnforcementEventType,
  DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS,
  INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE,
  resolveCombinedDisplayDecision,
  resolveReadinessGatedDisplayDecision,
  resolveDisplayDecisionEventType,
  isGenuineMultiDisplayReason,
  displayBlockingReasonCopy,
  isOverlayEligibleBlockingReason,
} from "./displayEnforcementLogic";

// ---------------------------------------------------------------------------
// Tether launch/install flow v1 — single-display enforcement foundation.
// See displayEnforcement.ts for the main-process glue that calls these
// pure functions (electron.screen cannot run outside the Electron main
// process, so all decision logic lives here, free of any Electron import).
// ---------------------------------------------------------------------------

describe("resolveDisplayEnforcementState", () => {
  it("one display permits the exam", () => {
    expect(resolveDisplayEnforcementState(1, true)).toBe("OK");
  });

  it("two displays block before exam interaction", () => {
    expect(resolveDisplayEnforcementState(2, true)).toBe("BLOCKED");
  });

  it("more than two displays also blocks", () => {
    expect(resolveDisplayEnforcementState(3, true)).toBe("BLOCKED");
  });

  it("zero displays (should not normally occur) is never treated as blocked", () => {
    expect(resolveDisplayEnforcementState(0, true)).toBe("OK");
  });

  it("never blocks when the policy does not require a single display, regardless of count", () => {
    expect(resolveDisplayEnforcementState(2, false)).toBe("OK");
    expect(resolveDisplayEnforcementState(5, false)).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Corrective pass v1.2.0 — combines Electron's own logical display count
// with the Windows-native topology classification (see
// windowsDisplayTopologyClassifier.ts). This is the exact function
// displayEnforcement.ts's evaluate() calls to reach its block/unblock
// decision.
// ---------------------------------------------------------------------------

describe("resolveCombinedDisplayEnforcementState", () => {
  it("policy missing (requireSingleDisplay=false): exam is never covered, regardless of Electron count or Windows topology", () => {
    expect(resolveCombinedDisplayEnforcementState(2, false, "EXTEND")).toBe("OK");
    expect(resolveCombinedDisplayEnforcementState(1, false, "CLONE_OR_DUPLICATE")).toBe("OK");
  });

  it("unrestricted policy -> no single-display block even with a benign topology", () => {
    expect(resolveCombinedDisplayEnforcementState(1, false, "INTERNAL_ONLY")).toBe("OK");
  });

  it("single-display required + one active target (INTERNAL_ONLY) -> allowed", () => {
    expect(resolveCombinedDisplayEnforcementState(1, true, "INTERNAL_ONLY")).toBe("OK");
  });

  it("single-display required + Electron displayCount=2 -> blocked, regardless of topology", () => {
    expect(resolveCombinedDisplayEnforcementState(2, true, "INTERNAL_ONLY")).toBe("BLOCKED");
  });

  it("single-display required + Windows EXTEND (even if Electron somehow still reports 1) -> blocked", () => {
    expect(resolveCombinedDisplayEnforcementState(1, true, "EXTEND")).toBe("BLOCKED");
  });

  it("single-display required + Windows CLONE_OR_DUPLICATE while Electron reports displayCount=1 -> blocked (the confirmed Duplicate-mode gap)", () => {
    expect(resolveCombinedDisplayEnforcementState(1, true, "CLONE_OR_DUPLICATE")).toBe("BLOCKED");
  });

  it("single-display required + more than one active target not cleanly attributable to one clone group -> blocked", () => {
    expect(resolveCombinedDisplayEnforcementState(1, true, "MULTIPLE_ACTIVE_TARGETS")).toBe("BLOCKED");
  });

  it("authoritative Windows topology cannot be established (ERROR/UNKNOWN) for a final exam -> fails closed, blocked", () => {
    expect(resolveCombinedDisplayEnforcementState(1, true, "ERROR")).toBe("BLOCKED");
    expect(resolveCombinedDisplayEnforcementState(1, true, "UNKNOWN")).toBe("BLOCKED");
  });

  it("topology restored to INTERNAL_ONLY after being blocked -> allowed again", () => {
    expect(resolveCombinedDisplayEnforcementState(1, true, "CLONE_OR_DUPLICATE")).toBe("BLOCKED");
    expect(resolveCombinedDisplayEnforcementState(1, true, "INTERNAL_ONLY")).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Corrective pass v1.2.1, Task C/F — the reported root cause of "still
// does not detect or block a second display in physical testing": the old
// plain `requireSingleDisplay` boolean defaulted to `false` (fail-OPEN)
// from window creation until the hosted page's async status fetch
// resolved. resolveReadinessGatedDisplayEnforcementState replaces it with
// an explicit {active, ready, requireSingleDisplay} contract that fails
// CLOSED whenever the exam is active but not yet confirmed ready.
// ---------------------------------------------------------------------------

describe("resolveReadinessGatedDisplayEnforcementState", () => {
  it("inactive (not an exam context, e.g. dashboard/login/tether-launch) never blocks, regardless of ready/display/topology", () => {
    expect(resolveReadinessGatedDisplayEnforcementState({ active: false, ready: false, requireSingleDisplay: false }, 2, "EXTEND")).toBe("OK");
    expect(resolveReadinessGatedDisplayEnforcementState({ active: false, ready: true, requireSingleDisplay: true }, 2, "EXTEND")).toBe("OK");
  });

  it("Task F: policy loading state (active, not yet ready) is blocked even on a single internal display", () => {
    expect(
      resolveReadinessGatedDisplayEnforcementState({ active: true, ready: false, requireSingleDisplay: false }, 1, "INTERNAL_ONLY"),
    ).toBe("BLOCKED");
  });

  it("Task F: missing verified session (reported by the page as ready=false) is blocked the same way as policy-loading", () => {
    // The page never distinguishes "policy still loading" from
    // "verification incomplete" to Electron — both map to ready=false,
    // by design (see displayEnforcementLogic.ts's SecureClientEnforcementState
    // doc comment) — this test documents that intentional collapse.
    expect(
      resolveReadinessGatedDisplayEnforcementState({ active: true, ready: false, requireSingleDisplay: true }, 1, "INTERNAL_ONLY"),
    ).toBe("BLOCKED");
  });

  it("the INITIAL state (before the page has said anything at all) is inactive, matching a fresh DisplayEnforcement instance", () => {
    expect(INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE).toEqual({ active: false, ready: false, requireSingleDisplay: false });
  });

  it("ready + non-gated exam (requireSingleDisplay=false) is never blocked even with 2 displays", () => {
    expect(resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: false }, 2, "EXTEND")).toBe("OK");
  });

  it("ready + gated + one internal display -> allowed", () => {
    expect(resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: true }, 1, "INTERNAL_ONLY")).toBe(
      "OK",
    );
  });

  it("Task F: ready + gated + Electron count=2 -> blocked", () => {
    expect(resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: true }, 2, "INTERNAL_ONLY")).toBe(
      "BLOCKED",
    );
  });

  it("Task F: ready + gated + native EXTEND -> blocked", () => {
    expect(resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: true }, 1, "EXTEND")).toBe("BLOCKED");
  });

  it("Task F: ready + gated + native CLONE_OR_DUPLICATE -> blocked", () => {
    expect(
      resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: true }, 1, "CLONE_OR_DUPLICATE"),
    ).toBe("BLOCKED");
  });

  it("ready + gated + topology cannot be established (ERROR/UNKNOWN) -> fails closed, blocked", () => {
    expect(resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: true }, 1, "ERROR")).toBe("BLOCKED");
    expect(resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: true }, 1, "UNKNOWN")).toBe(
      "BLOCKED",
    );
  });

  it("full lifecycle: loading (blocked) -> ready+compliant (allowed) -> a display is added (blocked again)", () => {
    let state = resolveReadinessGatedDisplayEnforcementState({ active: true, ready: false, requireSingleDisplay: false }, 1, "INTERNAL_ONLY");
    expect(state).toBe("BLOCKED");
    state = resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: true }, 1, "INTERNAL_ONLY");
    expect(state).toBe("OK");
    state = resolveReadinessGatedDisplayEnforcementState({ active: true, ready: true, requireSingleDisplay: true }, 2, "EXTEND");
    expect(state).toBe("BLOCKED");
  });
});

describe("debounceDisplayEvent", () => {
  it("always processes the first event (no prior handled time)", () => {
    expect(debounceDisplayEvent(null, 1000)).toBe(true);
  });

  it("duplicate events within the debounce window are suppressed", () => {
    expect(debounceDisplayEvent(1000, 1200, 500)).toBe(false);
  });

  it("an event exactly at the debounce boundary is processed", () => {
    expect(debounceDisplayEvent(1000, 1500, 500)).toBe(true);
  });

  it("an event well after the debounce window is processed", () => {
    expect(debounceDisplayEvent(1000, 5000, 500)).toBe(true);
  });

  it("uses the default debounce window when none is supplied", () => {
    expect(debounceDisplayEvent(1000, 1000 + DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS - 1)).toBe(false);
    expect(debounceDisplayEvent(1000, 1000 + DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS)).toBe(true);
  });
});

describe("resolveDisplayEnforcementEventType", () => {
  it("display added during exam blocks: OK -> BLOCKED reports ADDITIONAL_DISPLAY_PRESENT", () => {
    const eventType = resolveDisplayEnforcementEventType({
      previousState: "OK",
      nextState: "BLOCKED",
      previousDisplayCount: 1,
      nextDisplayCount: 2,
    });
    expect(eventType).toBe("ADDITIONAL_DISPLAY_PRESENT");
  });

  it("first-ever evaluation transitioning straight to BLOCKED (previousState null) also reports ADDITIONAL_DISPLAY_PRESENT", () => {
    const eventType = resolveDisplayEnforcementEventType({
      previousState: null,
      nextState: "BLOCKED",
      previousDisplayCount: null,
      nextDisplayCount: 2,
    });
    expect(eventType).toBe("ADDITIONAL_DISPLAY_PRESENT");
  });

  it("display removed restores the exam: BLOCKED -> OK reports DISPLAY_POLICY_RESTORED", () => {
    const eventType = resolveDisplayEnforcementEventType({
      previousState: "BLOCKED",
      nextState: "OK",
      previousDisplayCount: 2,
      nextDisplayCount: 1,
    });
    expect(eventType).toBe("DISPLAY_POLICY_RESTORED");
  });

  it("still BLOCKED but the display count changed further reports DISPLAY_CONFIGURATION_CHANGED", () => {
    const eventType = resolveDisplayEnforcementEventType({
      previousState: "BLOCKED",
      nextState: "BLOCKED",
      previousDisplayCount: 2,
      nextDisplayCount: 3,
    });
    expect(eventType).toBe("DISPLAY_CONFIGURATION_CHANGED");
  });

  it("still BLOCKED with no count change reports nothing (avoid duplicate reports)", () => {
    const eventType = resolveDisplayEnforcementEventType({
      previousState: "BLOCKED",
      nextState: "BLOCKED",
      previousDisplayCount: 2,
      nextDisplayCount: 2,
    });
    expect(eventType).toBeNull();
  });

  it("was already OK and remains OK reports nothing", () => {
    const eventType = resolveDisplayEnforcementEventType({
      previousState: "OK",
      nextState: "OK",
      previousDisplayCount: 1,
      nextDisplayCount: 1,
    });
    expect(eventType).toBeNull();
  });

  it("first-ever evaluation resolving to OK (previousState null) reports nothing", () => {
    const eventType = resolveDisplayEnforcementEventType({
      previousState: null,
      nextState: "OK",
      previousDisplayCount: null,
      nextDisplayCount: 1,
    });
    expect(eventType).toBeNull();
  });
});

describe("end-to-end sequences (mirrors how displayEnforcement.ts drives these functions)", () => {
  it("one display throughout: never blocks, never reports", () => {
    const state = resolveDisplayEnforcementState(1, true);
    expect(state).toBe("OK");
    expect(resolveDisplayEnforcementEventType({ previousState: null, nextState: state, previousDisplayCount: null, nextDisplayCount: 1 })).toBeNull();
  });

  it("full lifecycle: OK -> BLOCKED (added) -> OK (removed), with debounce suppressing a duplicate event in between", () => {
    // t=0: starts at 1 display, requireSingleDisplay becomes true.
    let previousState = resolveDisplayEnforcementState(1, true);
    expect(previousState).toBe("OK");

    // t=1000: a second display is added.
    let lastHandledAt: number | null = 0;
    expect(debounceDisplayEvent(lastHandledAt, 1000)).toBe(true);
    lastHandledAt = 1000;
    let nextState = resolveDisplayEnforcementState(2, true);
    expect(nextState).toBe("BLOCKED");
    expect(
      resolveDisplayEnforcementEventType({ previousState, nextState, previousDisplayCount: 1, nextDisplayCount: 2 }),
    ).toBe("ADDITIONAL_DISPLAY_PRESENT");
    previousState = nextState;

    // t=1100: a duplicate OS event fires almost immediately — debounced away.
    expect(debounceDisplayEvent(lastHandledAt, 1100)).toBe(false);

    // t=2000: the second display is disconnected.
    expect(debounceDisplayEvent(lastHandledAt, 2000)).toBe(true);
    lastHandledAt = 2000;
    nextState = resolveDisplayEnforcementState(1, true);
    expect(nextState).toBe("OK");
    expect(
      resolveDisplayEnforcementEventType({ previousState, nextState, previousDisplayCount: 2, nextDisplayCount: 1 }),
    ).toBe("DISPLAY_POLICY_RESTORED");
  });
});

// ---------------------------------------------------------------------------
// Corrective pass v1.2.0 — structural guarantees on displayEnforcement.ts
// itself (the main-process glue, which imports "electron" and so cannot be
// instantiated/run under plain vitest/node). These assert the SOURCE TEXT
// directly rather than mocking Electron, matching this repo's established
// no-Electron-mocking convention.
// ---------------------------------------------------------------------------

const displayEnforcementSource = fs.readFileSync(path.join(__dirname, "displayEnforcement.ts"), "utf8");

describe("displayEnforcement.ts source guarantees", () => {
  it("display-added with count=2 -> immediately blocked: start(), setEnforcementState(), and the periodic recheck all bypass the debounce (the confirmed Extend-mode bug: applying the same debounce to policy activation as to raw OS events silently dropped the crucial evaluation)", () => {
    const startMethod = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("start(targetWindow"),
      displayEnforcementSource.indexOf("stop(): void"),
    );
    expect(startMethod).toMatch(/evaluate\(\{\s*bypassDebounce:\s*true\s*\}\)/);

    const setEnforcementStateMethod = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("setEnforcementState(state"),
      displayEnforcementSource.indexOf("getCurrentDisplayCount()"),
    );
    expect(setEnforcementStateMethod).toMatch(/evaluate\(\{\s*bypassDebounce:\s*true\s*\}\)/);
  });

  it("periodic check catches a change missed by a raw Electron event: a setInterval is registered in start() and cleared in stop(), also bypassing the debounce", () => {
    expect(displayEnforcementSource).toMatch(/setInterval\(/);
    expect(displayEnforcementSource).toMatch(/clearInterval\(/);
    const pollTimerCallback = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("this.pollTimer = setInterval"),
      displayEnforcementSource.indexOf("}, PERIODIC_RECHECK_MS)") + 30,
    );
    expect(pollTimerCallback).toMatch(/evaluate\(\{\s*bypassDebounce:\s*true\s*\}\)/);
  });

  it("only the raw screen.on(...) listener (handleChange) uses the debounced path — never the policy/startup/periodic paths", () => {
    const handleChangeDef = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("private readonly handleChange"),
      displayEnforcementSource.indexOf("constructor("),
    );
    expect(handleChangeDef).toMatch(/evaluate\(\{\s*bypassDebounce:\s*false\s*\}\)/);
  });

  it("answers remain intact / no automatic submission: this module never references a submission, answer, or submit endpoint — its only job is showing/hiding the overlay and computing the enforcement decision", () => {
    expect(displayEnforcementSource).not.toMatch(/submission|answer|\/submit\b|fetch\(/i);
  });

  it("the overlay window is configured to receive input instead of the exam window: always-on-top, not resizable/movable by the student, and not click-through/transparent", () => {
    const overlayOptions = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("const overlay = new BrowserWindow({"),
      displayEnforcementSource.indexOf("overlay.setAlwaysOnTop"),
    );
    expect(overlayOptions).toMatch(/alwaysOnTop:\s*true/);
    expect(overlayOptions).toMatch(/resizable:\s*false/);
    expect(overlayOptions).toMatch(/movable:\s*false/);
    expect(overlayOptions).not.toMatch(/transparent:\s*true/);
    expect(overlayOptions).not.toMatch(/focusable:\s*false/);
  });
});

// ---------------------------------------------------------------------------
// v1.7.4 pre-exam readiness — Part 13B: the confirmed
// BLOCKED==ADDITIONAL_DISPLAY_PRESENT bug and its fix. See
// docs/tether-preflight-lifecycle-v1.7.4.md.
// ---------------------------------------------------------------------------

describe("resolveCombinedDisplayDecision — reason-carrying replacement for resolveCombinedDisplayEnforcementState", () => {
  it("!requireSingleDisplay always OK regardless of display count/topology", () => {
    expect(resolveCombinedDisplayDecision(2, false, "EXTEND")).toEqual({ state: "OK" });
  });

  it("displayCount > 1 -> ADDITIONAL_ELECTRON_DISPLAY (genuine multi-display evidence)", () => {
    expect(resolveCombinedDisplayDecision(2, true, "INTERNAL_ONLY")).toEqual({ state: "BLOCKED", reason: "ADDITIONAL_ELECTRON_DISPLAY" });
  });

  it("topology EXTEND -> WINDOWS_TOPOLOGY_EXTEND", () => {
    expect(resolveCombinedDisplayDecision(1, true, "EXTEND")).toEqual({ state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_EXTEND" });
  });

  it("topology CLONE_OR_DUPLICATE -> WINDOWS_TOPOLOGY_CLONE", () => {
    expect(resolveCombinedDisplayDecision(1, true, "CLONE_OR_DUPLICATE")).toEqual({ state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_CLONE" });
  });

  it("topology MULTIPLE_ACTIVE_TARGETS -> MULTIPLE_ACTIVE_TARGETS", () => {
    expect(resolveCombinedDisplayDecision(1, true, "MULTIPLE_ACTIVE_TARGETS")).toEqual({ state: "BLOCKED", reason: "MULTIPLE_ACTIVE_TARGETS" });
  });

  it("topology ERROR/UNKNOWN -> TOPOLOGY_CHECK_UNAVAILABLE — fails closed, but never claims a real display exists", () => {
    expect(resolveCombinedDisplayDecision(1, true, "ERROR")).toEqual({ state: "BLOCKED", reason: "TOPOLOGY_CHECK_UNAVAILABLE" });
    expect(resolveCombinedDisplayDecision(1, true, "UNKNOWN")).toEqual({ state: "BLOCKED", reason: "TOPOLOGY_CHECK_UNAVAILABLE" });
  });

  it("INTERNAL_ONLY/EXTERNAL_ONLY with a single display never blocks", () => {
    expect(resolveCombinedDisplayDecision(1, true, "INTERNAL_ONLY")).toEqual({ state: "OK" });
    expect(resolveCombinedDisplayDecision(1, true, "EXTERNAL_ONLY")).toEqual({ state: "OK" });
  });
});

describe("resolveReadinessGatedDisplayDecision — the confirmed fix: active&&!ready is POLICY_NOT_READY, never conflated with a display fact", () => {
  it("!active always OK, regardless of ready/requireSingleDisplay/topology", () => {
    expect(resolveReadinessGatedDisplayDecision({ active: false, ready: false, requireSingleDisplay: true }, 2, "EXTEND")).toEqual({ state: "OK" });
  });

  it("active && !ready -> POLICY_NOT_READY — THE confirmed bug this fixes: previously indistinguishable from a real display block", () => {
    expect(resolveReadinessGatedDisplayDecision({ active: true, ready: false, requireSingleDisplay: false }, 1, "INTERNAL_ONLY")).toEqual({
      state: "BLOCKED",
      reason: "POLICY_NOT_READY",
    });
    // Even with a single real display and no topology issue — the block
    // is purely the readiness gate, never a display fact.
    expect(resolveReadinessGatedDisplayDecision({ active: true, ready: false, requireSingleDisplay: true }, 1, "INTERNAL_ONLY")).toEqual({
      state: "BLOCKED",
      reason: "POLICY_NOT_READY",
    });
  });

  it("active && ready delegates to resolveCombinedDisplayDecision unchanged", () => {
    expect(resolveReadinessGatedDisplayDecision({ active: true, ready: true, requireSingleDisplay: true }, 2, "INTERNAL_ONLY")).toEqual({
      state: "BLOCKED",
      reason: "ADDITIONAL_ELECTRON_DISPLAY",
    });
    expect(resolveReadinessGatedDisplayDecision({ active: true, ready: true, requireSingleDisplay: true }, 1, "INTERNAL_ONLY")).toEqual({ state: "OK" });
  });
});

describe("isGenuineMultiDisplayReason", () => {
  it("true only for the four reasons backed by real display evidence", () => {
    expect(isGenuineMultiDisplayReason("ADDITIONAL_ELECTRON_DISPLAY")).toBe(true);
    expect(isGenuineMultiDisplayReason("WINDOWS_TOPOLOGY_EXTEND")).toBe(true);
    expect(isGenuineMultiDisplayReason("WINDOWS_TOPOLOGY_CLONE")).toBe(true);
    expect(isGenuineMultiDisplayReason("MULTIPLE_ACTIVE_TARGETS")).toBe(true);
  });

  it("false for POLICY_NOT_READY and TOPOLOGY_CHECK_UNAVAILABLE — neither is display evidence", () => {
    expect(isGenuineMultiDisplayReason("POLICY_NOT_READY")).toBe(false);
    expect(isGenuineMultiDisplayReason("TOPOLOGY_CHECK_UNAVAILABLE")).toBe(false);
  });
});

// v1.7.5 P0 — physical-test failure: POLICY_NOT_READY produced the
// screen-saver-level, non-closable native overlay ("Preparing your
// secure exam session") with no Recheck/Exit route, requiring a Windows
// restart. See displayEnforcement.test.ts for the class-level runtime
// proof that the overlay is never actually constructed.
describe("isOverlayEligibleBlockingReason — REQUIRED TEST E: POLICY_NOT_READY can never construct/show the native overlay", () => {
  it("false only for POLICY_NOT_READY", () => {
    expect(isOverlayEligibleBlockingReason("POLICY_NOT_READY")).toBe(false);
  });

  it("true for every other blocking reason — genuine display evidence AND technical-failure reasons both still show the overlay, unchanged", () => {
    expect(isOverlayEligibleBlockingReason("ADDITIONAL_ELECTRON_DISPLAY")).toBe(true);
    expect(isOverlayEligibleBlockingReason("WINDOWS_TOPOLOGY_EXTEND")).toBe(true);
    expect(isOverlayEligibleBlockingReason("WINDOWS_TOPOLOGY_CLONE")).toBe(true);
    expect(isOverlayEligibleBlockingReason("MULTIPLE_ACTIVE_TARGETS")).toBe(true);
    expect(isOverlayEligibleBlockingReason("TOPOLOGY_CHECK_UNAVAILABLE")).toBe(true);
  });
});

describe("resolveDisplayDecisionEventType — only genuine multi-display facts may ever produce ADDITIONAL_DISPLAY_PRESENT", () => {
  it("[Part 13B] active&&!ready (POLICY_NOT_READY) never produces any event — not an integrity signal", () => {
    const nextDecision = { state: "BLOCKED" as const, reason: "POLICY_NOT_READY" as const };
    expect(resolveDisplayDecisionEventType({ previousDecision: null, nextDecision, previousDisplayCount: null, nextDisplayCount: 1 })).toBeNull();
    expect(
      resolveDisplayDecisionEventType({
        previousDecision: { state: "OK" },
        nextDecision,
        previousDisplayCount: 1,
        nextDisplayCount: 1,
      }),
    ).toBeNull();
  });

  it("[Part 13B] displayCount > 1 produces ADDITIONAL_DISPLAY_PRESENT on first transition into BLOCKED", () => {
    const nextDecision = { state: "BLOCKED" as const, reason: "ADDITIONAL_ELECTRON_DISPLAY" as const };
    expect(resolveDisplayDecisionEventType({ previousDecision: { state: "OK" }, nextDecision, previousDisplayCount: 1, nextDisplayCount: 2 })).toBe(
      "ADDITIONAL_DISPLAY_PRESENT",
    );
    expect(resolveDisplayDecisionEventType({ previousDecision: null, nextDecision, previousDisplayCount: null, nextDisplayCount: 2 })).toBe(
      "ADDITIONAL_DISPLAY_PRESENT",
    );
  });

  it("[Part 13B] EXTEND produces ADDITIONAL_DISPLAY_PRESENT on first transition, DISPLAY_CONFIGURATION_CHANGED on a further count change while still blocked for the SAME reason", () => {
    const extend = { state: "BLOCKED" as const, reason: "WINDOWS_TOPOLOGY_EXTEND" as const };
    expect(resolveDisplayDecisionEventType({ previousDecision: { state: "OK" }, nextDecision: extend, previousDisplayCount: 1, nextDisplayCount: 2 })).toBe(
      "ADDITIONAL_DISPLAY_PRESENT",
    );
    expect(resolveDisplayDecisionEventType({ previousDecision: extend, nextDecision: extend, previousDisplayCount: 2, nextDisplayCount: 3 })).toBe(
      "DISPLAY_CONFIGURATION_CHANGED",
    );
    expect(resolveDisplayDecisionEventType({ previousDecision: extend, nextDecision: extend, previousDisplayCount: 2, nextDisplayCount: 2 })).toBeNull();
  });

  it("[Part 13B] CLONE produces ADDITIONAL_DISPLAY_PRESENT on first transition", () => {
    const clone = { state: "BLOCKED" as const, reason: "WINDOWS_TOPOLOGY_CLONE" as const };
    expect(resolveDisplayDecisionEventType({ previousDecision: { state: "OK" }, nextDecision: clone, previousDisplayCount: 1, nextDisplayCount: 2 })).toBe(
      "ADDITIONAL_DISPLAY_PRESENT",
    );
  });

  it("[Part 13B] ERROR/UNKNOWN (TOPOLOGY_CHECK_UNAVAILABLE) produces DISPLAY_CHECK_TECHNICAL_FAILURE once, then null while unchanged — NEVER ADDITIONAL_DISPLAY_PRESENT", () => {
    const unavailable = { state: "BLOCKED" as const, reason: "TOPOLOGY_CHECK_UNAVAILABLE" as const };
    expect(
      resolveDisplayDecisionEventType({ previousDecision: { state: "OK" }, nextDecision: unavailable, previousDisplayCount: 1, nextDisplayCount: 1 }),
    ).toBe("DISPLAY_CHECK_TECHNICAL_FAILURE");
    expect(
      resolveDisplayDecisionEventType({ previousDecision: unavailable, nextDecision: unavailable, previousDisplayCount: 1, nextDisplayCount: 1 }),
    ).toBeNull();
  });

  it("[Part 13B] transitioning from a genuine multi-display block back to OK produces DISPLAY_POLICY_RESTORED", () => {
    const extend = { state: "BLOCKED" as const, reason: "WINDOWS_TOPOLOGY_EXTEND" as const };
    expect(resolveDisplayDecisionEventType({ previousDecision: extend, nextDecision: { state: "OK" }, previousDisplayCount: 2, nextDisplayCount: 1 })).toBe(
      "DISPLAY_POLICY_RESTORED",
    );
  });

  it("[Part 13B] transitioning from POLICY_NOT_READY or TOPOLOGY_CHECK_UNAVAILABLE back to OK produces NO event — neither was ever reported as a display-presence problem", () => {
    const notReady = { state: "BLOCKED" as const, reason: "POLICY_NOT_READY" as const };
    const unavailable = { state: "BLOCKED" as const, reason: "TOPOLOGY_CHECK_UNAVAILABLE" as const };
    expect(resolveDisplayDecisionEventType({ previousDecision: notReady, nextDecision: { state: "OK" }, previousDisplayCount: 1, nextDisplayCount: 1 })).toBeNull();
    expect(
      resolveDisplayDecisionEventType({ previousDecision: unavailable, nextDecision: { state: "OK" }, previousDisplayCount: 1, nextDisplayCount: 1 }),
    ).toBeNull();
  });
});

describe("displayBlockingReasonCopy — never claims a display exists without genuine evidence", () => {
  it("ADDITIONAL_ELECTRON_DISPLAY/EXTEND/CLONE/MULTIPLE_ACTIVE_TARGETS mention a display", () => {
    for (const reason of ["ADDITIONAL_ELECTRON_DISPLAY", "WINDOWS_TOPOLOGY_EXTEND", "WINDOWS_TOPOLOGY_CLONE", "MULTIPLE_ACTIVE_TARGETS"] as const) {
      const copy = displayBlockingReasonCopy(reason);
      expect(copy.title.toLowerCase() + copy.message.toLowerCase()).toMatch(/display/);
    }
  });

  it("POLICY_NOT_READY never claims a display was found", () => {
    const copy = displayBlockingReasonCopy("POLICY_NOT_READY");
    expect(copy.message.toLowerCase()).not.toContain("additional display");
    expect(copy.message.toLowerCase()).not.toContain("disconnect");
  });

  it("TOPOLOGY_CHECK_UNAVAILABLE uses neutral wording and never claims a display was found", () => {
    const copy = displayBlockingReasonCopy("TOPOLOGY_CHECK_UNAVAILABLE");
    expect(copy.message).toBe("Tether could not verify the display configuration. Resolve the display check before beginning the examination.");
    expect(copy.message.toLowerCase()).not.toContain("additional display connected");
  });
});

