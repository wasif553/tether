import { describe, it, expect } from "vitest";
import { verifyPackagedReleaseContents } from "./verifyPackagedRelease";

// ---------------------------------------------------------------------------
// Corrective pass v1.2.1, Task D/F — "packaged application contains
// current compiled code" test. See verifyPackagedRelease.ts for the CLI
// entrypoint that runs this against a real `release/win-unpacked` build
// (wired into `npm run verify:package`, invoked from `npm run dist:win`).
// ---------------------------------------------------------------------------

const VALID_INPUT = {
  expectedVersion: "1.2.1",
  packagedPackageJsonContent: JSON.stringify({ version: "1.2.1" }),
  packagedSharedJsContent: 'exports.LOCKDOWN_VERSION = "1.2.1";',
  packagedMainJsContent: 'ipcMain.on("lockdown:set-secure-client-enforcement-state", ...); ipcMain.handle("lockdown:get-diagnostics-snapshot", ...);',
  packagedDisplayEnforcementJsContent: "setEnforcementState(state) { ... } resolveReadinessGatedDisplayEnforcementState(...)",
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

  it("reports every distinct problem at once rather than stopping at the first", () => {
    const result = verifyPackagedReleaseContents({
      expectedVersion: "1.2.1",
      packagedPackageJsonContent: JSON.stringify({ version: "1.2.0" }),
      packagedSharedJsContent: 'exports.LOCKDOWN_VERSION = "1.2.0";',
      packagedMainJsContent: null,
      packagedDisplayEnforcementJsContent: null,
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});
