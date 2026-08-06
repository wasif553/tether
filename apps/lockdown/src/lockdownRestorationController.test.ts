import { describe, it, expect, vi } from "vitest";
import { performLockdownRestoration, type RestorationController } from "./lockdownRestorationController";
import { LockdownLifecycleManager } from "./lockdownLifecycle";
import type { DestroyableWindowLike } from "./windowLifecycleGuard";

// ---------------------------------------------------------------------------
// Destroyed-window crash fix v1.7.1. main.ts's restoreLockdownControls is
// now a thin wrapper around performLockdownRestoration
// (lockdownRestorationController.ts) — these tests exercise the real
// orchestration logic directly, without an Electron runtime, following
// this repo's established pattern of keeping restoration/lifecycle logic
// Electron-decoupled (see lockdownLifecycle.ts + lockdownLifecycle.test.ts).
// ---------------------------------------------------------------------------

function makeWindow(opts: { windowDestroyed?: boolean; webContentsDestroyed?: boolean } = {}): DestroyableWindowLike {
  return {
    isDestroyed: () => Boolean(opts.windowDestroyed),
    webContents: { isDestroyed: () => Boolean(opts.webContentsDestroyed) },
  };
}

function makeController(
  window: DestroyableWindowLike | null,
  overrides: Partial<RestorationController<DestroyableWindowLike>> = {},
): RestorationController<DestroyableWindowLike> & {
  reportAuditFact: ReturnType<typeof vi.fn>;
  sendResult: ReturnType<typeof vi.fn>;
} {
  return {
    getWindow: () => window,
    reportAuditFact: vi.fn(),
    sendResult: vi.fn(),
    ...overrides,
  } as RestorationController<DestroyableWindowLike> & { reportAuditFact: ReturnType<typeof vi.fn>; sendResult: ReturnType<typeof vi.fn> };
}

describe("[E.4] performLockdownRestoration restores all critical controls when no window exists", () => {
  it("runs every registered lifecycle restore action even with a null window", () => {
    const lifecycle = new LockdownLifecycleManager();
    const restored: string[] = [];
    lifecycle.registerRestoreAction("processDetection.setExamActive(false)", () => restored.push("processDetection"));
    lifecycle.registerRestoreAction("displayEnforcement.setEnforcementState(inactive)", () => restored.push("displayEnforcement"));
    lifecycle.activate();

    const controller = makeController(null);
    const outcome = performLockdownRestoration(lifecycle, controller, "window-closed");

    expect(restored).toEqual(["processDetection", "displayEnforcement"]);
    expect(outcome.state).toBe("RESTORED");
    expect(controller.reportAuditFact).not.toHaveBeenCalled();
    expect(controller.sendResult).not.toHaveBeenCalled();
  });
});

describe("[E.5] performLockdownRestoration restores all critical controls when the window is already destroyed", () => {
  it("runs every registered lifecycle restore action with a destroyed window reference", () => {
    const lifecycle = new LockdownLifecycleManager();
    const restored: string[] = [];
    lifecycle.registerRestoreAction("processDetection.setExamActive(false)", () => restored.push("processDetection"));
    lifecycle.activate();

    const controller = makeController(makeWindow({ windowDestroyed: true }));
    const outcome = performLockdownRestoration(lifecycle, controller, "render-process-gone:crashed");

    expect(restored).toEqual(["processDetection"]);
    expect(outcome.state).toBe("RESTORED");
    expect(controller.reportAuditFact).not.toHaveBeenCalled();
    expect(controller.sendResult).not.toHaveBeenCalled();
  });

  it("also restores when the window is alive but its webContents is destroyed", () => {
    const lifecycle = new LockdownLifecycleManager();
    const restored: string[] = [];
    lifecycle.registerRestoreAction("displayEnforcement.setEnforcementState(inactive)", () => restored.push("displayEnforcement"));
    lifecycle.activate();

    const controller = makeController(makeWindow({ webContentsDestroyed: true }));
    performLockdownRestoration(lifecycle, controller, "before-quit");

    expect(restored).toEqual(["displayEnforcement"]);
    expect(controller.reportAuditFact).not.toHaveBeenCalled();
  });
});

describe("[E.6] an audit-reporting exception does not stop critical restoration", () => {
  it("still runs lifecycle.restore() and returns a RESTORED outcome even when reportAuditFact throws", () => {
    const lifecycle = new LockdownLifecycleManager();
    const restored: string[] = [];
    lifecycle.registerRestoreAction("processDetection.setExamActive(false)", () => restored.push("processDetection"));
    lifecycle.activate();

    const controller = makeController(makeWindow(), {
      reportAuditFact: vi.fn(() => {
        throw new TypeError("Object has been destroyed");
      }),
    });

    let outcome;
    expect(() => {
      outcome = performLockdownRestoration(lifecycle, controller, "window-closed");
    }).not.toThrow();

    expect(restored).toEqual(["processDetection"]);
    expect(outcome).toEqual({ trigger: "window-closed", state: "RESTORED", errors: [] });
  });

  it("also does not stop restoration when sendResult throws", () => {
    const lifecycle = new LockdownLifecycleManager();
    lifecycle.activate();
    const controller = makeController(makeWindow(), {
      sendResult: vi.fn(() => {
        throw new Error("send failed");
      }),
    });

    expect(() => performLockdownRestoration(lifecycle, controller, "window-closed")).not.toThrow();
  });
});

