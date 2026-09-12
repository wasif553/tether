/**
 * Tether Windows Hardening v1.8.0, Phase A+B — pure state machine for the
 * native keyboard-hardening helper's own lifecycle. No Electron/Node
 * dependency, no timers — safe to unit-test directly, matching this
 * package's established convention (see lockdownLifecycle.ts,
 * remoteSessionMonitorLogic.ts).
 *
 * CRITICAL CORRECTION baked into this design (per the task's own explicit
 * instruction): losing the helper's heartbeat while ARMED must NEVER be
 * treated as an ordinary "restore everything" event. Display enforcement,
 * remote-session monitoring, and prohibited-process monitoring are
 * separate, still-working mechanisms (see displayEnforcement.ts /
 * remoteSessionMonitor.ts / processDetection.ts) and must keep running
 * untouched. Heartbeat loss instead moves this machine into RECOVERING —
 * a distinct, narrower state that only concerns the keyboard-hardening
 * mechanism itself — never lockdownLifecycle's own restore().
 *
 * States:
 * - IDLE — no exam active; helper not expected to be armed. Helper loss
 *   here is harmless (see isHelperLossHarmless below) — this is the
 *   PRECHECK/PREPARING equivalent for this one narrow mechanism.
 * - ARMING — an activation attempt is in flight (ARM sent, awaiting
 *   ARMED/ARM_FAILED). Never reached from a precheck-only path — see
 *   keyboardHookHelperManager.ts's own doc comment on the activation
 *   boundary.
 * - ARMED — healthy: hook is installed and heartbeats are flowing. Exam
 *   content is visible/interactive.
 * - RECOVERING — heartbeat was lost while ARMED. Exam content must be
 *   covered/blocked (a separate concern this module only signals via
 *   isContentBlocked, never itself renders) while a BOUNDED number of
 *   restart-and-rearm attempts are made.
 * - RECOVERY_FAILED — every bounded attempt failed. Terminal within this
 *   exam attempt: content stays blocked and this machine will never
 *   silently self-heal back to ARMED on its own — only an explicit
 *   DISARM_REQUESTED (the student relaunching / the existing secure-
 *   session recovery flow) moves it anywhere else. This is a UX-level
 *   "stay blocked" state only — it never represents a permanent OS-level
 *   change (nothing here ever touches Windows itself); Ctrl+Alt+Delete
 *   and Task Manager remain fully available throughout.
 * - DISARMED — clean shutdown complete (normal restoration, or abandoning
 *   an in-progress recovery because restoration must never be blocked by
 *   it — see the DISARM_REQUESTED transitions from every non-terminal
 *   state below).
 */

export const KEYBOARD_HARDENING_STATES = ["IDLE", "ARMING", "ARMED", "RECOVERING", "RECOVERY_FAILED", "DISARMED"] as const;
export type KeyboardHardeningState = (typeof KEYBOARD_HARDENING_STATES)[number];

export type KeyboardHardeningEvent =
  | "ARM_REQUESTED"
  | "ARM_SUCCEEDED"
  | "ARM_FAILED"
  | "HEARTBEAT_LOST"
  | "RECOVERY_ATTEMPT_SUCCEEDED"
  | "RECOVERY_ATTEMPT_FAILED"
  | "RECOVERY_ATTEMPTS_EXHAUSTED"
  | "DISARM_REQUESTED"
  | "DISARM_COMPLETED";

export type KeyboardHardeningMachineState = {
  state: KeyboardHardeningState;
  /** Reset to 0 on every fresh ARM_REQUESTED/ARM_SUCCEEDED; incremented once per RECOVERY_ATTEMPT_FAILED. */
  recoveryAttemptsUsed: number;
};

export const INITIAL_KEYBOARD_HARDENING_STATE: KeyboardHardeningMachineState = { state: "IDLE", recoveryAttemptsUsed: 0 };

