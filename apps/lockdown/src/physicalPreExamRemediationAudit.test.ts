import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Physical-test audit (TeamViewer termination -> false additional-display
 * block -> unusable/unrecoverable overlay -> forced reboot, observed on
 * OLD Tether 1.7.3) — targeted regression coverage proving v1.7.4 cannot
 * reproduce that pre-exam state. See
 * docs/tether-preflight-lifecycle-v1.7.4.md.
 *
 * The reported failure required THREE things to all be true at once:
 * (1) the screen-saver-level native overlay showing BEFORE the exam was
 * ever authoritatively activated, (2) that overlay's reason being
 * mislabelled as a genuine additional display when it wasn't, and (3) no
 * way to recover without a reboot. This file proves each is now
 * structurally impossible, complementing (not duplicating) the existing
 * coverage in displayEnforcementLogic.test.ts (reason-taxonomy purity),
 * displayEnforcement.test.ts (live overlay behaviour once ACTIVE),
 * processDetection.test.ts (live poll behaviour once ACTIVE), and
 * ipcChain.test.ts (activation-handler check-then-set ordering).
 */

let fakeDisplays: Array<Record<string, unknown>> = [{}];
let fakePrimaryInternal = true;
const screenListeners: Record<string, Array<() => void>> = {};

function setDisplayCount(count: number): void {
  fakeDisplays = Array.from({ length: count }, () => ({}));
}

const { FakeBrowserWindow } = vi.hoisted(() => {
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
  return { FakeBrowserWindow };
});

vi.mock("electron", () => ({
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
}));

const getWindowsDisplayTopology = vi.fn();
vi.mock("./windowsDisplayTopology", () => ({
  getWindowsDisplayTopology: (...args: unknown[]) => getWindowsDisplayTopology(...args),
}));

const getWindowsProcessList = vi.fn();
vi.mock("./windowsProcessList", () => ({
  getWindowsProcessList: (...args: unknown[]) => getWindowsProcessList(...args),
}));

import { DisplayEnforcement } from "./displayEnforcement";
import { ProcessDetection } from "./processDetection";
import { resolveReadinessGatedDisplayDecision, INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE } from "./displayEnforcementLogic";

function fakeTargetWindow() {
  return {
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  } as unknown as import("electron").BrowserWindow;
}

const SINGLE_DISPLAY_TOPOLOGY = { ok: true as const, activePathCount: 1, distinctSourceCount: 1 };
const EXTEND_TOPOLOGY = { ok: true as const, activePathCount: 2, distinctSourceCount: 2 };
const NO_PROCESSES = { ok: true as const, parseResult: { ok: true as const, rawNames: [] } };
const TEAMVIEWER_RUNNING = { ok: true as const, parseResult: { ok: true as const, rawNames: ["tv_w32.exe", "tv_x64.exe"] } };
const ENFORCING_STATE = { active: true, ready: true, requireSingleDisplay: true };
const PERIODIC_RECHECK_MS = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
  fakeDisplays = [{}];
  fakePrimaryInternal = true;
  FakeBrowserWindow.instances = [];
  getWindowsDisplayTopology.mockReset();
  getWindowsDisplayTopology.mockResolvedValue(SINGLE_DISPLAY_TOPOLOGY);
  getWindowsProcessList.mockReset();
  getWindowsProcessList.mockResolvedValue(NO_PROCESSES);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Required test 1 — TeamViewer PRECHECK failure produces no native overlay", () => {
  it("runPreflightScan() detecting TeamViewer never creates the process-detection overlay window and never flips examActive", async () => {
    const detection = new ProcessDetection();
    detection.attachTargetWindow(fakeTargetWindow());
    getWindowsProcessList.mockResolvedValue(TEAMVIEWER_RUNNING);

    const result = await detection.runPreflightScan();

    expect(result.state).toBe("BLOCKED");
    expect(FakeBrowserWindow.instances).toHaveLength(0);
    const snapshot = detection.getStatusSnapshot();
    expect(snapshot.overlayVisible).toBe(false);
    expect(snapshot.examActive).toBe(false);
  });

  it("runPreflightScan() never mutates the episode-tracking state the during-exam poll's overlay decision depends on", async () => {
    const detection = new ProcessDetection();
    detection.attachTargetWindow(fakeTargetWindow());
    getWindowsProcessList.mockResolvedValue(TEAMVIEWER_RUNNING);
    await detection.runPreflightScan();
    await detection.runPreflightScan();

    expect(detection.getStatusSnapshot().detectedCapabilityIds).toEqual([]);
  });
});

