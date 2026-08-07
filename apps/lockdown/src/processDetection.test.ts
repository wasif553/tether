import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ProcessDetection imports `electron` directly (BrowserWindow, for its
// blocking overlay) and, transitively via diagnosticLog.ts, `app` —
// mocked here locally, following the exact pattern established in
// remoteSessionMonitor.test.ts. This file exists specifically to close
// the gap that let the pollOnce() `.finally()`-identity bug (fixed in
// this same change) go undetected: there was previously no class-level
// test exercising ProcessDetection's actual timer/poll-loop behaviour
// (only processDetectionLogic.test.ts, covering the pure diff/scan-
// outcome helpers).
vi.mock("electron", () => {
  class FakeBrowserWindow {
    closed = false;
    shown = false;
    constructor() {}
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
  return { BrowserWindow: FakeBrowserWindow, app: { isPackaged: false } };
});

const getWindowsProcessList = vi.fn();
vi.mock("./windowsProcessList", () => ({
  getWindowsProcessList: (...args: unknown[]) => getWindowsProcessList(...args),
}));

import { ProcessDetection } from "./processDetection";

function fakeTargetWindow() {
  return {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  } as unknown as import("electron").BrowserWindow;
}

const NO_PROCESSES = { ok: true as const, parseResult: { ok: true as const, rawNames: [] } };
const TEAMVIEWER_RUNNING = { ok: true as const, parseResult: { ok: true as const, rawNames: ["teamviewer.exe"] } };
const SCAN_UNAVAILABLE = { ok: false as const, reason: "spawn_failed" as const };

beforeEach(() => {
  vi.useFakeTimers();
  getWindowsProcessList.mockReset();
  getWindowsProcessList.mockResolvedValue(NO_PROCESSES);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProcessDetection — poll serialization (the fixed .finally()-identity bug)", () => {
  it("[1] the first poll runs as soon as the exam becomes active", async () => {
    const detection = new ProcessDetection();
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsProcessList).toHaveBeenCalledTimes(1);
  });

  it("[2] a concurrent tick while a scan is in flight is deduplicated, not run again", async () => {
    let resolveScan: (value: typeof NO_PROCESSES) => void = () => {};
    getWindowsProcessList.mockImplementationOnce(
      () => new Promise((resolve) => { resolveScan = resolve; }),
    );
    const detection = new ProcessDetection();
    detection.setExamActive(true); // starts the first, still-pending scan

    // A second call while the first is in flight (e.g. forceRescan()
    // firing mid-scan) must not start a second underlying process list
    // call — it only awaits the one already running.
    const concurrent = (detection as unknown as { pollOnce(): Promise<void> }).pollOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsProcessList).toHaveBeenCalledTimes(1);

    resolveScan(NO_PROCESSES);
    await concurrent;
    expect(getWindowsProcessList).toHaveBeenCalledTimes(1);
  });

  it("[3] a second poll runs after the first resolves (the core regression: scanInFlight must actually clear)", async () => {
    const detection = new ProcessDetection();
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsProcessList).toHaveBeenCalledTimes(1);

    // Default TETHER_PROCESS_SCAN_INTERVAL_SECONDS is 20s.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getWindowsProcessList).toHaveBeenCalledTimes(2);
  });

  it("[4] a second poll runs after the first REJECTS (an unexpected exception, not a normal {ok:false} result)", async () => {
    getWindowsProcessList.mockRejectedValueOnce(new Error("unexpected native failure"));
    const detection = new ProcessDetection();
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsProcessList).toHaveBeenCalledTimes(1);

    getWindowsProcessList.mockResolvedValue(NO_PROCESSES);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getWindowsProcessList).toHaveBeenCalledTimes(2);
  });

  it("[5] multiple scheduled polling cycles continue indefinitely, not just twice", async () => {
    const detection = new ProcessDetection();
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(getWindowsProcessList.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("[6] prohibited software opened only AFTER the initial (clean) scan is still detected on a later poll", async () => {
    const onCapabilityTransition = vi.fn();
    const detection = new ProcessDetection({ onCapabilityTransition });
    detection.attachTargetWindow(fakeTargetWindow());
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0); // clean first scan
    expect(onCapabilityTransition).not.toHaveBeenCalled();

    getWindowsProcessList.mockResolvedValue(TEAMVIEWER_RUNNING);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onCapabilityTransition).toHaveBeenCalledWith("TEAMVIEWER", "BLOCK_DURING_EXAM", "DETECTED");
  });

  it("[7] stop() prevents any subsequent poll", async () => {
    const detection = new ProcessDetection();
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeStop = getWindowsProcessList.mock.calls.length;

    detection.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getWindowsProcessList.mock.calls.length).toBe(callsBeforeStop);
  });

  it("[8] stop() and setExamActive(false) are idempotent — restoration may call either any number of times safely", async () => {
    const detection = new ProcessDetection();
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => {
      detection.stop();
      detection.stop();
      detection.setExamActive(false);
      detection.setExamActive(false);
      detection.stop();
    }).not.toThrow();
  });

  it("[9] a rejected scan never becomes an unhandled promise rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      getWindowsProcessList.mockRejectedValue(new Error("persistent unexpected failure"));
      const detection = new ProcessDetection();
      detection.setExamActive(true);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(20_000);
      // Give any stray unhandledRejection a chance to surface.
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("[6, restated] scanInFlight clearing is never confused by a stale earlier run — a fresh poll after resolution starts its own independent in-flight promise", async () => {
    const detection = new ProcessDetection();
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect((detection as unknown as { scanInFlight: unknown }).scanInFlight).toBeNull();

    let resolveSecond: (value: typeof NO_PROCESSES) => void = () => {};
    getWindowsProcessList.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    await vi.advanceTimersByTimeAsync(20_000);
    // The second scan is now genuinely in flight — scanInFlight must be set.
    expect((detection as unknown as { scanInFlight: unknown }).scanInFlight).not.toBeNull();
    resolveSecond(NO_PROCESSES);
    await vi.advanceTimersByTimeAsync(0);
    expect((detection as unknown as { scanInFlight: unknown }).scanInFlight).toBeNull();
  });
});
