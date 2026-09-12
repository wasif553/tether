import { describe, it, expect } from "vitest";
import { shouldPreventOrdinaryClose } from "./windowCloseGuard";
import { LOCKDOWN_LIFECYCLE_STATES, LockdownLifecycleManager } from "./lockdownLifecycle";

describe("shouldPreventOrdinaryClose", () => {
  it("prevents close ONLY while ACTIVE", () => {
    expect(shouldPreventOrdinaryClose("ACTIVE")).toBe(true);
  });

  it("allows close for every other lifecycle state — precheck failure, a finished exam, mid-restore, and a failed restore must never trap the student", () => {
    for (const state of LOCKDOWN_LIFECYCLE_STATES) {
      if (state === "ACTIVE") continue;
      expect(shouldPreventOrdinaryClose(state)).toBe(false);
    }
  });
});

describe("Final activation-failure safety audit (post-v1.8.0) — item 1: normal restore lifts close-interception, so legitimate shutdown after exam completion is never blocked", () => {
  it("a real LockdownLifecycleManager, once ACTIVE (close would be prevented), allows close again the instant restore() runs — even before any individual restore action has completed", () => {
    const manager = new LockdownLifecycleManager();
    manager.prepare();
    manager.activate();
    expect(shouldPreventOrdinaryClose(manager.getState())).toBe(true);

    manager.restore();
    // restore() is synchronous end-to-end (BEGIN_RESTORE -> run every
    // action -> RESTORE_SUCCEEDED/RESTORE_FAILED) — by the time it
    // returns, the state has already left ACTIVE.
    expect(shouldPreventOrdinaryClose(manager.getState())).toBe(false);
  });

  it("close is allowed even when restore() reports failures (a broken restore action must never re-trap the student behind a still-blocked close)", () => {
    const manager = new LockdownLifecycleManager();
    manager.prepare();
    manager.registerRestoreAction("broken", () => {
      throw new Error("simulated teardown failure");
    });
    manager.activate();
    expect(shouldPreventOrdinaryClose(manager.getState())).toBe(true);

    const result = manager.restore();
    expect(result.state).toBe("RESTORE_FAILED");
    expect(shouldPreventOrdinaryClose(manager.getState())).toBe(false);
  });
});
