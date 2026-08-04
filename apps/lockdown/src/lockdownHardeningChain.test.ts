import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Tether Windows Lockdown Hardening v1, Part 7/8 — proves the Electron
// hardening wiring by reading the actual compiled/source main.ts (not
// mocking Electron), exactly like ipcChain.test.ts's own established
// convention for this codebase. Covers Part 16 test items 15-20.
// ---------------------------------------------------------------------------

const mainSource = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
const preloadSource = fs.readFileSync(path.join(__dirname, "preload.ts"), "utf8");

describe("Part 7 — webPreferences hardening", () => {
  it("contextIsolation/nodeIntegration/sandbox/webSecurity are all set correctly on the main window", () => {
    const createWindow = mainSource.slice(mainSource.indexOf("function createWindow"), mainSource.indexOf("mainWindow.setMenuBarVisibility"));
    expect(createWindow).toMatch(/contextIsolation:\s*true/);
    expect(createWindow).toMatch(/nodeIntegration:\s*false/);
    expect(createWindow).toMatch(/sandbox:\s*true/);
    expect(createWindow).toMatch(/webSecurity:\s*true/);
  });

  it("never enables the removed/unsafe enableRemoteModule option", () => {
    expect(mainSource).not.toMatch(/enableRemoteModule/);
  });

  it("pre-merge audit finding (C.6) — devTools is disabled in a packaged build, not merely closed reactively after opening", () => {
    const createWindow = mainSource.slice(mainSource.indexOf("function createWindow"), mainSource.indexOf("mainWindow.setMenuBarVisibility"));
    expect(createWindow).toMatch(/devTools:\s*!app\.isPackaged/);
  });
});

describe("Part 7 — permission request allowlist", () => {
  it("registers setPermissionRequestHandler allowing only media and fullscreen", () => {
    const handler = mainSource.slice(mainSource.indexOf("setPermissionRequestHandler"), mainSource.indexOf("setPermissionRequestHandler") + 400);
    expect(handler).toMatch(/callback\(permission === "media" \|\| permission === "fullscreen"\)/);
  });
});

describe("Part 7 — window.open denial (item 17)", () => {
  it("setWindowOpenHandler always denies", () => {
    const handler = mainSource.slice(mainSource.indexOf("setWindowOpenHandler"), mainSource.indexOf("setWindowOpenHandler") + 300);
    expect(handler).toMatch(/action:\s*"deny"/);
  });
});

describe("Part 7 — navigation denial outside the SES origin (item 16)", () => {
  it("will-navigate compares against SES_BASE_URL's own origin and calls preventDefault on mismatch", () => {
    const handler = mainSource.slice(mainSource.indexOf('"will-navigate"'), mainSource.indexOf('"will-navigate"') + 700);
    expect(handler).toMatch(/new URL\(url\)\.origin !== new URL\(SES_BASE_URL\)\.origin/);
    expect(handler).toMatch(/event\.preventDefault\(\)/);
  });
});

describe("Part 7 — download denial (item 19)", () => {
  it("blockDownloads registers a will-download handler that cancels every download", () => {
    const fn = mainSource.slice(mainSource.indexOf("function blockDownloads"), mainSource.indexOf("function blockDownloads") + 500);
    expect(fn).toMatch(/"will-download"/);
    expect(fn).toMatch(/event\.preventDefault\(\)/);
  });

  it("blockDownloads is actually called during app startup", () => {
    expect(mainSource).toMatch(/blockDownloads\(\);/);
  });
});

describe("Part 7/8 — DevTools prevention in packaged builds (item 15)", () => {
  it("devtools-opened is only wired when app.isPackaged, and closes DevTools", () => {
    const idx = mainSource.indexOf("devtools-opened");
    const surrounding = mainSource.slice(Math.max(0, idx - 200), idx + 300);
    expect(surrounding).toMatch(/app\.isPackaged/);
    expect(surrounding).toMatch(/closeDevTools\(\)/);
  });
});

