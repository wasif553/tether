import { describe, it, expect } from "vitest";
import {
  nextKeyboardHardeningState,
  isContentBlockedByHardeningState,
  hasExhaustedRecoveryAttempts,
  isHelperLossHarmless,
  INITIAL_KEYBOARD_HARDENING_STATE,
  MAX_RECOVERY_ATTEMPTS,
  type KeyboardHardeningMachineState,
} from "./keyboardHardeningRecoveryLogic";

describe("nextKeyboardHardeningState — arming", () => {
  it("IDLE + ARM_REQUESTED -> ARMING, attempts reset to 0", () => {
    const next = nextKeyboardHardeningState(INITIAL_KEYBOARD_HARDENING_STATE, "ARM_REQUESTED");
    expect(next).toEqual({ state: "ARMING", recoveryAttemptsUsed: 0 });
  });

  it("ARMING + ARM_SUCCEEDED -> ARMED", () => {
    const arming: KeyboardHardeningMachineState = { state: "ARMING", recoveryAttemptsUsed: 0 };
    expect(nextKeyboardHardeningState(arming, "ARM_SUCCEEDED")).toEqual({ state: "ARMED", recoveryAttemptsUsed: 0 });
  });

  it("ARMING + ARM_FAILED -> IDLE (a failed activation NEVER becomes a recovering state — it is a PRE-EXAM failure, exam must not enter secure content)", () => {
    const arming: KeyboardHardeningMachineState = { state: "ARMING", recoveryAttemptsUsed: 0 };
    expect(nextKeyboardHardeningState(arming, "ARM_FAILED")).toEqual({ state: "IDLE", recoveryAttemptsUsed: 0 });
  });

  it("ARM_SUCCEEDED/ARM_FAILED are no-ops from every state other than ARMING", () => {
    for (const state of ["IDLE", "ARMED", "RECOVERING", "RECOVERY_FAILED", "DISARMED"] as const) {
      const current: KeyboardHardeningMachineState = { state, recoveryAttemptsUsed: 1 };
      expect(nextKeyboardHardeningState(current, "ARM_SUCCEEDED")).toEqual(current);
      expect(nextKeyboardHardeningState(current, "ARM_FAILED")).toEqual(current);
    }
  });
});

describe("nextKeyboardHardeningState — the CRITICAL CORRECTION: heartbeat loss only ever affects THIS machine", () => {
  it("ARMED + HEARTBEAT_LOST -> RECOVERING, attempts reset to 0", () => {
    const armed: KeyboardHardeningMachineState = { state: "ARMED", recoveryAttemptsUsed: 0 };
    expect(nextKeyboardHardeningState(armed, "HEARTBEAT_LOST")).toEqual({ state: "RECOVERING", recoveryAttemptsUsed: 0 });
  });

  it("HEARTBEAT_LOST is a no-op from every state other than ARMED — it can never fire twice into a stacked recovery, and never fires for a precheck-time (IDLE/ARMING) loss", () => {
    for (const state of ["IDLE", "ARMING", "RECOVERING", "RECOVERY_FAILED", "DISARMED"] as const) {
      const current: KeyboardHardeningMachineState = { state, recoveryAttemptsUsed: 0 };
      expect(nextKeyboardHardeningState(current, "HEARTBEAT_LOST")).toEqual(current);
    }
  });
});