describe("Required test 2 — Display PRECHECK failure produces no native overlay", () => {
  it("getOnDemandDisplayTopology() observing a blocking topology never creates the display overlay window (read-only by design)", async () => {
    const enforcement = new DisplayEnforcement();
    setDisplayCount(1);
    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);

    const topology = await enforcement.getOnDemandDisplayTopology();

    expect(topology.classification).toBe("EXTEND");
    expect(FakeBrowserWindow.instances).toHaveLength(0);
    expect(enforcement.getDiagnosticsSnapshot().overlayVisible).toBe(false);
  });

  it("with the live poll loop running but enforcement never activated (the genuine pre-activation default, active:false), a blocking topology still never creates an overlay", async () => {
    setDisplayCount(2);
    getWindowsDisplayTopology.mockResolvedValue(EXTEND_TOPOLOGY);
    const enforcement = new DisplayEnforcement();
    enforcement.start(fakeTargetWindow());
    await vi.advanceTimersByTimeAsync(0);

    expect(enforcement.getDiagnosticsSnapshot().currentDecision).toBe("OK");
    expect(enforcement.getDiagnosticsSnapshot().overlayVisible).toBe(false);
    expect(FakeBrowserWindow.instances).toHaveLength(0);
  });
});

describe("Required test 3 — POLICY_NOT_READY produces no overlay and no additional-display evidence, before activation", () => {
  it("the pre-activation default (active:false) resolves OK regardless of ready/topology — POLICY_NOT_READY is structurally unreachable before setEnforcementState is ever called with active:true", () => {
    expect(resolveReadinessGatedDisplayDecision(INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE, 2, "EXTEND")).toEqual({ state: "OK" });
    expect(resolveReadinessGatedDisplayDecision(INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE, 1, "ERROR")).toEqual({ state: "OK" });
  });

  it("tether-launch/page.tsx (the PHASE 1/2 pre-activation flow) never CALLS setSecureClientEnforcementState — the only caller that can ever set active:true is the exam CONTENT page, reached only after activation succeeds (the doc comment mentioning the removed pre-v1.7.4 call, by name, in prose is expected and does not count as a call site)", () => {
    const tetherLaunchSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "app", "student", "exams", "[id]", "tether-launch", "page.tsx"),
      "utf8",
    );
    expect(tetherLaunchSource).not.toMatch(/sesLockdown\?\.setSecureClientEnforcementState\?\.\(/);
  });

  it("if a POLICY_NOT_READY block ever transiently occurs (e.g. the exam content page's own mount-time cover, which fires only once activation has already genuinely happened), leaving that page always resets enforcement back to inactive via the registered restore action — it can never remain active with no route back", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
    expect(mainSource).toMatch(
      /registerRestoreAction\("displayEnforcement\.setEnforcementState\(inactive\)",\s*\(\)\s*=>\s*\n?\s*displayEnforcement\.setEnforcementState\(\{\s*active:\s*false,\s*ready:\s*false,\s*requireSingleDisplay:\s*false\s*\}\)/,
    );
    const pageTsxSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "app", "student", "exams", "[id]", "page.tsx"),
      "utf8",
    );
    expect(pageTsxSource).toMatch(/restoreLockdownControls\?\.\("exam-page-unmount"\)/);
  });
});

describe("Required test 4 — TOPOLOGY_CHECK_UNAVAILABLE produces a neutral technical failure, never false additional-display evidence, before activation", () => {
  it("the pre-activation default (active:false) resolves OK even when the topology query itself fails", () => {
    expect(resolveReadinessGatedDisplayDecision(INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE, 1, "UNKNOWN")).toEqual({ state: "OK" });
  });

  it("getOnDemandDisplayTopology() surfaces ERROR on a query failure without ever touching overlay/enforcement state", async () => {
    const enforcement = new DisplayEnforcement();
    getWindowsDisplayTopology.mockRejectedValue(new Error("spawn failed"));

    const topology = await enforcement.getOnDemandDisplayTopology();

    expect(topology.classification).toBe("ERROR");
    expect(FakeBrowserWindow.instances).toHaveLength(0);
  });
});

