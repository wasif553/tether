import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DisplayEnforcement imports `electron` directly (screen, BrowserWindow) and,
// transitively via diagnosticLog.ts, `app` — mocked here locally, following
// the exact pattern established in processDetection.test.ts and
// remoteSessionMonitor.test.ts. This file exists specifically to close the
// gap that let the evaluateInFlight `.finally()`-identity bug (fixed in this
// same change) go undetected: there was previously no class-level test
// exercising DisplayEnforcement's actual timer/poll-loop behaviour (only
// displayEnforcementLogic.test.ts, covering the pure decision helpers).
let fakeDisplays: Array<Record<string, unknown>> = [{}];
let fakePrimaryInternal = true;
const screenListeners: Record<string, Array<() => void>> = {};

function setDisplayCount(count: number): void {
  fakeDisplays = Array.from({ length: count }, () => ({}));
}

vi.mock("electron", () => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    closed = false;
    shown = false;
    constructor() {
      FakeBrowserWindow.instances.push(this);
    }
    isDestroyed() {
      return this.closed;
    }
    getBounds() {
      return { x: 0, y: 0, width: 800, height: 600 };
    }
    loadURL() {}
    setAlwaysOnTop() {}
    show() {
      this.shown = true;
    }
    close() {
      this.closed = true;
    }
    on() {}
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    app: { isPackaged: false },
    screen: {
      getAllDisplays: () => fakeDisplays,
      getPrimaryDisplay: () => ({ internal: fakePrimaryInternal }),
      on: (event: string, cb: () => void) => {
        (screenListeners[event] ??= []).push(cb);
      },
      removeListener: (event: string, cb: () => void) => {
        screenListeners[event] = (screenListeners[event] ?? []).filter((l) => l !== cb);
      },
    },
  };
});

const getWindowsDisplayTopology = vi.fn();
vi.mock("./windowsDisplayTopology", () => ({
  getWindowsDisplayTopology: (...args: unknown[]) => getWindowsDisplayTopology(...args),
}));

import { DisplayEnforcement } from "./displayEnforcement";

function fakeTargetWindow() {
  return {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  } as unknown as import("electron").BrowserWindow;
}

const SINGLE_DISPLAY_TOPOLOGY = { ok: true as const, activePathCount: 1, distinctSourceCount: 1 };
const EXTEND_TOPOLOGY = { ok: true as const, activePathCount: 2, distinctSourceCount: 2 };

const ENFORCING_STATE = { active: true, ready: true, requireSingleDisplay: true };