describe("critical restoration is never wrapped in a broad catch (contract point C.7)", () => {
  it("a throwing lifecycle.restore() itself is NOT swallowed by performLockdownRestoration", () => {
    const lifecycle = {
      getState: () => "ACTIVE" as const,
      restore: vi.fn(() => {
        throw new Error("genuine OS-restoration bug");
      }),
    };
    const controller = makeController(makeWindow());
    expect(() => performLockdownRestoration(lifecycle, controller, "window-closed")).toThrow("genuine OS-restoration bug");
  });
});

describe("[E.8] close and closed lifecycle callbacks may both run without crashing", () => {
  it("simulates render-process-gone followed by closed, both calling performLockdownRestoration with a destroyed window", () => {
    const lifecycle = new LockdownLifecycleManager();
    let restoreCount = 0;
    lifecycle.registerRestoreAction("teardown", () => restoreCount++);
    lifecycle.activate();

    const controller = makeController(makeWindow({ windowDestroyed: true }));

    expect(() => performLockdownRestoration(lifecycle, controller, "render-process-gone:killed")).not.toThrow();
    expect(() => performLockdownRestoration(lifecycle, controller, "window-closed")).not.toThrow();

    expect(restoreCount).toBe(2);
  });
});

describe("[E.9] repeated restoration calls remain idempotent", () => {
  it("running performLockdownRestoration three times keeps re-running every action safely and stays RESTORED", () => {
    const lifecycle = new LockdownLifecycleManager();
    let count = 0;
    lifecycle.registerRestoreAction("idempotentTeardown", () => count++);
    lifecycle.activate();

    const controller = makeController(null);
    for (const trigger of ["window-closed", "before-quit", "before-quit"]) {
      const outcome = performLockdownRestoration(lifecycle, controller, trigger);
      expect(outcome.state).toBe("RESTORED");
      expect(outcome.errors).toEqual([]);
    }
    expect(count).toBe(3);
  });
});

describe("[E.10] cleanup after render-process-gone or failed launch does not access destroyed objects", () => {
  it("never calls reportAuditFact or sendResult against a destroyed window, across multiple triggers", () => {
    const lifecycle = new LockdownLifecycleManager();
    lifecycle.activate();
    const controller = makeController(makeWindow({ windowDestroyed: true }));

    performLockdownRestoration(lifecycle, controller, "render-process-gone:crashed");
    performLockdownRestoration(lifecycle, controller, "window-closed");

    expect(controller.reportAuditFact).not.toHaveBeenCalled();
    expect(controller.sendResult).not.toHaveBeenCalled();
  });
});

describe("[E.11] the main-process lifecycle sequence does not emit an uncaught exception", () => {
  it("running a realistic destroyed-window + throwing-reporter sequence never fires process 'uncaughtException'", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      const lifecycle = new LockdownLifecycleManager();
      lifecycle.registerRestoreAction("processDetection.setExamActive(false)", () => {});
      lifecycle.activate();

      const controller = makeController(makeWindow({ windowDestroyed: true }), {
        reportAuditFact: vi.fn(() => {
          throw new TypeError("Object has been destroyed");
        }),
      });

      performLockdownRestoration(lifecycle, controller, "render-process-gone:killed");
      performLockdownRestoration(lifecycle, controller, "window-closed");
      performLockdownRestoration(lifecycle, controller, "before-quit");

      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

describe("[E.12] successful reporting still works when BrowserWindow and webContents are alive", () => {
  it("reports STARTED then COMPLETED and sends the restoration result to a live window", () => {
    const lifecycle = new LockdownLifecycleManager();
    lifecycle.activate();
    const window = makeWindow();
    const controller = makeController(window);

    const outcome = performLockdownRestoration(lifecycle, controller, "window-closed");

    expect(controller.reportAuditFact).toHaveBeenNthCalledWith(1, window, "TETHER_LOCKDOWN_RESTORATION_STARTED", { trigger: "window-closed" });
    expect(controller.reportAuditFact).toHaveBeenNthCalledWith(2, window, "TETHER_LOCKDOWN_RESTORATION_COMPLETED", {
      trigger: "window-closed",
      errorCount: 0,
    });
    expect(controller.sendResult).toHaveBeenCalledWith(window, outcome);
  });
});
