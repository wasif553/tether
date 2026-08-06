import { runOnWindowBestEffort, type DestroyableWindowLike } from "./windowLifecycleGuard";
import type { LockdownLifecycleState, RestoreResult } from "./lockdownLifecycle";

/**
 * Destroyed-window crash fix v1.7.1 — the corrected restoration lifecycle
 * contract, extracted out of main.ts so it can be exercised by real tests
 * without an Electron runtime (this repo's established convention for
 * anything that needs genuine behavioural coverage rather than a
 * source-text assertion — see lockdownLifecycle.ts).
 *
 * Critical restoration (lifecycle.restore()) is independent of any window:
 * it is called exactly once here, unconditionally, and is never wrapped in
 * a try/catch that could hide a real OS-restoration failure — each
 * individual restore action already catches and records its own failure
 * (see lockdownLifecycle.ts's own doc comment). Audit reporting and the
 * renderer notification are both optional and best-effort: they run only
 * when controller.getWindow() currently returns a usable window, and a
 * failure inside either one can never stop or interrupt restoration.
 */

export interface LockdownLifecycleLike {
  getState(): LockdownLifecycleState;
  restore(): RestoreResult;
}

export interface RestorationOutcome {
  trigger: string;
  state: LockdownLifecycleState;
  errors: string[];
}

export interface RestorationController<TWindow extends DestroyableWindowLike> {
  getWindow(): TWindow | null;
  reportAuditFact(window: TWindow, action: string, metadata: Record<string, unknown>): void;
  sendResult(window: TWindow, outcome: RestorationOutcome): void;
  diagnosticLog?(message: string, data: Record<string, unknown>): void;
}

export function performLockdownRestoration<TWindow extends DestroyableWindowLike>(
  lifecycle: LockdownLifecycleLike,
  controller: RestorationController<TWindow>,
  trigger: string,
): RestorationOutcome {
  controller.diagnosticLog?.("lockdownLifecycle: restore requested", { trigger, stateBefore: lifecycle.getState() });

  runOnWindowBestEffort(controller.getWindow(), (window) =>
    controller.reportAuditFact(window, "TETHER_LOCKDOWN_RESTORATION_STARTED", { trigger }),
  );

  // Critical restoration — unconditional, independent of window state,
  // and deliberately not inside a try/catch: see file doc comment above.
  const result = lifecycle.restore();

  const outcome: RestorationOutcome = { trigger, state: result.state, errors: result.errors };
  const completionAction = result.state === "RESTORED" ? "TETHER_LOCKDOWN_RESTORATION_COMPLETED" : "TETHER_LOCKDOWN_RESTORATION_FAILED";
  runOnWindowBestEffort(controller.getWindow(), (window) =>
    controller.reportAuditFact(window, completionAction, { trigger, errorCount: result.errors.length }),
  );
  runOnWindowBestEffort(controller.getWindow(), (window) => controller.sendResult(window, outcome));

  controller.diagnosticLog?.("lockdownLifecycle: restore result", { trigger, result });

  return outcome;
}