// The module's own periodic recheck cadence (PERIODIC_RECHECK_MS) — not
// exported, so mirrored here as a literal, matching remoteSessionMonitor.
// test.ts's own convention for its (also unexported) default interval.
const PERIODIC_RECHECK_MS = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
  fakeDisplays = [{}];
  fakePrimaryInternal = true;
  getWindowsDisplayTopology.mockReset();
  getWindowsDisplayTopology.mockResolvedValue(SINGLE_DISPLAY_TOPOLOGY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DisplayEnforcement — poll serialization (the fixed .finally()-identity bug)", () => {
  it("[1] the first evaluation runs as soon as start() is called", async () => {
    const enforcement = new DisplayEnforcement();
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsDisplayTopology).toHaveBeenCalledTimes(1);
  });

  it("[2] a concurrent evaluation while one is in flight is deduplicated, not run again", async () => {
    let resolveQuery: (value: typeof SINGLE_DISPLAY_TOPOLOGY) => void = () => {};
    getWindowsDisplayTopology.mockImplementationOnce(
      () => new Promise((resolve) => { resolveQuery = resolve; }),
    );
    const enforcement = new DisplayEnforcement();
    enforcement.start(fakeTargetWindow()); // starts the first, still-pending evaluation

    // A second call while the first is in flight (e.g. the periodic timer
    // firing while a raw event's async check is still resolving) must not
    // start a second underlying topology query — it only awaits the one
    // already running.
    const concurrent = (enforcement as unknown as { evaluate(options: { bypassDebounce: boolean }): Promise<void> }).evaluate({ bypassDebounce: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsDisplayTopology).toHaveBeenCalledTimes(1);

    resolveQuery(SINGLE_DISPLAY_TOPOLOGY);
    await concurrent;
    expect(getWindowsDisplayTopology).toHaveBeenCalledTimes(1);
  });

  it("[3] a second evaluation runs after the first resolves (the core regression: evaluateInFlight must actually clear)", async () => {
    const enforcement = new DisplayEnforcement();
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsDisplayTopology).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(getWindowsDisplayTopology).toHaveBeenCalledTimes(2);
  });

  it("[4] a second evaluation runs after the first REJECTS (an unexpected exception, e.g. a diagnostics callback throwing)", async () => {
    const onDiagnosticsChanged = vi.fn(() => {
      throw new Error("unexpected callback failure");
    });
    const enforcement = new DisplayEnforcement({ onDiagnosticsChanged });
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsDisplayTopology).toHaveBeenCalledTimes(1);

    onDiagnosticsChanged.mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(getWindowsDisplayTopology).toHaveBeenCalledTimes(2);
  });

  it("[5] multiple scheduled evaluation cycles continue indefinitely, not just twice", async () => {
    const enforcement = new DisplayEnforcement();
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    }
    expect(getWindowsDisplayTopology.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("[6] connecting a second display after the initial (clean) evaluation is detected", async () => {
    const onEventType = vi.fn();
    const enforcement = new DisplayEnforcement({ onEventType });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(enforcement.getDiagnosticsSnapshot().overlayVisible).toBe(false);

    setDisplayCount(2);
    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);

    expect(enforcement.getDiagnosticsSnapshot().overlayVisible).toBe(true);
    expect(onEventType).toHaveBeenCalledWith("ADDITIONAL_DISPLAY_PRESENT", 2);
  });

  it("[7] removing the extra display produces the expected recovery transition", async () => {
    const onEventType = vi.fn();
    setDisplayCount(2);
    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    const enforcement = new DisplayEnforcement({ onEventType });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(enforcement.getDiagnosticsSnapshot().overlayVisible).toBe(true);

    setDisplayCount(1);
    getWindowsDisplayTopology.mockResolvedValue(SINGLE_DISPLAY_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);

    expect(enforcement.getDiagnosticsSnapshot().overlayVisible).toBe(false);
    expect(onEventType).toHaveBeenCalledWith("DISPLAY_POLICY_RESTORED", 1);
  });

  it("[8] stop() prevents any subsequent evaluation", async () => {
    const enforcement = new DisplayEnforcement();
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeStop = getWindowsDisplayTopology.mock.calls.length;

    enforcement.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getWindowsDisplayTopology.mock.calls.length).toBe(callsBeforeStop);
  });

  it("[9] stop() is idempotent — restoration may call it any number of times safely", async () => {
    const enforcement = new DisplayEnforcement();
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(() => {
      enforcement.stop();
      enforcement.stop();
      enforcement.stop();
    }).not.toThrow();
  });

  it("[10] a rejected evaluation never becomes an unhandled promise rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const onDiagnosticsChanged = vi.fn(() => {
        throw new Error("persistent unexpected failure");
      });
      const enforcement = new DisplayEnforcement({ onDiagnosticsChanged });
      enforcement.start(fakeTargetWindow());
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
      await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
      // Give any stray unhandledRejection a chance to surface.
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("[11] a stale completion cannot clear a newer in-flight evaluation — evaluateInFlight clearing is never confused by an earlier run", async () => {
    const enforcement = new DisplayEnforcement();
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect((enforcement as unknown as { evaluateInFlight: unknown }).evaluateInFlight).toBeNull();

    let resolveSecond: (value: typeof SINGLE_DISPLAY_TOPOLOGY) => void = () => {};
    getWindowsDisplayTopology.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    // The second evaluation is now genuinely in flight — evaluateInFlight must be set.
    expect((enforcement as unknown as { evaluateInFlight: unknown }).evaluateInFlight).not.toBeNull();
    resolveSecond(SINGLE_DISPLAY_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(0);
    expect((enforcement as unknown as { evaluateInFlight: unknown }).evaluateInFlight).toBeNull();
  });
});
