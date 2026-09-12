import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Tether Windows Hardening v1.8.0, Phase A+B — source-text structural
 * assertions proving the ACTIVATION BOUNDARY and WINDOW-CLOSE wiring in
 * main.ts, following this package's established convention for testing
 * Electron-glue ordering without mocking Electron itself (see
 * ipcChain.test.ts). The pure decision logic these handlers delegate to
 * (keyboardHardeningRecoveryLogic.ts, windowCloseGuard.ts,
 * keyboardHardeningHelperProtocol.ts) already has full behavioural
 * coverage in its own test files — this file exists only to prove main.ts
 * actually calls them from the right places, in the right order.
 */

const mainSource = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");

function sliceHandler(startMarker: string, source: string = mainSource): string {
  const start = source.indexOf(startMarker);
  expect(start, `could not find handler starting with: ${startMarker}`).toBeGreaterThan(-1);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces extracting handler: ${startMarker}`);
}

describe("activation boundary — lockdown:activate-secure-exam-lockdown", () => {
  const handler = sliceHandler('ipcMain.handle("lockdown:activate-secure-exam-lockdown"');

  it("arms the keyboard-hardening helper via ensureArmedForActivation", () => {
    expect(handler).toContain("await keyboardHelperManager.ensureArmedForActivation()");
  });

  it("the helper is armed AFTER every fresh precheck (process scan, remote-session check, display topology) and BEFORE any of display/process/remote-session/lifecycle state is flipped", () => {
    const processCheckIdx = handler.indexOf("await processDetection.runPreflightScan()");
    const remoteSessionCheckIdx = handler.indexOf("await getWindowsSessionClassification()");
    const displayCheckIdx = handler.indexOf("await displayEnforcement.getOnDemandDisplayTopology()");
    const armIdx = handler.indexOf("await keyboardHelperManager.ensureArmedForActivation()");
    const displayActivateIdx = handler.indexOf("displayEnforcement.setEnforcementState({ active: true");
    const processActivateIdx = handler.indexOf("processDetection.setExamActive(true)");
    const remoteActivateIdx = handler.indexOf("remoteSessionMonitor.setExamActive(true)");
    const lifecycleActivateIdx = handler.indexOf("lockdownLifecycle.activate()");

    expect(processCheckIdx).toBeGreaterThan(-1);
    expect(remoteSessionCheckIdx).toBeGreaterThan(processCheckIdx);
    expect(displayCheckIdx).toBeGreaterThan(remoteSessionCheckIdx);
    expect(armIdx).toBeGreaterThan(displayCheckIdx);
    expect(displayActivateIdx).toBeGreaterThan(armIdx);
    expect(processActivateIdx).toBeGreaterThan(armIdx);
    expect(remoteActivateIdx).toBeGreaterThan(armIdx);
    expect(lifecycleActivateIdx).toBeGreaterThan(armIdx);
  });

  it("a failed arm returns BEFORE any state-flipping call — activation fails entirely, never partially applied", () => {
    const armIdx = handler.indexOf("const armResult = await keyboardHelperManager.ensureArmedForActivation();");
    const notOkIdx = handler.indexOf("if (!armResult.ok)", armIdx);
    const returnIdx = handler.indexOf("return { ok: false, reason: \"KEYBOARD_HARDENING_UNAVAILABLE\" };", notOkIdx);
    const displayActivateIdx = handler.indexOf("displayEnforcement.setEnforcementState({ active: true", returnIdx);
    expect(armIdx).toBeGreaterThan(-1);
    expect(notOkIdx).toBeGreaterThan(armIdx);
    expect(returnIdx).toBeGreaterThan(notOkIdx);
    expect(displayActivateIdx).toBeGreaterThan(returnIdx); // the ok-path activation code textually follows the early return — never reached when armResult.ok is false
    const failureBranch = handler.slice(notOkIdx, returnIdx + 'return { ok: false, reason: "KEYBOARD_HARDENING_UNAVAILABLE" };'.length);
    expect(failureBranch).toContain("return");
  });

  it("an arm failure is reported via the EXISTING TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE audit action — never a new, unregistered action string requiring a main-repo allow-list change", () => {
    expect(handler).toMatch(/reportAuditFactBestEffort\("TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE",\s*\{\s*reason:\s*"KEYBOARD_HARDENING_ARM_FAILED"/);
  });

  it("KEYBOARD_HARDENING_UNAVAILABLE is a real member of the exported failure-reason union, not just an ad-hoc string", () => {
    const unionStart = mainSource.indexOf("export type SecureExamLockdownActivationFailureReason =");
    const unionEnd = mainSource.indexOf(";", unionStart);
    const union = mainSource.slice(unionStart, unionEnd);
    expect(union).toContain('"KEYBOARD_HARDENING_UNAVAILABLE"');
  });
});

describe("Final activation-failure safety audit (post-v1.8.0) — transactional rollback after ARM succeeds", () => {
  const handler = sliceHandler('ipcMain.handle("lockdown:activate-secure-exam-lockdown"');

  it("the four post-ARM activation calls are wrapped in a try/catch that rolls back via restoreLockdownControls and returns ACTIVATION_INTERNAL_ERROR on any throw", () => {
    const tryIdx = handler.indexOf("try {");
    const displayActivateIdx = handler.indexOf("displayEnforcement.setEnforcementState({ active: true", tryIdx);
    const processActivateIdx = handler.indexOf("processDetection.setExamActive(true)", tryIdx);
    const remoteActivateIdx = handler.indexOf("remoteSessionMonitor.setExamActive(true)", tryIdx);
    const lifecycleActivateIdx = handler.indexOf("lockdownLifecycle.activate()", tryIdx);
    const diagnosticsIdx = handler.indexOf("maybeEmitDiagnostics()", tryIdx);
    const catchIdx = handler.indexOf("} catch (err) {", tryIdx);

    expect(tryIdx).toBeGreaterThan(-1);
    // All four (plus diagnostics) live INSIDE the try block, in the
    // original order — nothing was silently reordered or dropped while
    // adding the safety net.
    expect(displayActivateIdx).toBeGreaterThan(tryIdx);
    expect(processActivateIdx).toBeGreaterThan(displayActivateIdx);
    expect(remoteActivateIdx).toBeGreaterThan(processActivateIdx);
    expect(lifecycleActivateIdx).toBeGreaterThan(remoteActivateIdx);
    expect(diagnosticsIdx).toBeGreaterThan(lifecycleActivateIdx);
    expect(catchIdx).toBeGreaterThan(diagnosticsIdx);

    const catchBlock = handler.slice(catchIdx, handler.indexOf("return { ok: false, reason: \"ACTIVATION_INTERNAL_ERROR\" };", catchIdx) + 60);
    expect(catchBlock).toContain('restoreLockdownControls("activation-step-threw-after-arm");');
    expect(catchBlock).toContain('return { ok: false, reason: "ACTIVATION_INTERNAL_ERROR" };');
  });

  it("after the try/catch, an isWindowUsable(mainWindow) check rolls back and refuses success if the renderer/window disappeared while this handler was in flight", () => {
    const catchIdx = handler.indexOf("} catch (err) {");
    const catchBlockEnd = handler.indexOf("return { ok: false, reason: \"ACTIVATION_INTERNAL_ERROR\" };", catchIdx) + 60;
    const windowCheckIdx = handler.indexOf("if (!isWindowUsable(mainWindow)) {", catchBlockEnd);
    const finalSuccessIdx = handler.indexOf('return { ok: true, displayDecision: "OK", processDecision: "CLEAN" };');

    expect(windowCheckIdx).toBeGreaterThan(catchBlockEnd);
    expect(finalSuccessIdx).toBeGreaterThan(windowCheckIdx);

    const windowCheckBlock = handler.slice(windowCheckIdx, finalSuccessIdx);
    expect(windowCheckBlock).toContain('restoreLockdownControls("activation-window-gone");');
    expect(windowCheckBlock).toContain('return { ok: false, reason: "ACTIVATION_INTERNAL_ERROR" };');
  });

  it("ACTIVATION_INTERNAL_ERROR is a real member of the exported failure-reason union", () => {
    const unionStart = mainSource.indexOf("export type SecureExamLockdownActivationFailureReason =");
    const unionEnd = mainSource.indexOf(";", unionStart);
    expect(mainSource.slice(unionStart, unionEnd)).toContain('"ACTIVATION_INTERNAL_ERROR"');
  });

  it("the success return is textually the LAST statement in the handler — nothing after it could re-arm or re-activate anything unconditionally", () => {
    const finalSuccessIdx = handler.indexOf('return { ok: true, displayDecision: "OK", processDecision: "CLEAN" };');
    expect(finalSuccessIdx).toBeGreaterThan(-1);
    const afterSuccess = handler.slice(finalSuccessIdx + 'return { ok: true, displayDecision: "OK", processDecision: "CLEAN" };'.length);
    // Only the handler's own closing brace(s) should remain.
    expect(afterSuccess.trim().replace(/}/g, "").replace(/\)/g, "").replace(/;/g, "")).toBe("");
  });
});

describe("legacy/partial activation paths must NEVER independently arm the keyboard-hardening helper", () => {
  it("lockdown:set-secure-client-enforcement-state never references keyboardHelperManager", () => {
    const handler = sliceHandler('ipcMain.on("lockdown:set-secure-client-enforcement-state"');
    expect(handler).not.toContain("keyboardHelperManager");
  });

  it("lockdown:set-lockdown-exam-active never references keyboardHelperManager", () => {
    const handler = sliceHandler('ipcMain.on("lockdown:set-lockdown-exam-active"');
    expect(handler).not.toContain("keyboardHelperManager");
  });
});

describe("restoration — DISARM only ever runs via the authoritative restore-action list", () => {
  it("keyboardHelperManager.disarm() is registered as a lockdownLifecycle restore action, alongside the other three existing teardown actions", () => {
    const registrationsBlockStart = mainSource.indexOf('lockdownLifecycle.registerRestoreAction("processDetection.setExamActive(false)"');
    const registrationCallIdx = mainSource.indexOf('lockdownLifecycle.registerRestoreAction("keyboardHelperManager.disarm()"');
    expect(registrationCallIdx).toBeGreaterThan(registrationsBlockStart);
    const block = mainSource.slice(registrationsBlockStart, registrationCallIdx + 200);
    expect(block).toContain('lockdownLifecycle.registerRestoreAction("keyboardHelperManager.disarm()", () => keyboardHelperManager.disarm());');
  });

  it("disarm() is never called directly from the activation handler or the legacy IPC paths — only via the registered restore action above", () => {
    const activateHandler = sliceHandler('ipcMain.handle("lockdown:activate-secure-exam-lockdown"');
    const legacyState = sliceHandler('ipcMain.on("lockdown:set-secure-client-enforcement-state"');
    const legacyActive = sliceHandler('ipcMain.on("lockdown:set-lockdown-exam-active"');
    for (const handler of [activateHandler, legacyState, legacyActive]) {
      expect(handler).not.toContain("keyboardHelperManager.disarm()");
    }
  });
});

describe("ordinary window-close interception", () => {
  it("mainWindow.on(\"close\", ...) calls shouldPreventOrdinaryClose and conditionally preventDefault()s", () => {
    const closeStart = mainSource.indexOf('mainWindow.on("close", (event) => {');
    expect(closeStart).toBeGreaterThan(-1);
    const closeEnd = mainSource.indexOf("});", closeStart) + 3;
    const block = mainSource.slice(closeStart, closeEnd);
    expect(block).toContain("if (!shouldPreventOrdinaryClose(lockdownLifecycle.getState())) return;");
    expect(block).toContain("event.preventDefault();");
  });

  it("a blocked close is recorded via the EXISTING KEYBOARD_SHORTCUT_BLOCKED/CLOSE_WINDOW vocabulary — the same one Alt+F4/Ctrl+W already use — never a new event type", () => {
    const closeStart = mainSource.indexOf('mainWindow.on("close", (event) => {');
    const closeEnd = mainSource.indexOf("});", closeStart) + 3;
    const block = mainSource.slice(closeStart, closeEnd);
    expect(block).toMatch(/recordEvent\("KEYBOARD_SHORTCUT_BLOCKED",[\s\S]*shortcutReason:\s*"CLOSE_WINDOW"/);
  });

  it("close interception is gated on the SAME lockdownLifecycle ACTIVE state as the existing before-input-event browser-chrome-shortcut blocking — never a separately-drifting condition", () => {
    const beforeInputIdx = mainSource.indexOf('mainWindow.webContents.on("before-input-event"');
    const closeIdx = mainSource.indexOf('mainWindow.on("close", (event) => {');
    expect(beforeInputIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(beforeInputIdx);
    const between = mainSource.slice(beforeInputIdx, closeIdx);
    // Both handlers appear back-to-back in the same createWindow() body — no unrelated ACTIVE-gated control is interleaved between them that could indicate drift.
    expect(between).toContain('lockdownLifecycle.getState() !== "ACTIVE"');
  });
});

describe("keyboard-hardening manager wiring", () => {
  it("attachTargetWindow is called for the overlay, alongside processDetection/remoteSessionMonitor's own", () => {
    const idx = mainSource.indexOf("processDetection.attachTargetWindow(mainWindow);");
    const block = mainSource.slice(idx, idx + 300);
    expect(block).toContain("remoteSessionMonitor.attachTargetWindow(mainWindow);");
    expect(block).toContain("keyboardHelperManager.attachTargetWindow(mainWindow);");
  });

  it("a bounded diagnostic status getter is exposed over IPC, mirroring lockdown:get-lockdown-lifecycle-state's own shape", () => {
    expect(mainSource).toContain('ipcMain.handle("lockdown:get-keyboard-hardening-status", () => keyboardHelperManager.getStatusSnapshot());');
  });
});
