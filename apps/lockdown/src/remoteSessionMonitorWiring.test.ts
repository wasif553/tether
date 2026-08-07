import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Mid-exam remote-session monitoring v1 — structural IPC/wiring proof,
 * mirroring ipcChain.test.ts's own established convention (reading real
 * source files rather than mocking Electron — see that file's own doc
 * comment). Covers the lifecycle-wiring test categories that
 * remoteSessionMonitor.test.ts's mocked-electron unit tests cannot prove
 * on their own: that main.ts actually threads setExamActive/stop into
 * the SAME activation/restoration/window-close signals ProcessDetection
 * already uses (Required behaviour #1 "ACTIVE exam lifecycle only" and
 * #9 "stop polling on every listed trigger"), and that preload.ts/
 * page.tsx complete the chain end to end.
 */

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const mainSource = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
const preloadSource = fs.readFileSync(path.join(__dirname, "preload.ts"), "utf8");
const pageTsxSource = fs.readFileSync(path.join(REPO_ROOT, "src", "app", "student", "exams", "[id]", "page.tsx"), "utf8");
const lockdownClientSource = fs.readFileSync(path.join(REPO_ROOT, "src", "lib", "lockdownClient.ts"), "utf8");

describe("remoteSessionMonitor instantiation and window attachment", () => {
  it("main.ts instantiates RemoteSessionMonitor and attaches it to the same target window as ProcessDetection", () => {
    expect(mainSource).toMatch(/const remoteSessionMonitor = new RemoteSessionMonitor\(/);
    expect(mainSource).toMatch(/remoteSessionMonitor\.attachTargetWindow\(mainWindow\)/);
  });
});

describe("required behaviour #1/#9 — starts only on ACTIVE, stops on every listed trigger", () => {
  it("the SAME lockdown:set-lockdown-exam-active handler that drives ProcessDetection also drives RemoteSessionMonitor", () => {
    const handlerStart = mainSource.indexOf('ipcMain.on("lockdown:set-lockdown-exam-active"');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBody = mainSource.slice(handlerStart, handlerStart + 400);
    expect(handlerBody).toMatch(/processDetection\.setExamActive\(active\)/);
    expect(handlerBody).toMatch(/remoteSessionMonitor\.setExamActive\(active\)/);
  });

  it("restoration (Tether closing / crash / lockdownLifecycle.restore()) stops the monitor via registerRestoreAction, exactly like ProcessDetection", () => {
    expect(mainSource).toMatch(
      /lockdownLifecycle\.registerRestoreAction\("remoteSessionMonitor\.setExamActive\(false\)", \(\) => remoteSessionMonitor\.setExamActive\(false\)\)/,
    );
  });

  it("window close calls remoteSessionMonitor.stop(), exactly like processDetection.stop(), for shutdown safety", () => {
    const closedStart = mainSource.indexOf('mainWindow.on("closed"');
    expect(closedStart).toBeGreaterThan(-1);
    const closedBody = mainSource.slice(closedStart, closedStart + 300);
    expect(closedBody).toMatch(/processDetection\.stop\(\)/);
    expect(closedBody).toMatch(/remoteSessionMonitor\.stop\(\)/);
  });

  it("policy toggles (server-resolved TETHER_BLOCK_REMOTE_CONTROL) are relayed to RemoteSessionMonitor exactly like ProcessDetection", () => {
    const handlerStart = mainSource.indexOf('ipcMain.on("lockdown:set-lockdown-policy-toggles"');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBody = mainSource.slice(handlerStart, handlerStart + 300);
    expect(handlerBody).toMatch(/processDetection\.setPolicyToggles\(toggles\)/);
    expect(handlerBody).toMatch(/remoteSessionMonitor\.setPolicyToggles\(toggles\)/);
  });
});

describe("IPC channel: lockdown:remote-session-monitor-event", () => {
  it("main.ts sends it only through the destroyed-window-safe runOnWindowBestEffort wrapper", () => {
    const sendIndex = mainSource.indexOf('window.webContents.send("lockdown:remote-session-monitor-event"');
    expect(sendIndex).toBeGreaterThan(-1);
    const before = mainSource.slice(Math.max(0, sendIndex - 300), sendIndex);
    expect(before).toMatch(/runOnWindowBestEffort\(mainWindow,/);
  });

  it("preload.ts registers the ipcRenderer listener and exposes onRemoteSessionMonitorEvent on the bridge", () => {
    expect(preloadSource).toMatch(/ipcRenderer\.on\("lockdown:remote-session-monitor-event"/);
    expect(preloadSource).toMatch(/onRemoteSessionMonitorEvent\(callback:/);
  });

  it("the exam page registers a listener and calls reportRemoteSessionMonitorTransition with the secure-client session id already in scope", () => {
    expect(pageTsxSource).toMatch(/onRemoteSessionMonitorEvent\?\.\(\(payload\)/);
    const listenerStart = pageTsxSource.indexOf("onRemoteSessionMonitorEvent?.((payload)");
    const listenerBody = pageTsxSource.slice(listenerStart, listenerStart + 1200);
    expect(listenerBody).toMatch(/reportRemoteSessionMonitorTransition\(/);
    expect(listenerBody).toMatch(/secureClientSessionId:\s*sessionId/);
  });
});

describe("required behaviour #7 — event-triggered evidence capture on BECAME_ACTIVE", () => {
  it("the page only triggers a capture for BECAME_ACTIVE, never for BECAME_INACTIVE/CHECK_UNAVAILABLE/CHECK_RECOVERED", () => {
    const listenerStart = pageTsxSource.indexOf("onRemoteSessionMonitorEvent?.((payload)");
    const listenerBody = pageTsxSource.slice(listenerStart, listenerStart + 1600);
    expect(listenerBody).toMatch(/if \(payload\.kind === "BECAME_ACTIVE"\)/);
    expect(listenerBody).toMatch(/remoteSessionCaptureEvidenceRef\.current\(\)/);
  });
});

describe("required behaviour #5 — reuses the existing event/evidence model, no new IntegrityEventType", () => {
  it("reportRemoteSessionMonitorTransition reuses integrityEventTypeForCapabilityCategory and severityForLockdownDetection, exactly like reportLockdownCapabilityTransition", () => {
    const fnStart = lockdownClientSource.indexOf("export async function reportRemoteSessionMonitorTransition");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = lockdownClientSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toMatch(/integrityEventTypeForCapabilityCategory\(REMOTE_SESSION_CATEGORY\)/);
    expect(fnBody).toMatch(/severityForLockdownDetection\(action\)/);
    expect(fnBody).toMatch(/eventType: "PROHIBITED_APPLICATION_CLOSED"/);
    // Never a bespoke new IntegrityEventType string for the ACTIVE case.
    expect(fnBody).not.toMatch(/eventType:\s*"REMOTE_SESSION_ACTIVE"/);
    expect(fnBody).not.toMatch(/eventType:\s*"REMOTE_DESKTOP_SESSION_DETECTED"/);
  });
});

describe("required behaviour #8 — no automatic exam termination or submission", () => {
  it("neither remoteSessionMonitor.ts nor lockdownClient's reportRemoteSessionMonitorTransition ever calls a submit/terminate endpoint or method", () => {
    const remoteSessionMonitorSource = fs.readFileSync(path.join(__dirname, "remoteSessionMonitor.ts"), "utf8");
    // Looks for an actual ACTION (a fetch call, a method invocation) —
    // not prose in a doc comment, which legitimately says "never
    // terminates or submits the exam itself".
    expect(remoteSessionMonitorSource).not.toMatch(/\.terminate\(|\.submitExam\(|fetch\([^)]*submit/i);
    const fnStart = lockdownClientSource.indexOf("export async function reportRemoteSessionMonitorTransition");
    const fnBody = lockdownClientSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).not.toMatch(/\/submit\b/);
    expect(fnBody).not.toMatch(/fetch\([^)]*terminate/i);
    // The only network call this function ever makes is the shared
    // postIntegrityEvent helper — never a bespoke fetch to any other route.
    expect(fnBody).not.toMatch(/fetch\(/);
  });
});
