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
import { BrowserWindow as MockedBrowserWindow } from "electron";

// v1.7.6 — the mocked "electron" module's BrowserWindow IS the
// FakeBrowserWindow class defined inside the vi.mock factory above (that
// class itself isn't a named export of this file, so it's accessed
// through the mocked import instead). Used only by the Part 7
// display-recovery tests below to prove no second native overlay
// BrowserWindow is ever constructed.
const FakeBrowserWindow = MockedBrowserWindow as unknown as { instances: unknown[] };

function fakeTargetWindow() {
  return {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  } as unknown as import("electron").BrowserWindow;
}

const SINGLE_DISPLAY_TOPOLOGY = { ok: true as const, activePathCount: 1, distinctSourceCount: 1 };
const EXTEND_TOPOLOGY = { ok: true as const, activePathCount: 2, distinctSourceCount: 2 };
const CLONE_TOPOLOGY = { ok: true as const, activePathCount: 2, distinctSourceCount: 1 };
const UNAVAILABLE_TOPOLOGY = { ok: false as const, reason: "timeout" as const };

const ENFORCING_STATE = { active: true, ready: true, requireSingleDisplay: true };

// The module's own periodic recheck cadence (PERIODIC_RECHECK_MS) — not
// exported, so mirrored here as a literal, matching remoteSessionMonitor.
// test.ts's own convention for its (also unexported) default interval.
const PERIODIC_RECHECK_MS = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
  fakeDisplays = [{}];
  fakePrimaryInternal = true;
  FakeBrowserWindow.instances = [];
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

// v1.7.5 P0 — physical-test failure: an exam-content-page mount effect
// re-asserted {active:true, ready:false} on top of an already
// ACTIVE+READY state, producing POLICY_NOT_READY, which then showed the
// screen-saver-level, non-closable native overlay with no Recheck/Exit
// route. These tests prove the overlay itself is now structurally
// unreachable for this one reason, regardless of what caused the
// readiness gate to reopen.
describe("DisplayEnforcement — v1.7.5 P0: POLICY_NOT_READY never shows the native overlay", () => {
  it("REQUIRED TEST E: active&&!ready (POLICY_NOT_READY) is still BLOCKED for diagnostics purposes, but overlayVisible stays false", async () => {
    const enforcement = new DisplayEnforcement();
    enforcement.setEnforcementState({ active: true, ready: false, requireSingleDisplay: false });
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = enforcement.getDiagnosticsSnapshot();
    expect(snapshot.currentDecision).toBe("BLOCKED");
    expect(snapshot.blockingReason).toBe("POLICY_NOT_READY");
    expect(snapshot.overlayVisible).toBe(false);
  });

  it("REQUIRED TEST A: a genuine ACTIVE+READY state that later drops to ready:false (the exact downgrade the old mount-time cover used to cause) never shows the overlay either — it simply hides any overlay that happened to be showing", async () => {
    const enforcement = new DisplayEnforcement();
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(enforcement.getDiagnosticsSnapshot().overlayVisible).toBe(false);

    // Simulate the bug scenario directly: something re-asserts
    // {active:true, ready:false} on top of an already-active state.
    enforcement.setEnforcementState({ active: true, ready: false, requireSingleDisplay: false });
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = enforcement.getDiagnosticsSnapshot();
    expect(snapshot.blockingReason).toBe("POLICY_NOT_READY");
    expect(snapshot.overlayVisible).toBe(false);
  });

  it("a genuine EXTEND topology still shows the overlay while active&&ready — POLICY_NOT_READY suppression never weakens real display enforcement", async () => {
    setDisplayCount(2);
    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    const enforcement = new DisplayEnforcement();
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = enforcement.getDiagnosticsSnapshot();
    expect(snapshot.blockingReason).toBe("ADDITIONAL_ELECTRON_DISPLAY");
    expect(snapshot.overlayVisible).toBe(true);
  });

  it("TOPOLOGY_CHECK_UNAVAILABLE during an active exam still shows the overlay, unchanged — only POLICY_NOT_READY is suppressed", async () => {
    getWindowsDisplayTopology.mockResolvedValue({ ok: false as const, reason: "timeout" as const });
    const enforcement = new DisplayEnforcement();
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = enforcement.getDiagnosticsSnapshot();
    expect(snapshot.blockingReason).toBe("TOPOLOGY_CHECK_UNAVAILABLE");
    expect(snapshot.overlayVisible).toBe(true);
  });
});

