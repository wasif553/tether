import { describe, it, expect, vi } from "vitest";
import { isWindowUsable, runOnWindowBestEffort, type DestroyableWindowLike } from "./windowLifecycleGuard";

// ---------------------------------------------------------------------------
// Destroyed-window crash fix v1.7.1. main.ts's reportAuditFactBestEffort,
// emitWarning, recordEvent, and every `mainWindow?.webContents.send(...)`
// call site are now all built directly on top of runOnWindowBestEffort /
// isWindowUsable — these tests exercise those exact primitives with fake
// window objects (this repo's convention for main.ts, which imports real
// Electron modules at load time, is to keep testable logic in a
// dependency-free module rather than import main.ts itself; see
// lockdownLifecycle.ts and its own test file for the established pattern).
// ---------------------------------------------------------------------------

function makeWindow(opts: { windowDestroyed?: boolean; webContentsDestroyed?: boolean; noWebContents?: boolean } = {}): DestroyableWindowLike {
  return {
    isDestroyed: () => Boolean(opts.windowDestroyed),
    webContents: opts.noWebContents ? null : { isDestroyed: () => Boolean(opts.webContentsDestroyed) },
  };
}

describe("isWindowUsable", () => {
  it("is false for null/undefined", () => {
    expect(isWindowUsable(null)).toBe(false);
    expect(isWindowUsable(undefined)).toBe(false);
  });

  it("is false when the window itself is destroyed", () => {
    expect(isWindowUsable(makeWindow({ windowDestroyed: true }))).toBe(false);
  });

  it("is false when webContents is destroyed", () => {
    expect(isWindowUsable(makeWindow({ webContentsDestroyed: true }))).toBe(false);
  });

  it("is false when webContents is missing entirely", () => {
    expect(isWindowUsable(makeWindow({ noWebContents: true }))).toBe(false);
  });

  it("is true for a live window with live webContents", () => {
    expect(isWindowUsable(makeWindow())).toBe(true);
  });
});

describe("runOnWindowBestEffort — Part E.1/E.2/E.3: reportAuditFactBestEffort-style call must never throw", () => {
  it("[E.3] safely skips when no window exists (null)", () => {
    const action = vi.fn();
    expect(() => runOnWindowBestEffort(null, action)).not.toThrow();
    expect(action).not.toHaveBeenCalled();
  });

  it("[E.1] does not throw when the BrowserWindow itself is destroyed", () => {
    const window = makeWindow({ windowDestroyed: true });
    const action = vi.fn(() => {
      throw new TypeError("Object has been destroyed");
    });
    expect(() => runOnWindowBestEffort(window, action)).not.toThrow();
    expect(action).not.toHaveBeenCalled();
  });

  it("[E.2] does not throw when webContents is destroyed", () => {
    const window = makeWindow({ webContentsDestroyed: true });
    const action = vi.fn(() => {
      throw new TypeError("Object has been destroyed");
    });
    expect(() => runOnWindowBestEffort(window, action)).not.toThrow();
    expect(action).not.toHaveBeenCalled();
  });

  it("[E.12] successful reporting still runs, with the real window, when both are alive", () => {
    const window = makeWindow();
    const action = vi.fn();
    runOnWindowBestEffort(window, action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(window);
  });

  it("a synchronous throw from a check-then-call race (window usable at check time, action itself throws 'Object has been destroyed') is caught, not propagated", () => {
    const window = makeWindow();
    expect(() =>
      runOnWindowBestEffort(window, () => {
        throw new TypeError("Object has been destroyed");
      }),
    ).not.toThrow();
  });
});

describe("runOnWindowBestEffort — [E.7] a rejected asynchronous operation inside the action must not create an unhandled rejection", () => {
  it("mirrors reportAuditFactToWindow's own executeJavaScript(...).catch(() => {}) shape: a fire-and-forget rejecting promise that IS chained with .catch never surfaces as unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const window = makeWindow();
      runOnWindowBestEffort(window, () => {
        // Same shape as reportAuditFactToWindow: kick off a promise that
        // rejects, but always chain a .catch — this is what makes a
        // *rejected* async audit call safe, as distinct from a
        // *synchronous throw* (covered by isWindowUsable/try-catch above).
        Promise.reject(new Error("network fetch failed")).catch(() => {});
      });
      // Flush microtasks so a genuinely-unhandled rejection would have
      // had the chance to fire before this assertion runs.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