/** Bounded — matches the task's explicit "do not loop forever" requirement. */
export const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * The single pure transition function — a partial function over
 * (state, event): an event that makes no sense for the current state
 * (e.g. HEARTBEAT_LOST while IDLE) is a no-op, returning the SAME state
 * object unchanged, never a thrown error and never an unrelated
 * transition. This mirrors lockdownLifecycle.ts's own "never trap on an
 * illegal transition" philosophy while still being stricter than that
 * module (which is a true total function) — stricter is appropriate
 * here because, unlike lockdownLifecycle's plain teardown restore(),
 * mis-transitioning this machine could plausibly mean either
 * prematurely uncovering content or looping recovery attempts forever,
 * both of which the task explicitly prohibits.
 */
export function nextKeyboardHardeningState(current: KeyboardHardeningMachineState, event: KeyboardHardeningEvent): KeyboardHardeningMachineState {
  const { state } = current;

  switch (event) {
    case "ARM_REQUESTED":
      if (state === "IDLE" || state === "DISARMED") return { state: "ARMING", recoveryAttemptsUsed: 0 };
      return current;

    case "ARM_SUCCEEDED":
      if (state === "ARMING") return { state: "ARMED", recoveryAttemptsUsed: 0 };
      return current;

    case "ARM_FAILED":
      // A failed ARM during initial activation returns to IDLE — this is
      // a PRE-EXAM failure (see keyboardHookHelperManager.ts /
      // main.ts's activation handler): the caller must refuse to enter
      // secure content at all, never enter a "recovering" state for an
      // activation that never succeeded in the first place.
      if (state === "ARMING") return { state: "IDLE", recoveryAttemptsUsed: 0 };
      return current;

    case "HEARTBEAT_LOST":
      if (state === "ARMED") return { state: "RECOVERING", recoveryAttemptsUsed: 0 };
      return current;

    case "RECOVERY_ATTEMPT_SUCCEEDED":
      if (state === "RECOVERING") return { state: "ARMED", recoveryAttemptsUsed: 0 };
      return current;

    case "RECOVERY_ATTEMPT_FAILED":
      if (state === "RECOVERING") return { state: "RECOVERING", recoveryAttemptsUsed: current.recoveryAttemptsUsed + 1 };
      return current;

    case "RECOVERY_ATTEMPTS_EXHAUSTED":
      if (state === "RECOVERING") return { state: "RECOVERY_FAILED", recoveryAttemptsUsed: current.recoveryAttemptsUsed };
      return current;

    case "DISARM_REQUESTED":
      // Allowed from every non-terminal state, including mid-recovery —
      // restoration must never be blocked by an in-progress recovery
      // cycle (crash-safety / never-trap takes priority over finishing
      // a recovery attempt). A no-op if already DISARMED.
      if (state === "DISARMED") return current;
      return { state: "DISARMED", recoveryAttemptsUsed: 0 };

    case "DISARM_COMPLETED":
      // Idempotent terminal confirmation — safe to receive more than once.
      return { state: "DISARMED", recoveryAttemptsUsed: 0 };
  }
}

/** True only for the states where exam content must be covered/blocked from student interaction — the ONE thing this module exists to decide for its caller. */
export function isContentBlockedByHardeningState(state: KeyboardHardeningState): boolean {
  return state === "RECOVERING" || state === "RECOVERY_FAILED";
}

/** True once every bounded recovery attempt has already been used up this episode. */
export function hasExhaustedRecoveryAttempts(machineState: KeyboardHardeningMachineState): boolean {
  return machineState.recoveryAttemptsUsed >= MAX_RECOVERY_ATTEMPTS;
}

/**
 * True when a lost/never-armed helper is harmless and must NOT produce
 * any integrity/audit signal — precheck/not-yet-active is exactly the
 * state where Windows must remain fully normal and nothing is being
 * enforced yet (see main.ts's PRE-EXAM READINESS phase and the task's
 * own "PRECHECK/PREPARING: helper loss is harmless and must not create
 * an integrity event").
 */
export function isHelperLossHarmless(state: KeyboardHardeningState): boolean {
  return state === "IDLE" || state === "ARMING" || state === "DISARMED";
}
