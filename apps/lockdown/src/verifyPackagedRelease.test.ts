import { describe, it, expect } from "vitest";
import { verifyPackagedReleaseContents } from "./verifyPackagedRelease";

// ---------------------------------------------------------------------------
// Corrective pass v1.2.1, Task D/F — "packaged application contains
// current compiled code" test. See verifyPackagedRelease.ts for the CLI
// entrypoint that runs this against a real `release/win-unpacked` build
// (wired into `npm run verify:package`, invoked from `npm run dist:win`).
// ---------------------------------------------------------------------------

// Windows taskbar icon fix v1.7.1 — builds a minimal but structurally
// real ICO buffer (a real ICONDIR + ICONDIRENTRY header; the "image
// data" bytes referenced by each entry don't need to actually exist
// since parseIcoResolutions only reads the header) so these tests never
// depend on the repo's actual assets/icon.ico contents.
const FULL_ICON_RESOLUTIONS = [16, 24, 32, 48, 64, 128, 256];

function buildIcoBuffer(resolutions: number[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(resolutions.length, 4);
  const entries = resolutions.map((size) => {
    const entry = Buffer.alloc(16);
    const byteSize = size === 256 ? 0 : size; // ICO convention: 0 means 256
    entry.writeUInt8(byteSize, 0);
    entry.writeUInt8(byteSize, 1);
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(16, 8); // fake image-data size
    entry.writeUInt32LE(0, 12); // offset (unused by the header-only parser)
    return entry;
  });
  return Buffer.concat([header, ...entries]);
}

function buildPngRenamedToIcoBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

const VALID_ELECTRON_BUILDER_YML = `
win:
  icon: assets/icon.ico
  signAndEditExecutable: false

files:
  - dist/**/*
  - package.json
  - assets/icon.ico
`;

const VALID_INPUT = {
  expectedVersion: "1.2.1",
  packagedPackageJsonContent: JSON.stringify({ version: "1.2.1" }),
  packagedSharedJsContent: 'exports.LOCKDOWN_VERSION = "1.2.1"; exports.TETHER_APP_USER_MODEL_ID = "com.tether.securebrowser";',
  packagedMainJsContent:
    'ipcMain.on("lockdown:set-secure-client-enforcement-state", ...); ipcMain.handle("lockdown:get-diagnostics-snapshot", ...); ipcMain.handle("lockdown:run-preflight-scan", ...); findUnsafeCommandLineSwitch(process.argv); performLockdownRestoration(lockdownLifecycle, restorationController, trigger); app.setAppUserModelId(shared_1.TETHER_APP_USER_MODEL_ID); const LOCKDOWN_ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico"); const remoteSessionMonitor = new remoteSessionMonitor_1.RemoteSessionMonitor({...}); ipcMain.on("lockdown:set-lockdown-exam-active", (_e, active) => { processDetection.setExamActive(active); remoteSessionMonitor.setExamActive(active); }); mainWindow.on("closed", () => { processDetection.stop(); remoteSessionMonitor.stop(); });',
  packagedDisplayEnforcementJsContent:
    "setEnforcementState(state) { ... } resolveReadinessGatedDisplayEnforcementState(...) evaluate() { ... const run = this.evaluateNow(); this.evaluateInFlight = run; ... }",
  packagedProcessDetectionJsContent: "runPreflightScan() { ... } setExamActive(active) { ... } pollOnce() { ... this.scanInFlight = this.pollOnceNow(); ... }",
  packagedRemoteSessionMonitorJsContent:
    "class RemoteSessionMonitor { setExamActive(active) { ... resolveRemoteSessionMonitorIntervalSeconds() ... } stop() { ... } pollOnceNow() { ... computeRemoteSessionMonitorTransitions(this.state, classification) ... } }",
  sourceIconIcoBuffer: buildIcoBuffer(FULL_ICON_RESOLUTIONS),
  electronBuilderYmlContent: VALID_ELECTRON_BUILDER_YML,
  packagedIconIcoBuffer: buildIcoBuffer(FULL_ICON_RESOLUTIONS),
  packagedExeIconResolutions: FULL_ICON_RESOLUTIONS,
};

describe("verifyPackagedReleaseContents", () => {
  it("passes when every file is present, current, and version-matched", () => {
    const result = verifyPackagedReleaseContents(VALID_INPUT);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when the packaged app is entirely missing (never packaged, or wrong --release-dir)", () => {
    const result = verifyPackagedReleaseContents({
      expectedVersion: "1.2.1",
      packagedPackageJsonContent: null,
      packagedSharedJsContent: null,
      packagedMainJsContent: null,
      packagedDisplayEnforcementJsContent: null,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails when the packaged package.json version does not match the source version (stale build)", () => {
    const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedPackageJsonContent: JSON.stringify({ version: "1.2.0" }) });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("fails when dist/shared.js's compiled LOCKDOWN_VERSION does not match (compiled bundle out of sync with package.json)", () => {
    const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedSharedJsContent: 'exports.LOCKDOWN_VERSION = "1.2.0";' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("shared.js"))).toBe(true);
  });

  it("fails when dist/main.js does not contain the current display-enforcement IPC channel names (a pre-Task-C stale build)", () => {
    const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedMainJsContent: 'ipcMain.on("lockdown:set-display-policy-enforced", ...);' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("main.js"))).toBe(true);
  });

  it("fails when dist/displayEnforcement.js does not contain the fail-closed readiness-gated logic (a pre-Task-C stale build)", () => {
    const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedDisplayEnforcementJsContent: "setRequireSingleDisplay(required) { ... }" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("displayEnforcement.js"))).toBe(true);
  });

  it("fails when dist/processDetection.js is missing (a pre-v1.7.0 stale build, before Windows Lockdown Hardening v1)", () => {
    const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedProcessDetectionJsContent: null });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("processDetection.js"))).toBe(true);
  });

  it("fails when dist/main.js does not contain the lockdown preflight-scan IPC channel or command-line-switch rejection (a pre-v1.7.0 stale build)", () => {
    const result = verifyPackagedReleaseContents({
      ...VALID_INPUT,
      packagedMainJsContent: 'ipcMain.on("lockdown:set-secure-client-enforcement-state", ...); ipcMain.handle("lockdown:get-diagnostics-snapshot", ...);',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("lockdown:run-preflight-scan"))).toBe(true);
    expect(result.errors.some((e) => e.includes("findUnsafeCommandLineSwitch"))).toBe(true);
  });

  it("fails when dist/main.js does not contain performLockdownRestoration (a pre-v1.7.1 stale build predating the destroyed-window crash fix)", () => {
    const result = verifyPackagedReleaseContents({
      ...VALID_INPUT,
      packagedMainJsContent:
        'ipcMain.on("lockdown:set-secure-client-enforcement-state", ...); ipcMain.handle("lockdown:get-diagnostics-snapshot", ...); ipcMain.handle("lockdown:run-preflight-scan", ...); findUnsafeCommandLineSwitch(process.argv);',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("performLockdownRestoration"))).toBe(true);
  });

  // Mid-exam remote-session monitoring v1 (v1.7.2).
  describe("mid-exam remote-session monitoring v1", () => {
    it("fails when dist/main.js does not wire RemoteSessionMonitor into the ACTIVE-lifecycle handler or shutdown cleanup (a pre-v1.7.2 stale build)", () => {
      const result = verifyPackagedReleaseContents({
        ...VALID_INPUT,
        packagedMainJsContent:
          'ipcMain.on("lockdown:set-secure-client-enforcement-state", ...); ipcMain.handle("lockdown:get-diagnostics-snapshot", ...); ipcMain.handle("lockdown:run-preflight-scan", ...); findUnsafeCommandLineSwitch(process.argv); performLockdownRestoration(lockdownLifecycle, restorationController, trigger); app.setAppUserModelId(shared_1.TETHER_APP_USER_MODEL_ID); const LOCKDOWN_ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");',
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes(".RemoteSessionMonitor("))).toBe(true);
      expect(result.errors.some((e) => e.includes("remoteSessionMonitor.setExamActive(active)"))).toBe(true);
      expect(result.errors.some((e) => e.includes("remoteSessionMonitor.stop()"))).toBe(true);
    });

    it("fails when dist/remoteSessionMonitor.js is missing entirely (a pre-v1.7.2 stale build)", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedRemoteSessionMonitorJsContent: null });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("dist/remoteSessionMonitor.js was not found"))).toBe(true);
    });

    it("fails when dist/remoteSessionMonitor.js is missing the interval-configuration or transition-dedup logic (a shell class with no real behaviour)", () => {
      const result = verifyPackagedReleaseContents({
        ...VALID_INPUT,
        packagedRemoteSessionMonitorJsContent: "class RemoteSessionMonitor { setExamActive(active) { ... } stop() { ... } }",
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("resolveRemoteSessionMonitorIntervalSeconds"))).toBe(true);
      expect(result.errors.some((e) => e.includes("computeRemoteSessionMonitorTransitions"))).toBe(true);
    });

    it("fails when dist/processDetection.js still contains the fixed .finally()-identity poll-serialization bug", () => {
      const result = verifyPackagedReleaseContents({
        ...VALID_INPUT,
        packagedProcessDetectionJsContent:
          "runPreflightScan() { ... } setExamActive(active) { ... } pollOnce() { ... const run = this.pollOnceNow(); this.scanInFlight = run.finally(() => { if (this.scanInFlight === run) this.scanInFlight = null; }); await run; }",
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("v1.7.2-fixed poll-serialization bug"))).toBe(true);
    });

    it("fails when dist/processDetection.js is missing the corrected in-flight assignment", () => {
      const result = verifyPackagedReleaseContents({
        ...VALID_INPUT,
        packagedProcessDetectionJsContent: "runPreflightScan() { ... } setExamActive(active) { ... }",
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("this.scanInFlight = this.pollOnceNow();"))).toBe(true);
    });

    it("fails when dist/displayEnforcement.js still contains the fixed .finally()-identity poll-serialization bug", () => {
      const result = verifyPackagedReleaseContents({
        ...VALID_INPUT,
        packagedDisplayEnforcementJsContent:
          "setEnforcementState(state) { ... } resolveReadinessGatedDisplayEnforcementState(...) evaluate() { ... const run = this.evaluateNow(); this.evaluateInFlight = run.finally(() => { if (this.evaluateInFlight === run) this.evaluateInFlight = null; }); await run; }",
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("v1.7.2-fixed poll-serialization bug"))).toBe(true);
    });

    it("fails when dist/displayEnforcement.js is missing the corrected in-flight assignment", () => {
      const result = verifyPackagedReleaseContents({
        ...VALID_INPUT,
        packagedDisplayEnforcementJsContent: "setEnforcementState(state) { ... } resolveReadinessGatedDisplayEnforcementState(...)",
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("this.evaluateInFlight = run;"))).toBe(true);
    });

    it("fails when the packaged version is still 1.7.1 (a stale pre-version-bump build)", () => {
      const result = verifyPackagedReleaseContents({
        ...VALID_INPUT,
        expectedVersion: "1.7.2",
        packagedPackageJsonContent: JSON.stringify({ version: "1.7.1" }),
        packagedSharedJsContent: 'exports.LOCKDOWN_VERSION = "1.7.1"; exports.TETHER_APP_USER_MODEL_ID = "com.tether.securebrowser";',
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes('does not match the expected source version "1.7.2"'))).toBe(true);
    });
  });

  it("fails when dist/main.js does not contain setAppUserModelId or the runtime icon path (a pre-v1.7.1 stale build predating the taskbar icon fix)", () => {
    const result = verifyPackagedReleaseContents({
      ...VALID_INPUT,
      packagedMainJsContent:
        'ipcMain.on("lockdown:set-secure-client-enforcement-state", ...); ipcMain.handle("lockdown:get-diagnostics-snapshot", ...); ipcMain.handle("lockdown:run-preflight-scan", ...); findUnsafeCommandLineSwitch(process.argv); performLockdownRestoration(lockdownLifecycle, restorationController, trigger);',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("setAppUserModelId("))).toBe(true);
    expect(result.errors.some((e) => e.includes("LOCKDOWN_ICON_PATH"))).toBe(true);
  });

  it("fails when dist/shared.js does not contain the stable AppUserModelID", () => {
    const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedSharedJsContent: 'exports.LOCKDOWN_VERSION = "1.2.1";' });
    expect(result.ok).toBe(false);
  });

  describe("Windows taskbar icon fix v1.7.1", () => {
    it("passes with a genuine full-resolution ICO, a correctly configured electron-builder.yml, and a real icon resource embedded in the packaged .exe", () => {
      const result = verifyPackagedReleaseContents(VALID_INPUT);
      expect(result.ok).toBe(true);
    });

    it("fails when the source icon asset is missing", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, sourceIconIcoBuffer: null });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("Source assets/icon.ico") && e.includes("not found"))).toBe(true);
    });

    it("fails when the source icon asset is a PNG renamed to .ico, not a real ICO", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, sourceIconIcoBuffer: buildPngRenamedToIcoBuffer() });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("Source assets/icon.ico") && e.includes("not a valid multi-resolution ICO"))).toBe(true);
    });

    it("fails when the source icon asset is missing required resolutions (the original 4-size icon.ico this fix replaces)", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, sourceIconIcoBuffer: buildIcoBuffer([16, 32, 48, 256]) });
      expect(result.ok).toBe(false);
      const missingError = result.errors.find((e) => e.includes("Source assets/icon.ico") && e.includes("missing required resolution"));
      expect(missingError).toBeDefined();
      expect(missingError).toContain("24");
      expect(missingError).toContain("64");
      expect(missingError).toContain("128");
    });

    it("fails when electron-builder.yml does not reference assets/icon.ico under win", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, electronBuilderYmlContent: "win:\n  signAndEditExecutable: false\n" });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("does not reference assets/icon.ico"))).toBe(true);
    });

    it("fails when electron-builder.yml's files list does not bundle assets/icon.ico", () => {
      const result = verifyPackagedReleaseContents({
        ...VALID_INPUT,
        electronBuilderYmlContent: "win:\n  icon: assets/icon.ico\n  signAndEditExecutable: false\nfiles:\n  - dist/**/*\n  - package.json\n",
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("files list does not bundle"))).toBe(true);
    });

    it("fails when the packaged resources/app/assets/icon.ico is missing (BrowserWindow runtime icon asset not bundled)", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedIconIcoBuffer: null });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("Packaged resources/app/assets/icon.ico") && e.includes("not found"))).toBe(true);
    });

    it("fails when the packaged icon.ico is missing required resolutions even though the source one is fine (stale packaged bundle)", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedIconIcoBuffer: buildIcoBuffer([32, 256]) });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("Packaged resources/app/assets/icon.ico") && e.includes("missing required resolution"))).toBe(true);
    });

    it("fails when the packaged app .exe has no icon resource at all (embed:icon never ran — the exact original bug)", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedExeIconResolutions: null });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("Packaged app .exe") && e.includes("embed:icon"))).toBe(true);
    });

    it("fails when the packaged app .exe's embedded icon is missing required resolutions (a stale/partial embed:icon run)", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedExeIconResolutions: [16, 32, 256] });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("Packaged app .exe icon resource") && e.includes("missing required resolution"))).toBe(true);
    });

    it("treats a stored width/height of 0 as 256 (the ICO/PE convention), so a genuine 256px icon is not flagged as missing", () => {
      const result = verifyPackagedReleaseContents({ ...VALID_INPUT, packagedExeIconResolutions: [16, 24, 32, 48, 64, 128, 0] });
      expect(result.ok).toBe(true);
    });
  });

  it("reports every distinct problem at once rather than stopping at the first", () => {
    const result = verifyPackagedReleaseContents({
      expectedVersion: "1.2.1",
      packagedPackageJsonContent: JSON.stringify({ version: "1.2.0" }),
      packagedSharedJsContent: 'exports.LOCKDOWN_VERSION = "1.2.0";',
      packagedMainJsContent: null,
      packagedDisplayEnforcementJsContent: null,
      packagedProcessDetectionJsContent: null,
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });
});
