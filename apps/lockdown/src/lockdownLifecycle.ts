/**
 * Tether Windows Lockdown Hardening v1 — restoration and crash-safety
 * lifecycle (Part 10). Pure state machine plus a thin, testable manager
 * around it — no Electron dependency (main.ts wires real teardown
 * actions — hiding overlays, stopping the process-detection poll,
 * clearing enforcement state — into `registerRestoreAction`).
 *
 * Tether never modifies any permanent OS-level setting (no registry
 * write, no group policy, no persistent keyboard remap) — see
 * docs/tether-windows-lockdown-hardening-v1.md, "Restoration". Because
 * of that, there is nothing to "snapshot and restore exactly" at the OS
 * level; restoration here is entirely about tearing down THIS app's own
 * in-process temporary state (overlay windows, polling timers,
 * enforcement flags), which is always safe, always fully reversible,
 * and never requires elevated privileges or a registry round-trip.
 */

export const LOCKDOWN_LIFECYCLE_STATES = ["PREPARING", "ACTIVE", "RESTORING", "RESTORED", "RESTORE_FAILED"] as const;
export type LockdownLifecycleState = (typeof LOCKDOWN_LIFECYCLE_STATES)[number];

export type LockdownLifecycleEvent = "PREPARE" | "ACTIVATE" | "BEGIN_RESTORE" | "RESTORE_SUCCEEDED" | "RESTORE_FAILED_EVENT";

/**
 * A total function over every (state, event) pair — the same event
 * always produces the same resulting state regardless of the current
 * one. This is what makes the lifecycle inherently idempotent (Part 10:
 * "restoration may be called multiple times safely") — calling
 * RESTORE_SUCCEEDED again while already RESTORED is a no-op transition
 * to the same state, never an error, and there is no "illegal
 * transition" case anywhere (Tether must never trap on its own internal
 * bookkeeping — see the "Do not implement" list's "inaccessible kiosk
 * behaviour that traps the student after failure").
 */
export function nextLockdownLifecycleState(_current: LockdownLifecycleState, event: LockdownLifecycleEvent): LockdownLifecycleState {
  switch (event) {
    case "PREPARE":
      return "PREPARING";
    case "ACTIVATE":
      return "ACTIVE";
    case "BEGIN_RESTORE":
      return "RESTORING";
    case "RESTORE_SUCCEEDED":
      return "RESTORED";
    case "RESTORE_FAILED_EVENT":
      return "RESTORE_FAILED";
  }
}

export type RestoreResult = { state: LockdownLifecycleState; errors: string[] };

/**
 * Part 17 — dev/test-only fault injection hook. Deliberately a plain
 * injected function (not an import of lockdownFaultInjection.ts
 * directly) so this module stays free of any Electron/environment
 * dependency of its own and remains trivially unit-testable — main.ts
 * wires the real consumeLockdownFault("RESTORATION_FAILURE") check in
 * when constructing its LockdownLifecycleManager.
 */
export type RestoreFaultInjector = () => boolean;

/**
 * Owns the ordered list of teardown actions this session has registered
 * (overlay hide, polling stop, enforcement-flag clear, ...) and runs
 * every one of them on every restore() call, regardless of current
 * state (Part 10: "restoration may be called multiple times safely") —
 * an action failing never stops the rest from running (Part 10: "record
 * restoration failure operationally" rather than leaving other cleanup
 * undone because one step threw).
 */
export class LockdownLifecycleManager {
  private state: LockdownLifecycleState = "PREPARING";
  private readonly restoreActions: Array<{ name: string; action: () => void }> = [];
  private readonly faultInjector: RestoreFaultInjector | null;

  constructor(faultInjector: RestoreFaultInjector | null = null) {
    this.faultInjector = faultInjector;
  }

  getState(): LockdownLifecycleState {
    return this.state;
  }

  registerRestoreAction(name: string, action: () => void): void {
    this.restoreActions.push({ name, action });
  }

  prepare(): void {
    this.state = nextLockdownLifecycleState(this.state, "PREPARE");
  }

  activate(): void {
    this.state = nextLockdownLifecycleState(this.state, "ACTIVATE");
  }

  /**
   * 25/26 — safe to call any number of times, from any state, including
   * concurrently-overlapping calls (e.g. a renderer crash firing while a
   * normal-exit restore is already in progress): every registered action
   * runs again, which is safe because every action this app registers is
   * itself idempotent (hiding an already-hidden overlay, clearing an
   * already-clear timer, resetting an already-default flag).
   */
  restore(): RestoreResult {
    this.state = nextLockdownLifecycleState(this.state, "BEGIN_RESTORE");
    const errors: string[] = [];
    for (const { name, action } of this.restoreActions) {
      try {
        action();
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Part 17 — dev/test-only fault injection: forces a failure even
    // when every real action above succeeded, so the RESTORE_FAILED path
    // (and whatever the caller does with it — recording
    // TETHER_LOCKDOWN_RESTORATION_FAILED, showing support guidance) can
    // be exercised deterministically without needing a real teardown
    // action to actually break.
    if (this.faultInjector?.()) {
      errors.push("fault-injection: RESTORATION_FAILURE armed");
    }
    this.state = nextLockdownLifecycleState(this.state, errors.length === 0 ? "RESTORE_SUCCEEDED" : "RESTORE_FAILED_EVENT");
    return { state: this.state, errors };
  }
}
