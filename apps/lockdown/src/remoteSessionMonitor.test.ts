import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// RemoteSessionMonitor imports `electron` directly (BrowserWindow, for its
// blocking overlay) and, transitively via diagnosticLog.ts, `app`. Neither
// exists when this file runs under plain Node/vitest (outside the real
// Electron runtime) — mocked here, deliberately locally scoped to this one
// test file, so the class's actual start/stop/poll timer behaviour can be
// exercised directly. This repo's usual convention (see
// windowLifecycleGuard.test.ts's own doc comment) is to avoid needing this
// by keeping logic in a dependency-free module — remoteSessionMonitorLogic.ts
// carries that role for the state-machine/dedup rules; this file only
// covers the timer/lifecycle wiring the pure module cannot exercise on its
// own (Required behaviour tests: "no polling before ACTIVE", "polling
// starts when ACTIVE", "polling stops after submission or restoration",
// "unavailable checks do not crash the app", "window destruction and
// shutdown remain safe").
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

const getWindowsSessionClassification = vi.fn();
vi.mock("./windowsSessionDetection", () => ({
  getWindowsSessionClassification: (...args: unknown[]) => getWindowsSessionClassification(...args),
}));

import { RemoteSessionMonitor } from "./remoteSessionMonitor";
import { DEFAULT_LOCKDOWN_POLICY_TOGGLES } from "./lockdownCapabilityRegistry";

const ACTIVE = { isRemoteSession: true, remoteSessionSignalSource: "BOTH_AGREE", isLikelyVirtualMachine: false, vmSignatureMatched: null };
const INACTIVE = { isRemoteSession: false, remoteSessionSignalSource: "BOTH_AGREE", isLikelyVirtualMachine: false, vmSignatureMatched: null };
const UNAVAILABLE = { isRemoteSession: false, remoteSessionSignalSource: "UNAVAILABLE", isLikelyVirtualMachine: false, vmSignatureMatched: null };

beforeEach(() => {
  vi.useFakeTimers();
  getWindowsSessionClassification.mockReset();
  getWindowsSessionClassification.mockResolvedValue(INACTIVE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteSessionMonitor — polling only runs while the exam is ACTIVE", () => {
  it("never polls before setExamActive(true) is called", async () => {
    new RemoteSessionMonitor();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getWindowsSessionClassification).not.toHaveBeenCalled();
  });

  it("polls immediately when setExamActive(true) is called, then again on the configured interval", async () => {
    const monitor = new RemoteSessionMonitor();
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(getWindowsSessionClassification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getWindowsSessionClassification.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops polling once setExamActive(false) is called (submission complete / exam no longer active)", async () => {
    const monitor = new RemoteSessionMonitor();
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    const callsWhileActive = getWindowsSessionClassification.mock.calls.length;

    monitor.setExamActive(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getWindowsSessionClassification.mock.calls.length).toBe(callsWhileActive);
  });

  it("stops polling once stop() is called (restoration / Tether closing)", async () => {
    const monitor = new RemoteSessionMonitor();
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    const callsWhileActive = getWindowsSessionClassification.mock.calls.length;

    monitor.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getWindowsSessionClassification.mock.calls.length).toBe(callsWhileActive);
  });

  it("stop() and setExamActive(false) are both idempotent — calling either repeatedly never throws", async () => {
    const monitor = new RemoteSessionMonitor();
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => {
      monitor.stop();
      monitor.stop();
      monitor.setExamActive(false);
      monitor.setExamActive(false);
      monitor.stop();
    }).not.toThrow();
  });
});

