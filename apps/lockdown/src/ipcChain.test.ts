import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Corrective pass v1.2.1, Task D — "Verify IPC and packaged build." Proves
// every hop of the chain by reading the actual source files (not mocking
// Electron, per this repo's established convention — see
// displayEnforcementLogic.test.ts's own structural tests): the web exam
// page calls setSecureClientEnforcementState -> preload exposes the
// bridge -> main.ts receives the IPC message -> displayEnforcement stores
// the policy and re-evaluates immediately -> the overlay BrowserWindow is
// created/shown on BLOCKED. See verifyPackagedRelease.test.ts for the
// final hop ("the packaged release contains the newly compiled dist
// files").
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const pageTsxSource = fs.readFileSync(path.join(REPO_ROOT, "src", "app", "student", "exams", "[id]", "page.tsx"), "utf8");
const preloadSource = fs.readFileSync(path.join(__dirname, "preload.ts"), "utf8");
const mainSource = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
const displayEnforcementSource = fs.readFileSync(path.join(__dirname, "displayEnforcement.ts"), "utf8");

describe("IPC chain hop 1: the web exam page calls setSecureClientEnforcementState", () => {
  it("the mount-time effect calls it with active:true as soon as the Tether browser is detected (the Task C fix)", () => {
    expect(pageTsxSource).toMatch(/window\.sesLockdown\?\.setSecureClientEnforcementState\?\.\(\{\s*active:\s*true,\s*ready:\s*false/);
  });

  it("the status-resolution effect calls it again with the real ready/requireSingleDisplay values once the authoritative policy is known", () => {
    const statusEffect = pageTsxSource.slice(pageTsxSource.indexOf("fetch(`/api/submissions/${submissionId}/secure-client/status`)"));
    expect(statusEffect.slice(0, 2000)).toMatch(/setSecureClientEnforcementState\?\.\(\{/);
  });

  it("a failed/malformed status fetch explicitly re-asserts the covering state rather than leaving the previous state in place (Task C: displayPolicy missing/invalid -> cover)", () => {
    const catchStart = pageTsxSource.indexOf("Fail closed: never silently leave the previous");
    expect(catchStart).toBeGreaterThan(-1);
    const catchBlock = pageTsxSource.slice(catchStart, catchStart + 800);
    expect(catchBlock).toMatch(/setSecureClientEnforcementState\?\.\(\{\s*active:\s*true,\s*ready:\s*false/);
  });
});

describe("IPC chain hop 2: preload exposes the expected bridge", () => {
  it("exposes setSecureClientEnforcementState on window.sesLockdown, sending lockdown:set-secure-client-enforcement-state", () => {
    expect(preloadSource).toMatch(/setSecureClientEnforcementState\(state:/);
    expect(preloadSource).toMatch(/ipcRenderer\.send\("lockdown:set-secure-client-enforcement-state"/);
  });

  it("also exposes the Task A/B diagnostic bridge methods: reportDiagnosticContext, isDiagnosticsPanelEnabled, onDiagnosticsSnapshot", () => {
    expect(preloadSource).toMatch(/reportDiagnosticContext\(context:/);
    expect(preloadSource).toMatch(/isDiagnosticsPanelEnabled\(\): Promise<boolean>/);
    expect(preloadSource).toMatch(/onDiagnosticsSnapshot\(callback:/);
  });
});

describe("IPC chain hop 3: main.ts receives the IPC message", () => {
  it("registers an ipcMain.on handler for lockdown:set-secure-client-enforcement-state that validates the payload before trusting it", () => {
    const handler = mainSource.slice(
      mainSource.indexOf('ipcMain.on("lockdown:set-secure-client-enforcement-state"'),
      mainSource.indexOf('ipcMain.handle("lockdown:get-display-count"'),
    );
    expect(handler).toMatch(/isValidEnforcementState\(state\)/);
    expect(handler).toMatch(/displayEnforcement\.setEnforcementState\(state\)/);
  });

  it("registers handlers for the Task A/B diagnostic IPC surface (report-diagnostic-context, get-diagnostics-enabled, get-diagnostics-snapshot)", () => {
    expect(mainSource).toMatch(/ipcMain\.on\("lockdown:report-diagnostic-context"/);
    expect(mainSource).toMatch(/ipcMain\.handle\("lockdown:get-diagnostics-enabled"/);
    expect(mainSource).toMatch(/ipcMain\.handle\("lockdown:get-diagnostics-snapshot"/);
  });
});

describe("IPC chain hop 4: displayEnforcement stores the policy and evaluate() runs immediately", () => {
  it("setEnforcementState assigns this.enforcementState and always bypasses the debounce", () => {
    const method = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("setEnforcementState(state"),
      displayEnforcementSource.indexOf("getCurrentDisplayCount()"),
    );
    expect(method).toMatch(/this\.enforcementState\s*=\s*state/);
    expect(method).toMatch(/evaluate\(\{\s*bypassDebounce:\s*true\s*\}\)/);
  });

  it("evaluateNow's decision call uses the readiness-gated resolver (not the old ungated one) — this is what actually closes the fail-open gap", () => {
    expect(displayEnforcementSource).toMatch(/resolveReadinessGatedDisplayEnforcementState\(/);
  });
});

describe("IPC chain hop 5: the overlay BrowserWindow is created and shown", () => {
  it("evaluateNow shows the overlay on BLOCKED and hides it otherwise", () => {
    const evaluateNow = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("private async evaluateNow"),
      displayEnforcementSource.indexOf("private showOverlay"),
    );
    expect(evaluateNow).toMatch(/if \(nextState === "BLOCKED"\) this\.showOverlay\(\);/);
    expect(evaluateNow).toMatch(/else this\.hideOverlay\(\);/);
  });

  it("showOverlay actually constructs a new BrowserWindow (not a no-op stub)", () => {
    const showOverlay = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("private showOverlay"),
      displayEnforcementSource.indexOf("private hideOverlay"),
    );
    expect(showOverlay).toMatch(/new BrowserWindow\(\{/);
    expect(showOverlay).toMatch(/overlay\.loadURL\(/);
  });
});