describe("nextKeyboardHardeningState — bounded recovery", () => {
  it("RECOVERING + RECOVERY_ATTEMPT_SUCCEEDED -> ARMED, attempts reset to 0 (a later fresh HEARTBEAT_LOST starts counting from zero again)", () => {
    const recovering: KeyboardHardeningMachineState = { state: "RECOVERING", recoveryAttemptsUsed: 1 };
    expect(nextKeyboardHardeningState(recovering, "RECOVERY_ATTEMPT_SUCCEEDED")).toEqual({ state: "ARMED", recoveryAttemptsUsed: 0 });
  });

  it("RECOVERING + RECOVERY_ATTEMPT_FAILED increments recoveryAttemptsUsed and stays RECOVERING", () => {
    let state: KeyboardHardeningMachineState = { state: "RECOVERING", recoveryAttemptsUsed: 0 };
    state = nextKeyboardHardeningState(state, "RECOVERY_ATTEMPT_FAILED");
    expect(state).toEqual({ state: "RECOVERING", recoveryAttemptsUsed: 1 });
    state = nextKeyboardHardeningState(state, "RECOVERY_ATTEMPT_FAILED");
    expect(state).toEqual({ state: "RECOVERING", recoveryAttemptsUsed: 2 });
  });

  it("RECOVERING + RECOVERY_ATTEMPTS_EXHAUSTED -> RECOVERY_FAILED, a terminal state within this episode", () => {
    const recovering: KeyboardHardeningMachineState = { state: "RECOVERING", recoveryAttemptsUsed: MAX_RECOVERY_ATTEMPTS };
    expect(nextKeyboardHardeningState(recovering, "RECOVERY_ATTEMPTS_EXHAUSTED")).toEqual({ state: "RECOVERY_FAILED", recoveryAttemptsUsed: MAX_RECOVERY_ATTEMPTS });
  });

  it("RECOVERY_FAILED never silently self-heals: RECOVERY_ATTEMPT_SUCCEEDED/RECOVERY_ATTEMPT_FAILED are no-ops from RECOVERY_FAILED", () => {
    const failed: KeyboardHardeningMachineState = { state: "RECOVERY_FAILED", recoveryAttemptsUsed: MAX_RECOVERY_ATTEMPTS };
    expect(nextKeyboardHardeningState(failed, "RECOVERY_ATTEMPT_SUCCEEDED")).toEqual(failed);
    expect(nextKeyboardHardeningState(failed, "RECOVERY_ATTEMPT_FAILED")).toEqual(failed);
  });
});

describe("nextKeyboardHardeningState — DISARM always wins, even mid-recovery (restoration must never be blocked)", () => {
  it("DISARM_REQUESTED moves every non-terminal state to DISARMED", () => {
    for (const state of ["IDLE", "ARMING", "ARMED", "RECOVERING", "RECOVERY_FAILED"] as const) {
      const current: KeyboardHardeningMachineState = { state, recoveryAttemptsUsed: 1 };
      expect(nextKeyboardHardeningState(current, "DISARM_REQUESTED")).toEqual({ state: "DISARMED", recoveryAttemptsUsed: 0 });
    }
  });

  it("DISARM_REQUESTED from DISARMED is idempotent", () => {
    const disarmed: KeyboardHardeningMachineState = { state: "DISARMED", recoveryAttemptsUsed: 0 };
    expect(nextKeyboardHardeningState(disarmed, "DISARM_REQUESTED")).toEqual(disarmed);
  });

  it("DISARM_COMPLETED is an idempotent terminal confirmation from any state", () => {
    for (const state of ["IDLE", "ARMING", "ARMED", "RECOVERING", "RECOVERY_FAILED", "DISARMED"] as const) {
      const current: KeyboardHardeningMachineState = { state, recoveryAttemptsUsed: 1 };
      expect(nextKeyboardHardeningState(current, "DISARM_COMPLETED")).toEqual({ state: "DISARMED", recoveryAttemptsUsed: 0 });
    }
  });
});

describe("isContentBlockedByHardeningState", () => {
  it("blocks only while RECOVERING or RECOVERY_FAILED", () => {
    expect(isContentBlockedByHardeningState("RECOVERING")).toBe(true);
    expect(isContentBlockedByHardeningState("RECOVERY_FAILED")).toBe(true);
    expect(isContentBlockedByHardeningState("IDLE")).toBe(false);
    expect(isContentBlockedByHardeningState("ARMING")).toBe(false);
    expect(isContentBlockedByHardeningState("ARMED")).toBe(false);
    expect(isContentBlockedByHardeningState("DISARMED")).toBe(false);
  });
});