describe("RemoteSessionMonitor — transitions reach the caller exactly once per change", () => {
  it("reports BECAME_ACTIVE once when the session becomes active, and nothing on repeated identical polls", async () => {
    getWindowsSessionClassification.mockResolvedValue(ACTIVE);
    const onTransition = vi.fn();
    const monitor = new RemoteSessionMonitor({ onTransition });
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    const activeCalls = onTransition.mock.calls.filter(([t]) => t.kind === "BECAME_ACTIVE");
    expect(activeCalls).toHaveLength(1);
  });

  it("reports BECAME_INACTIVE (recovery/clear) exactly once when the session ends, with a non-null detectedAtMsForClear", async () => {
    const onTransition = vi.fn();
    const monitor = new RemoteSessionMonitor({ onTransition });
    getWindowsSessionClassification.mockResolvedValue(ACTIVE);
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);

    getWindowsSessionClassification.mockResolvedValue(INACTIVE);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    const inactiveCalls = onTransition.mock.calls.filter(([t]) => t.kind === "BECAME_INACTIVE");
    expect(inactiveCalls).toHaveLength(1);
    expect(inactiveCalls[0][2]).not.toBeNull();
  });
});

describe("RemoteSessionMonitor — unavailable checks never crash the poll loop", () => {
  it("survives getWindowsSessionClassification rejecting outright", async () => {
    getWindowsSessionClassification.mockRejectedValue(new Error("spawn failed"));
    const onTransition = vi.fn();
    const monitor = new RemoteSessionMonitor({ onTransition });
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTransition).toHaveBeenCalledWith(expect.objectContaining({ kind: "CHECK_UNAVAILABLE" }), expect.any(String), null);
  });

  it("survives an onTransition callback that itself throws (e.g. IPC send racing a destroyed window)", async () => {
    getWindowsSessionClassification.mockResolvedValue(UNAVAILABLE);
    const onTransition = vi.fn(() => {
      throw new Error("window destroyed");
    });
    const monitor = new RemoteSessionMonitor({ onTransition });
    expect(() => monitor.setExamActive(true)).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
  });

  it("records CHECK_RECOVERED exactly once after the check starts succeeding again", async () => {
    getWindowsSessionClassification.mockResolvedValue(UNAVAILABLE);
    const onTransition = vi.fn();
    const monitor = new RemoteSessionMonitor({ onTransition });
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);

    getWindowsSessionClassification.mockResolvedValue(INACTIVE);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    const recoveredCalls = onTransition.mock.calls.filter(([t]) => t.kind === "CHECK_RECOVERED");
    expect(recoveredCalls).toHaveLength(1);
  });
});

describe("RemoteSessionMonitor — never produces a misconduct/automatic-decision outcome", () => {
  it("only ever calls onTransition with a recorded-signal kind, never terminating or submitting anything itself (no such method exists on the class)", async () => {
    getWindowsSessionClassification.mockResolvedValue(ACTIVE);
    const onTransition = vi.fn();
    const monitor = new RemoteSessionMonitor({ onTransition });
    expect((monitor as unknown as Record<string, unknown>).terminateExam).toBeUndefined();
    expect((monitor as unknown as Record<string, unknown>).submitExam).toBeUndefined();
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    for (const [t] of onTransition.mock.calls) {
      expect(["BECAME_ACTIVE", "BECAME_INACTIVE", "CHECK_UNAVAILABLE", "CHECK_RECOVERED"]).toContain(t.kind);
    }
  });
});

describe("RemoteSessionMonitor — policy toggles govern blocking, never detection", () => {
  it("still reports a BECAME_ACTIVE transition even when the policy toggle downgrades the effective action to DETECT_AND_RECORD", async () => {
    getWindowsSessionClassification.mockResolvedValue(ACTIVE);
    const onTransition = vi.fn();
    const monitor = new RemoteSessionMonitor({ onTransition });
    monitor.setPolicyToggles({ ...DEFAULT_LOCKDOWN_POLICY_TOGGLES, blockRemoteControl: false });
    monitor.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);

    const activeCall = onTransition.mock.calls.find(([t]) => t.kind === "BECAME_ACTIVE");
    expect(activeCall).toBeDefined();
    expect(activeCall![1]).toBe("DETECT_AND_RECORD");
  });
});

describe("RemoteSessionMonitor — status snapshot never leaks raw classification detail", () => {
  it("getStatusSnapshot only exposes bounded fields", async () => {
    const monitor = new RemoteSessionMonitor();
    const snapshot = monitor.getStatusSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(["examActive", "lastCheckAvailable", "lastKnownActiveState", "overlayVisible"]);
  });
});