describe("Part 8 — keyboard shortcut blocking wiring (item 21)", () => {
  it("before-input-event calls classifyKeyboardShortcut and preventDefault on a match", () => {
    const handler = mainSource.slice(mainSource.indexOf('"before-input-event"'), mainSource.indexOf('"before-input-event"') + 500);
    expect(handler).toMatch(/classifyKeyboardShortcut\(/);
    expect(handler).toMatch(/event\.preventDefault\(\)/);
  });

  it("22. no Secure-Attention-Sequence handling exists anywhere — see keyboardHardeningLogic.test.ts for the same assertion against the actual shortcut-matching function", () => {
    expect(mainSource).not.toMatch(/SecureAttentionSequence|SAS_/);
  });

  it("pre-merge audit finding (D.1/D.2) — shortcut blocking is gated on lockdownLifecycle being ACTIVE, so it does not apply outside an active exam and self-corrects the moment restoration runs", () => {
    const handler = mainSource.slice(mainSource.indexOf('"before-input-event"'), mainSource.indexOf('"before-input-event"') + 300);
    const gateIdx = handler.indexOf('lockdownLifecycle.getState() !== "ACTIVE"');
    const classifyIdx = handler.indexOf("classifyKeyboardShortcut(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(classifyIdx).toBeGreaterThan(-1);
    // The gate must run BEFORE the classifier — never blocked based on
    // state checked after the shortcut has already been classified.
    expect(gateIdx).toBeLessThan(classifyIdx);
  });
});

describe("Part 7 — unsafe command-line switches refuse to launch (disable insecure debug ports)", () => {
  it("checks findUnsafeCommandLineSwitch(process.argv) before app.requestSingleInstanceLock", () => {
    const switchCheckIdx = mainSource.indexOf("findUnsafeCommandLineSwitch(process.argv)");
    const lockIdx = mainSource.indexOf("requestSingleInstanceLock");
    expect(switchCheckIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(switchCheckIdx).toBeLessThan(lockIdx);
  });

  it("refuses to continue (app.exit) when an unsafe switch is found", () => {
    const block = mainSource.slice(mainSource.indexOf("const unsafeSwitch"), mainSource.indexOf("const gotLock"));
    expect(block).toMatch(/app\.exit\(1\)/);
  });
});

describe("IPC payload validation (Part 7 / item 20)", () => {
  it("lockdown:set-lockdown-policy-toggles validates its payload before trusting it", () => {
    const handler = mainSource.slice(mainSource.indexOf('"lockdown:set-lockdown-policy-toggles"'), mainSource.indexOf('"lockdown:set-lockdown-policy-toggles"') + 300);
    expect(handler).toMatch(/isValidPolicyToggles\(toggles\)/);
  });

  it("lockdown:set-lockdown-exam-active validates its payload is a boolean before trusting it", () => {
    const handler = mainSource.slice(mainSource.indexOf('"lockdown:set-lockdown-exam-active"'), mainSource.indexOf('"lockdown:set-lockdown-exam-active"') + 300);
    expect(handler).toMatch(/typeof active !== "boolean"/);
  });

  it("lockdown:report-lockdown-audit-fact bounds the action string length before relaying it", () => {
    const handler = mainSource.slice(mainSource.indexOf('"lockdown:report-lockdown-audit-fact"'), mainSource.indexOf('"lockdown:report-lockdown-audit-fact"') + 500);
    expect(handler).toMatch(/action\.length === 0 \|\| action\.length > 100/);
  });

  it("preload only exposes narrowly-typed, validated bridge methods for the lockdown surface — never a generic ipcRenderer passthrough", () => {
    expect(preloadSource).toMatch(/setLockdownPolicyToggles\(toggles:/);
    expect(preloadSource).toMatch(/runLockdownPreflightScan\(\)/);
    expect(preloadSource).not.toMatch(/window\.ipcRenderer/);
  });
});

describe("No arbitrary shell execution or renderer-controlled file paths (Part 7)", () => {
  it("main.ts never calls shell.openExternal or child_process exec/execSync with any value", () => {
    expect(mainSource).not.toMatch(/shell\.openExternal/);
    expect(mainSource).not.toMatch(/\bexec\(|\bexecSync\(/);
  });
});
