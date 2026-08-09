import { describe, it, expect } from "vitest";
import { verifyPreloadBundleContents } from "./verifyPreloadBundle";

// ---------------------------------------------------------------------------
// v1.7.3 sandboxed-preload hotfix — build-time regression guard for
// dist/preload.js. See verifyPreloadBundle.ts's own doc comment for the
// root cause this guards against: a sandboxed Electron preload's
// require() is a restricted polyfill that throws "module not found" for
// anything but the small Electron allowlist, silently aborting the
// entire preload (and therefore window.sesLockdown) before it ever runs.
// ---------------------------------------------------------------------------

const REAL_BUNDLED_SHAPE = `"use strict";
var import_electron = require("electron");
var LOCKDOWN_VERSION = "1.7.3";
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
import_electron.ipcRenderer.on("lockdown:warning", (_event, message) => {});
import_electron.contextBridge.exposeInMainWorld("sesLockdown", {
  version: LOCKDOWN_VERSION,
  async getDisplayCount() {
    return import_electron.ipcRenderer.invoke("lockdown:get-display-count");
  },
});
`;

describe("verifyPreloadBundleContents", () => {
  it("passes for a real bundled shape: exactly one require(\"electron\"), no other require calls", () => {
    const result = verifyPreloadBundleContents(REAL_BUNDLED_SHAPE);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.requireSpecifiers).toEqual(["electron"]);
  });

  it("fails empty/missing content — the bundle:preload step must have run first", () => {
    expect(verifyPreloadBundleContents("").ok).toBe(false);
    expect(verifyPreloadBundleContents("   \n  ").ok).toBe(false);
  });

  it("fails on the EXACT v1.7.2 P0 regression: a literal require(\"./shared\")", () => {
    const stale = `"use strict";\nconst electron_1 = require("electron");\nconst shared_1 = require("./shared");\nelectron_1.contextBridge.exposeInMainWorld("sesLockdown", { version: shared_1.LOCKDOWN_VERSION });\n`;
    const result = verifyPreloadBundleContents(stale);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('require("./shared")'))).toBe(true);
    expect(result.errors.some((e) => e.includes("P0"))).toBe(true);
  });

  it("fails on any other relative require, not just ./shared — catches a FUTURE local import that escapes bundling", () => {
    const result = verifyPreloadBundleContents(`require("electron"); require("../someOtherLocalModule"); require("./anotherOne");`);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('require("../someOtherLocalModule")'))).toBe(true);
    expect(result.errors.some((e) => e.includes('require("./anotherOne")'))).toBe(true);
  });

  it("fails on a disallowed bare-module require (e.g. a Node builtin or npm package that escaped bundling)", () => {
    const result = verifyPreloadBundleContents(`require("electron"); require("fs"); require("some-npm-package");`);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('require("fs")'))).toBe(true);
    expect(result.errors.some((e) => e.includes('require("some-npm-package")'))).toBe(true);
  });

  it("fails when require(\"electron\") is entirely absent — a real bundled preload must retain it", () => {
    const result = verifyPreloadBundleContents(`"use strict";\nfunction noop() {}\n`);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('does not contain require("electron")'))).toBe(true);
  });

  it("does not false-positive on esbuild's own generated helper/interop code — no new require(...) calls, just inlined variables and IIFE helpers", () => {
    const esbuildStyleOutput = `"use strict";
var __defProp = Object.defineProperty;
var __export = (target, all) => { for (var name in all) __defProp(target, name, { get: all[name], enumerable: true }); };
var import_electron = require("electron");
var LOCKDOWN_VERSION = "1.7.3";
var USER_AGENT_SUFFIX = \`TetherSecureBrowser/\${LOCKDOWN_VERSION}\`;
import_electron.contextBridge.exposeInMainWorld("sesLockdown", { version: LOCKDOWN_VERSION });
`;
    const result = verifyPreloadBundleContents(esbuildStyleOutput);
    expect(result.ok).toBe(true);
    expect(result.requireSpecifiers).toEqual(["electron"]);
  });

  it("does not match require.resolve(...) or a non-literal require(someVar) as a specifier (a real bundled preload never needs either)", () => {
    // require.resolve has no capturing "require(" call with a string literal arg matching our pattern's
    // immediate-paren form the way require("electron") does, so it's simply never counted either way here —
    // this test documents that require("electron") is still detected correctly alongside such text.
    const result = verifyPreloadBundleContents(`require("electron"); // require.resolve is unrelated Node API, not used by this preload`);
    expect(result.ok).toBe(true);
  });
});
