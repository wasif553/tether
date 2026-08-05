import { describe, it, expect } from "vitest";
import { nextLockdownLifecycleState, LockdownLifecycleManager } from "./lockdownLifecycle";

describe("nextLockdownLifecycleState — pure transitions", () => {
  it("every event maps to its named state regardless of current state", () => {
    for (const current of ["PREPARING", "ACTIVE", "RESTORING", "RESTORED", "RESTORE_FAILED"] as const) {
      expect(nextLockdownLifecycleState(current, "PREPARE")).toBe("PREPARING");
      expect(nextLockdownLifecycleState(current, "ACTIVATE")).toBe("ACTIVE");
      expect(nextLockdownLifecycleState(current, "BEGIN_RESTORE")).toBe("RESTORING");
      expect(nextLockdownLifecycleState(current, "RESTORE_SUCCEEDED")).toBe("RESTORED");
      expect(nextLockdownLifecycleState(current, "RESTORE_FAILED_EVENT")).toBe("RESTORE_FAILED");
    }
  });
});

describe("LockdownLifecycleManager", () => {
  it("starts PREPARING", () => {
    expect(new LockdownLifecycleManager().getState()).toBe("PREPARING");
  });

  it("prepare/activate move through the expected states", () => {
    const manager = new LockdownLifecycleManager();
    manager.prepare();
    expect(manager.getState()).toBe("PREPARING");
    manager.activate();
    expect(manager.getState()).toBe("ACTIVE");
  });

  it("restore() runs every registered action and ends RESTORED on success", () => {
    const manager = new LockdownLifecycleManager();
    const calls: string[] = [];
    manager.registerRestoreAction("hideOverlay", () => calls.push("hideOverlay"));
    manager.registerRestoreAction("stopPolling", () => calls.push("stopPolling"));
    manager.activate();

    const result = manager.restore();
    expect(result).toEqual({ state: "RESTORED", errors: [] });
    expect(calls).toEqual(["hideOverlay", "stopPolling"]);
  });

  it("11. restoration itself never creates a misconduct-implying result — RestoreResult carries only state/errors, no severity/eventType field at all", () => {
    const manager = new LockdownLifecycleManager();
    const result = manager.restore();
    expect(Object.keys(result).sort()).toEqual(["errors", "state"]);
  });

  it("a failing action is recorded but never stops the remaining actions from running", () => {
    const manager = new LockdownLifecycleManager();
    const calls: string[] = [];
    manager.registerRestoreAction("throwsAlways", () => {
      throw new Error("disk write failed");
    });
    manager.registerRestoreAction("stillRuns", () => calls.push("stillRuns"));

    const result = manager.restore();
    expect(result.state).toBe("RESTORE_FAILED");
    expect(result.errors).toEqual(["throwsAlways: disk write failed"]);
    expect(calls).toEqual(["stillRuns"]);
  });

  it("25/26. restore() is safe to call multiple times in a row — every call re-runs cleanup and lands RESTORED again", () => {
    const manager = new LockdownLifecycleManager();
    let hideCount = 0;
    manager.registerRestoreAction("hideOverlay", () => {
      hideCount += 1;
    });
    manager.activate();

    const first = manager.restore();
    const second = manager.restore();
    const third = manager.restore();

    expect(first).toEqual({ state: "RESTORED", errors: [] });
    expect(second).toEqual({ state: "RESTORED", errors: [] });
    expect(third).toEqual({ state: "RESTORED", errors: [] });
    expect(hideCount).toBe(3);
  });

  it("26. repeated restoration after a genuine crash-recovery scenario (PREPARING -> restore, never having reached ACTIVE) is still safe", () => {
    const manager = new LockdownLifecycleManager();
    manager.prepare();
    const result = manager.restore();
    expect(result.state).toBe("RESTORED");
    expect(manager.restore().state).toBe("RESTORED");
  });

  it("Part 17 — a fault injector forces RESTORE_FAILED even when every real action succeeds", () => {
    let armed = true;
    const manager = new LockdownLifecycleManager(() => {
      if (armed) {
        armed = false;
        return true;
      }
      return false;
    });
    let ran = false;
    manager.registerRestoreAction("realAction", () => {
      ran = true;
    });

    const first = manager.restore();
    expect(first.state).toBe("RESTORE_FAILED");
    expect(ran).toBe(true); // the real action still ran successfully
    expect(first.errors[0]).toContain("fault-injection");

    const second = manager.restore();
    expect(second.state).toBe("RESTORED");
  });

  it("recovers from a RESTORE_FAILED state on a subsequent successful restore", () => {
    const manager = new LockdownLifecycleManager();
    let shouldThrow = true;
    manager.registerRestoreAction("flaky", () => {
      if (shouldThrow) throw new Error("transient failure");
    });

    expect(manager.restore().state).toBe("RESTORE_FAILED");
    shouldThrow = false;
    expect(manager.restore().state).toBe("RESTORED");
  });
});
