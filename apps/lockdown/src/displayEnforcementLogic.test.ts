import { describe, it, expect } from "vitest";
import {
  resolveDisplayEnforcementState,
  debounceDisplayEvent,
  resolveDisplayEnforcementEventType,
  DEFAULT_DISPLAY_EVENT_DEBOUNCE_MS,
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