describe("hasExhaustedRecoveryAttempts", () => {
  it("is false below MAX_RECOVERY_ATTEMPTS and true at/above it — bounded, never infinite", () => {
    expect(hasExhaustedRecoveryAttempts({ state: "RECOVERING", recoveryAttemptsUsed: MAX_RECOVERY_ATTEMPTS - 1 })).toBe(false);
    expect(hasExhaustedRecoveryAttempts({ state: "RECOVERING", recoveryAttemptsUsed: MAX_RECOVERY_ATTEMPTS })).toBe(true);
    expect(hasExhaustedRecoveryAttempts({ state: "RECOVERING", recoveryAttemptsUsed: MAX_RECOVERY_ATTEMPTS + 1 })).toBe(true);
  });
});

describe("Final activation-failure safety audit (post-v1.8.0) — item 3: RECOVERY_FAILED behaviour end-to-end", () => {
  it("ARMED -> HEARTBEAT_LOST -> bounded RECOVERY_ATTEMPT_FAILED x MAX_RECOVERY_ATTEMPTS -> RECOVERY_ATTEMPTS_EXHAUSTED leaves content blocked and never silently returns to ARMED on its own", () => {
    let state = nextKeyboardHardeningState({ state: "ARMED", recoveryAttemptsUsed: 0 }, "HEARTBEAT_LOST");
    expect(state.state).toBe("RECOVERING");
    expect(isContentBlockedByHardeningState(state.state)).toBe(true);

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      expect(hasExhaustedRecoveryAttempts(state)).toBe(false);
      state = nextKeyboardHardeningState(state, "RECOVERY_ATTEMPT_FAILED");
    }
    expect(hasExhaustedRecoveryAttempts(state)).toBe(true);

    state = nextKeyboardHardeningState(state, "RECOVERY_ATTEMPTS_EXHAUSTED");
    expect(state.state).toBe("RECOVERY_FAILED");
    expect(isContentBlockedByHardeningState(state.state)).toBe(true);

    // No event in this machine's vocabulary ever moves RECOVERY_FAILED
    // back to ARMED on its own — the only way out is an explicit
    // DISARM_REQUESTED (a real relaunch/restore), never a retry timer or
    // a later successful heartbeat.
    for (const event of ["HEARTBEAT_LOST", "RECOVERY_ATTEMPT_SUCCEEDED", "RECOVERY_ATTEMPT_FAILED", "RECOVERY_ATTEMPTS_EXHAUSTED", "ARM_SUCCEEDED", "ARM_FAILED", "ARM_REQUESTED"] as const) {
      expect(nextKeyboardHardeningState(state, event)).toEqual(state);
    }

    // The only exit: an explicit disarm (a genuine relaunch/restore flow).
    const disarmed = nextKeyboardHardeningState(state, "DISARM_REQUESTED");
    expect(disarmed.state).toBe("DISARMED");
    expect(isContentBlockedByHardeningState(disarmed.state)).toBe(false);
  });
});

describe("isHelperLossHarmless — precheck/not-yet-active loss must never create an integrity event", () => {
  it("harmless for IDLE, ARMING, DISARMED", () => {
    expect(isHelperLossHarmless("IDLE")).toBe(true);
    expect(isHelperLossHarmless("ARMING")).toBe(true);
    expect(isHelperLossHarmless("DISARMED")).toBe(true);
  });

  it("NOT harmless for ARMED, RECOVERING, RECOVERY_FAILED — these are exactly the states where a loss is security-relevant", () => {
    expect(isHelperLossHarmless("ARMED")).toBe(false);
    expect(isHelperLossHarmless("RECOVERING")).toBe(false);
    expect(isHelperLossHarmless("RECOVERY_FAILED")).toBe(false);
  });
});