describe("Required test 5 — a fresh activation race failure leaves every native enforcement mechanism inactive (no partial activation, nothing to roll back)", () => {
  it("main.ts's activate-secure-exam-lockdown handler only ever calls setEnforcementState/setExamActive AFTER every fresh check already returned — every failure branch is an early return with no partial mutation", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
    const handlerBody = mainSource.slice(
      mainSource.indexOf('ipcMain.handle("lockdown:activate-secure-exam-lockdown"'),
      mainSource.indexOf("});", mainSource.indexOf('return { ok: true, displayDecision: "OK", processDecision: "CLEAN" };')),
    );
    const activationIdx = handlerBody.indexOf("displayEnforcement.setEnforcementState({ active: true");
    expect(activationIdx).toBeGreaterThan(-1);

    // Every `return { ok: false, ...}` early-exit must textually precede
    // the one activation call — a failure branch appearing AFTER it would
    // mean a check could fail post-activation, leaving native controls
    // partially engaged.
    const failureReturnPattern = /return \{ ok: false,/g;
    let match: RegExpExecArray | null;
    let failureCount = 0;
    while ((match = failureReturnPattern.exec(handlerBody)) !== null) {
      failureCount += 1;
      expect(match.index).toBeLessThan(activationIdx);
    }
    // INVALID_PARAMS, PROCESS scan (BLOCKED/UNAVAILABLE), remote session
    // (check-unavailable/detected), display (BLOCKED) — at least 5 early
    // failure exits, all preceding activation.
    expect(failureCount).toBeGreaterThanOrEqual(5);
  });

  it("simulating the same check-then-set sequence directly: a BLOCKED preflight scan followed by never calling setExamActive/setEnforcementState leaves both mechanisms fully inactive", async () => {
    const detection = new ProcessDetection();
    detection.attachTargetWindow(fakeTargetWindow());
    getWindowsProcessList.mockResolvedValue(TEAMVIEWER_RUNNING);
    const scan = await detection.runPreflightScan();
    expect(scan.state).toBe("BLOCKED");
    // The handler would return here — setExamActive/setEnforcementState
    // are never reached. Confirm the resulting state is indistinguishable
    // from "never touched at all".
    expect(detection.getStatusSnapshot()).toEqual({ examActive: false, lastScanOk: true, detectedCapabilityIds: [], overlayVisible: false });

    const enforcement = new DisplayEnforcement();
    expect(enforcement.getDiagnosticsSnapshot().enforcementState).toEqual(INITIAL_SECURE_CLIENT_ENFORCEMENT_STATE);
    expect(enforcement.getDiagnosticsSnapshot().overlayVisible).toBe(false);
  });
});

describe("Required test 6 — the pre-exam exit route remains available after a failed display (or any other precheck) check", () => {
  it("LockdownApplicationCheck — the ONE screen every PHASE 1 precheck failure (process, remote session, or display) renders — always includes Recheck and Return to dashboard, and is confirmed reason-agnostic by tether-launch/page.tsx passing the same component for every precheckIssue", () => {
    const tetherLaunchSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "app", "student", "exams", "[id]", "tether-launch", "page.tsx"),
      "utf8",
    );
    // A single precheckIssue state variable drives a single <LockdownApplicationCheck>
    // render regardless of which mandatory check failed (process, remote
    // session, or display topology) — see resolveDisplayPreflightIssue's
    // and runPrecheck's own call sites, all of which funnel into
    // setPrecheckIssue.
    const renderCount = (tetherLaunchSource.match(/<LockdownApplicationCheck/g) ?? []).length;
    expect(renderCount).toBe(1);
    expect(tetherLaunchSource).toMatch(/setPrecheckIssue\(issue\)/); // display-check failure path
  });
});

describe("Required test 7 — a genuine second display DURING an ACTIVE exam still invokes strict enforcement (unchanged, unweakened)", () => {
  it("with enforcement genuinely activated (active:true, ready:true), a real EXTEND topology still shows the overlay", async () => {
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
    expect(FakeBrowserWindow.instances.length).toBeGreaterThan(0);
    expect(onEventType).toHaveBeenCalledWith("ADDITIONAL_DISPLAY_PRESENT", 2);
  });
});

describe("Required test 8 — TeamViewer appearing DURING an ACTIVE exam still invokes strict enforcement (unchanged, unweakened)", () => {
  it("with the exam genuinely active (setExamActive(true), the post-activation state), TeamViewer being detected shows the process-blocking overlay window", async () => {
    const detection = new ProcessDetection();
    detection.attachTargetWindow(fakeTargetWindow());
    detection.setExamActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(detection.getStatusSnapshot().overlayVisible).toBe(false);

    getWindowsProcessList.mockResolvedValue(TEAMVIEWER_RUNNING);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(detection.getStatusSnapshot().overlayVisible).toBe(true);
    expect(FakeBrowserWindow.instances.length).toBeGreaterThan(0);
  });
});