// v1.7.6 — Native Display State Bridge, display-recovery safety. Physical
// HDMI-disconnect testing isolated an unrecoverable-screen symptom
// (requiring a full OS restart) to the OLD screen-saver-level overlay
// BrowserWindow's recovery path — the precise Windows window/compositor
// failure mechanism was never independently established, only that
// removing the overlay entirely removes the symptom. Detection itself
// was confirmed correct throughout. These tests exercise repeated
// transition cycles
// against the NEW bridge and prove: no second native overlay
// BrowserWindow is ever constructed (FakeBrowserWindow.instances stays
// empty throughout every scenario below — contrast with
// processDetection.test.ts/remoteSessionMonitor.test.ts, whose own
// overlays are deliberately untouched by this change); a clear
// transition always reaches the renderer via onDisplayStateChanged;
// repeated/duplicate OS events are idempotent and never produce duplicate
// UI state; and restoration never requires restarting Tether.
describe("DisplayEnforcement — v1.7.6 Native Display State Bridge: display-recovery safety (Part 7)", () => {
  it("cycle: OK -> EXTEND BLOCKED -> OK, via genuine Windows-topology evidence alone (Electron displayCount stays 1 throughout — the classic Duplicate/Clone-mode case Electron alone cannot see)", async () => {
    const onDisplayStateChanged = vi.fn();
    const enforcement = new DisplayEnforcement({ onDisplayStateChanged });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "OK", reason: null, displayCount: 1 });

    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_EXTEND", displayCount: 1 });

    getWindowsDisplayTopology.mockResolvedValue(SINGLE_DISPLAY_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "OK", reason: null, displayCount: 1 });

    expect(onDisplayStateChanged.mock.calls.map((c) => c[0])).toEqual([
      { state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_EXTEND", displayCount: 1 },
      { state: "OK", reason: null, displayCount: 1 },
    ]);
    expect(FakeBrowserWindow.instances).toEqual([]);
  });

  it("cycle: OK -> CLONE BLOCKED -> OK", async () => {
    const onDisplayStateChanged = vi.fn();
    const enforcement = new DisplayEnforcement({ onDisplayStateChanged });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(enforcement.getDisplayEnforcementStatus().state).toBe("OK");

    getWindowsDisplayTopology.mockResolvedValue(CLONE_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_CLONE", displayCount: 1 });

    getWindowsDisplayTopology.mockResolvedValue(SINGLE_DISPLAY_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "OK", reason: null, displayCount: 1 });
    expect(FakeBrowserWindow.instances).toEqual([]);
  });

  it("cycle: OK -> additional Electron display BLOCKED -> OK", async () => {
    const onDisplayStateChanged = vi.fn();
    const enforcement = new DisplayEnforcement({ onDisplayStateChanged });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(enforcement.getDisplayEnforcementStatus().state).toBe("OK");

    setDisplayCount(2);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "BLOCKED", reason: "ADDITIONAL_ELECTRON_DISPLAY", displayCount: 2 });

    setDisplayCount(1);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "OK", reason: null, displayCount: 1 });
    expect(FakeBrowserWindow.instances).toEqual([]);
  });

  it("cycle: TOPOLOGY_CHECK_UNAVAILABLE -> OK", async () => {
    const onDisplayStateChanged = vi.fn();
    getWindowsDisplayTopology.mockResolvedValue(UNAVAILABLE_TOPOLOGY);
    const enforcement = new DisplayEnforcement({ onDisplayStateChanged });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "BLOCKED", reason: "TOPOLOGY_CHECK_UNAVAILABLE", displayCount: 1 });

    getWindowsDisplayTopology.mockResolvedValue(SINGLE_DISPLAY_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "OK", reason: null, displayCount: 1 });
    expect(FakeBrowserWindow.instances).toEqual([]);
  });

  it("cycle: BLOCKED reason A (EXTEND) -> BLOCKED reason B (CLONE) -> OK — a mid-block reason change is still reported as a real transition, never suppressed by the dedup", async () => {
    const onDisplayStateChanged = vi.fn();
    const enforcement = new DisplayEnforcement({ onDisplayStateChanged });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);

    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus().reason).toBe("WINDOWS_TOPOLOGY_EXTEND");

    getWindowsDisplayTopology.mockResolvedValue(CLONE_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus().reason).toBe("WINDOWS_TOPOLOGY_CLONE");

    getWindowsDisplayTopology.mockResolvedValue(SINGLE_DISPLAY_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "OK", reason: null, displayCount: 1 });

    expect(onDisplayStateChanged.mock.calls.map((c) => c[0])).toEqual([
      { state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_EXTEND", displayCount: 1 },
      { state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_CLONE", displayCount: 1 },
      { state: "OK", reason: null, displayCount: 1 },
    ]);
    expect(FakeBrowserWindow.instances).toEqual([]);
  });

  it("repeated/duplicate OS display events resolving to the SAME decision are idempotent — onDisplayStateChanged fires exactly once per real transition, never once per poll tick", async () => {
    const onDisplayStateChanged = vi.fn();
    const enforcement = new DisplayEnforcement({ onDisplayStateChanged });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);

    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    // Several duplicate raw screen events plus several periodic recheck
    // ticks, all resolving to the identical still-BLOCKED/EXTEND status.
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    for (const cb of screenListeners["display-metrics-changed"] ?? []) cb();
    for (const cb of screenListeners["display-metrics-changed"] ?? []) cb();
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);

    expect(onDisplayStateChanged).toHaveBeenCalledTimes(1);
    expect(onDisplayStateChanged).toHaveBeenCalledWith({ state: "BLOCKED", reason: "WINDOWS_TOPOLOGY_EXTEND", displayCount: 1 });
    expect(FakeBrowserWindow.instances).toEqual([]);
  });

  it("getDisplayEnforcementStatus() (the read-only initial query) always matches the last onDisplayStateChanged push — a fresh renderer mount/reload can never miss an already-active violation", async () => {
    const onDisplayStateChanged = vi.fn();
    const enforcement = new DisplayEnforcement({ onDisplayStateChanged });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);

    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    await vi.advanceTimersByTimeAsync(PERIODIC_RECHECK_MS);

    expect(enforcement.getDisplayEnforcementStatus()).toEqual(onDisplayStateChanged.mock.calls.at(-1)?.[0]);
  });

  it("restoration never requires restarting Tether — setEnforcementState(inactive), the actual restoration action registered in main.ts's lockdownLifecycle, clears the violation without calling stop()/start() again", async () => {
    const onDisplayStateChanged = vi.fn();
    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    const enforcement = new DisplayEnforcement({ onDisplayStateChanged });
    enforcement.setEnforcementState(ENFORCING_STATE);
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);
    expect(enforcement.getDisplayEnforcementStatus().state).toBe("BLOCKED");

    // The exact restoration call site — see main.ts's
    // lockdownLifecycle.registerRestoreAction("displayEnforcement.setEnforcementState(inactive)", ...).
    // Never calls stop()/start() again.
    enforcement.setEnforcementState({ active: false, ready: false, requireSingleDisplay: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(enforcement.getDisplayEnforcementStatus()).toEqual({ state: "OK", reason: null, displayCount: 1 });
    expect(FakeBrowserWindow.instances).toEqual([]);
  });
});
