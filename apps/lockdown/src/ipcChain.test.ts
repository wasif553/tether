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
const tetherLaunchSource = fs.readFileSync(
  path.join(REPO_ROOT, "src", "app", "student", "exams", "[id]", "tether-launch", "page.tsx"),
  "utf8",
);
const dashboardSource = fs.readFileSync(path.join(REPO_ROOT, "src", "app", "student", "page.tsx"), "utf8");

describe("IPC chain hop 1: the web exam page calls setSecureClientEnforcementState", () => {
  // v1.7.5 P0 — the old Task C mount-time cover (unconditionally calling
  // setSecureClientEnforcementState({active:true, ready:false, ...}) the
  // instant the exam page mounted, before any policy fetch) is REMOVED —
  // it downgraded an already ACTIVE+READY native state from a
  // successful Phase 2 handoff back to POLICY_NOT_READY, producing the
  // screen-saver-level, non-closable native overlay with no Recheck/Exit
  // route. See docs/tether-preflight-lifecycle-v1.7.5-policy-not-ready.md.
  it("v1.7.5 P0: the mount-time effect no longer calls setSecureClientEnforcementState at all — only the status-resolution effect below ever does, and only after native state has been reconciled", () => {
    const detectedIdx = pageTsxSource.indexOf("const detected = isRunningInLockdownBrowser();");
    expect(detectedIdx).toBeGreaterThan(-1);
    const mountEffectStart = pageTsxSource.lastIndexOf("useEffect(() => {", detectedIdx);
    const mountEffectEnd = pageTsxSource.indexOf("}, []);", detectedIdx) + "}, []);".length;
    const mountEffect = pageTsxSource.slice(mountEffectStart, mountEffectEnd);
    // A CALL site, not merely the identifier appearing in this effect's
    // own doc comment (which legitimately names the removed pattern for
    // documentation purposes).
    expect(mountEffect).not.toMatch(/sesLockdown\?\.setSecureClientEnforcementState\?\.\(/);
  });

  it("the status-resolution effect queries the FRESH native state via getSecureClientEnforcementState before ever deciding anything, and only calls setSecureClientEnforcementState once native lockdown is confirmed (or the exam is non-gated)", () => {
    const statusEffect = pageTsxSource.slice(pageTsxSource.indexOf("fetch(`/api/submissions/${submissionId}/secure-client/status`)"));
    const window = statusEffect.slice(0, 6000);
    expect(window).toMatch(/getSecureClientEnforcementState\!\(\)/);
    expect(window).toMatch(/resolveNativeLockdownConfirmation\(\{ gated, bridgeAvailable, nativeState, requireSingleDisplay: enforced \}\)/);
    // The reactivation and unsupported-build branches both return BEFORE
    // ever reaching the setSecureClientEnforcementState call below them.
    const reactivationIdx = window.indexOf('confirmation === "REACTIVATION_REQUIRED"');
    const unsupportedIdx = window.indexOf('confirmation === "UNSUPPORTED_BUILD"');
    const setterIdx = window.indexOf("setSecureClientEnforcementState?.(nextEnforcementState)");
    expect(reactivationIdx).toBeGreaterThan(-1);
    expect(unsupportedIdx).toBeGreaterThan(reactivationIdx);
    expect(setterIdx).toBeGreaterThan(unsupportedIdx);
  });

  it("v1.7.5 P0: a gated attempt whose native state is NOT already active+ready redirects to tether-launch for a fresh reactivation handshake — it never re-asserts a downgrading cover", () => {
    const statusEffect = pageTsxSource.slice(pageTsxSource.indexOf("fetch(`/api/submissions/${submissionId}/secure-client/status`)"));
    const window = statusEffect.slice(0, 4000);
    const reactivationBranchMatch = window.match(/if \(confirmation === "REACTIVATION_REQUIRED"\) \{([\s\S]*?)\n\s*\}/);
    expect(reactivationBranchMatch).not.toBeNull();
    expect(reactivationBranchMatch![1]).toContain("router.replace(buildTetherLaunchPagePath(examId));");
    expect(reactivationBranchMatch![1]).not.toContain("setSecureClientEnforcementState");
    expect(reactivationBranchMatch![1]).not.toMatch(/active:\s*true,\s*ready:\s*false/);
  });

  it("v1.7.5 P0: a failed/malformed status fetch sets contentGateState to STATUS_UNAVAILABLE — it no longer re-asserts any native cover flag (the removed Task C anti-pattern)", () => {
    const catchStart = pageTsxSource.indexOf("fail closed WITHOUT asserting a native cover flag");
    expect(catchStart).toBeGreaterThan(-1);
    const catchBlock = pageTsxSource.slice(catchStart, catchStart + 800);
    expect(catchBlock).toContain('setContentGateState("STATUS_UNAVAILABLE")');
    expect(catchBlock).not.toContain("coveringState");
    expect(catchBlock).not.toContain("setSecureClientEnforcementState");
  });
});

describe("IPC chain hop 2: preload exposes the expected bridge", () => {
  it("exposes setSecureClientEnforcementState on window.sesLockdown, sending lockdown:set-secure-client-enforcement-state", () => {
    expect(preloadSource).toMatch(/setSecureClientEnforcementState\(state:/);
    expect(preloadSource).toMatch(/ipcRenderer\.send\("lockdown:set-secure-client-enforcement-state"/);
  });

  it("v1.7.5 P0: exposes the narrow, read-only getSecureClientEnforcementState via ipcRenderer.invoke — never a generic ipcRenderer passthrough", () => {
    expect(preloadSource).toMatch(/async getSecureClientEnforcementState\(\): Promise</);
    expect(preloadSource).toMatch(/ipcRenderer\.invoke\("lockdown:get-secure-client-enforcement-state"\)/);
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

  it("v1.7.5 P0 — registers a read-only lockdown:get-secure-client-enforcement-state handler returning ONLY displayEnforcement's own live enforcementState — never a second, independently-tracked copy", () => {
    expect(mainSource).toMatch(
      /ipcMain\.handle\("lockdown:get-secure-client-enforcement-state",\s*\(\)\s*=>\s*displayEnforcement\.getDiagnosticsSnapshot\(\)\.enforcementState\);/,
    );
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
    // v1.7.4 pre-exam readiness — the reason-aware replacement for
    // resolveReadinessGatedDisplayEnforcementState; see
    // displayEnforcementLogic.ts's DisplayDecision/DisplayBlockingReason.
    expect(displayEnforcementSource).toMatch(/resolveReadinessGatedDisplayDecision\(/);
  });
});

describe("IPC chain hop 5: the overlay BrowserWindow is created and shown", () => {
  it("evaluateNow shows the overlay on BLOCKED (except POLICY_NOT_READY) and hides it otherwise", () => {
    const evaluateNow = displayEnforcementSource.slice(
      displayEnforcementSource.indexOf("private async evaluateNow"),
      displayEnforcementSource.indexOf("private showOverlay"),
    );
    // v1.7.4 pre-exam readiness — showOverlay now takes the specific
    // DisplayBlockingReason (never a hardcoded, reason-blind overlay).
    // v1.7.5 P0 — isOverlayEligibleBlockingReason additionally excludes
    // POLICY_NOT_READY from ever reaching showOverlay at all (see
    // displayEnforcementLogic.test.ts / displayEnforcement.test.ts for
    // the full regression coverage).
    expect(evaluateNow).toMatch(
      /if \(nextDecision\.state === "BLOCKED" && isOverlayEligibleBlockingReason\(nextDecision\.reason\)\) this\.showOverlay\(nextDecision\.reason\);/,
    );
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

// ---------------------------------------------------------------------------
// Corrective pass v1.2.2, Tasks 1/2/3/5 — the real defect physical
// testing found: direct dashboard entry never established a verified
// session or activated the cover from the moment of entry. These assert
// the actual fix, not just the pre-existing v1.2.1 wiring above.
// ---------------------------------------------------------------------------

describe("Task 3 (superseded by v1.7.4 Phase 2) — exam-entry cover no longer activates early from the click", () => {
  // v1.7.4 pre-exam readiness — the old "cover the window the instant
  // runLaunchSequence starts, active:true/ready:false" mechanism (and its
  // uncoverOnFailure counterpart) is GONE. It existed because content
  // used to become reachable the moment this page navigated into it;
  // now content is genuinely unreachable server-side
  // (isSubmissionContentAccessible) until POST /activate succeeds, and
  // native lockdown only ever activates atomically (see the v1.7.4 Phase
  // 2 describe block below) — there is no more "loading" window that
  // needs a temporary, reason-blind cover. Removing it is also what
  // eliminates the confirmed BLOCKED==ADDITIONAL_DISPLAY_PRESENT false
  // positive from this page's own transition into the exam
  // (POLICY_NOT_READY can no longer appear here).
  it("runLaunchSequence no longer sets active:true,ready:false at all", () => {
    const fnStart = tetherLaunchSource.indexOf("async function runLaunchSequence(");
    const fnEnd = tetherLaunchSource.indexOf("async function ensureSecureActivation(");
    const fnBody = tetherLaunchSource.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/setSecureClientEnforcementState\?\.\(\{\s*active:\s*true,\s*ready:\s*false/);
  });

  it("uncoverOnFailure no longer exists — failures are handled by setError alone, never a client-side cover toggle", () => {
    expect(tetherLaunchSource).not.toMatch(/function uncoverOnFailure\(\)/);
    expect(tetherLaunchSource).not.toMatch(/uncoverOnFailure\(\)/);
  });
});

// ---------------------------------------------------------------------------
// v1.7.4 pre-exam readiness — Part 13A/E/F: the new Phase 2 secure-
// activation handshake. See docs/tether-preflight-lifecycle-v1.7.4.md.
// ---------------------------------------------------------------------------

describe("v1.7.4 Phase 2 — preload exposes a narrow activateSecureExamLockdown invoke, never a generic ipcRenderer passthrough", () => {
  it("preload.ts's activateSecureExamLockdown invokes exactly lockdown:activate-secure-exam-lockdown with only the two booleans", () => {
    const fnBody = preloadSource.slice(
      preloadSource.indexOf("async activateSecureExamLockdown("),
      preloadSource.indexOf("},", preloadSource.indexOf("async activateSecureExamLockdown(")),
    );
    expect(fnBody).toMatch(/ipcRenderer\.invoke\("lockdown:activate-secure-exam-lockdown"/);
    expect(fnBody).toMatch(/requireSingleDisplay:\s*Boolean\(params\.requireSingleDisplay\)/);
    expect(fnBody).toMatch(/requireRemoteSessionCheck:\s*Boolean\(params\.requireRemoteSessionCheck\)/);
  });
});

describe("v1.7.4 Phase 2 — main.ts's lockdown:activate-secure-exam-lockdown handler runs fresh checks BEFORE activating anything", () => {
  const handlerBody = mainSource.slice(
    mainSource.indexOf('ipcMain.handle("lockdown:activate-secure-exam-lockdown"'),
    mainSource.indexOf("});", mainSource.indexOf('return { ok: true, displayDecision: "OK", processDecision: "CLEAN" };')),
  );

  it("runs processDetection.runPreflightScan() — the SAME one-shot scan the calm PRECHECK screen uses, never a separate/looser check", () => {
    expect(handlerBody).toMatch(/processDetection\.runPreflightScan\(\)/);
  });

  it("runs a READ-ONLY display check (getOnDemandDisplayTopology) — never evaluateNowAndGetDecision — so a FAILED fresh check never flips the overlay on before activation", () => {
    expect(handlerBody).toMatch(/displayEnforcement\.getOnDemandDisplayTopology\(\)/);
    expect(handlerBody).not.toMatch(/evaluateNowAndGetDecision/);
  });

  it("only activates display enforcement, process detection, and remote-session monitoring AFTER every fresh check already passed", () => {
    const activationIdx = handlerBody.indexOf('displayEnforcement.setEnforcementState({ active: true, ready: true');
    const scanIdx = handlerBody.indexOf("processDetection.runPreflightScan()");
    expect(activationIdx).toBeGreaterThan(scanIdx);
    expect(handlerBody).toMatch(/processDetection\.setExamActive\(true\)/);
    expect(handlerBody).toMatch(/remoteSessionMonitor\.setExamActive\(true\)/);
    expect(handlerBody.indexOf("processDetection.setExamActive(true)")).toBeGreaterThan(activationIdx);
  });

  it("registers restoration via lockdownLifecycle.activate() as part of successful activation", () => {
    expect(handlerBody).toMatch(/lockdownLifecycle\.activate\(\)/);
  });

  it("a PROHIBITED_APPLICATION result carries the matched capability ids (never raw process names)", () => {
    expect(mainSource).toMatch(/reason:\s*"PROHIBITED_APPLICATION",\s*matchedCapabilityIds:\s*scan\.matchedCapabilityIds/);
  });
});

describe("v1.7.4 Phase 2 — tether-launch/page.tsx's ensureSecureActivation runs the native handshake BEFORE the server activation call, and never trusts a client-side boolean alone", () => {
  const fnBody = tetherLaunchSource.slice(
    tetherLaunchSource.indexOf("async function ensureSecureActivation("),
    tetherLaunchSource.indexOf("/**", tetherLaunchSource.indexOf("async function ensureSecureActivation(") + 50),
  );

  it("calls window.sesLockdown.activateSecureExamLockdown before POST /activate", () => {
    const nativeIdx = fnBody.indexOf("activateSecureExamLockdown(");
    const serverIdx = fnBody.indexOf("/activate`, { method: \"POST\" }");
    expect(nativeIdx).toBeGreaterThan(-1);
    expect(serverIdx).toBeGreaterThan(nativeIdx);
  });

  it("never navigates or calls POST /activate when the native result is not ok", () => {
    const failureBranch = fnBody.slice(fnBody.indexOf("if (!activation.ok)"), fnBody.indexOf("const activateRes"));
    expect(failureBranch).toMatch(/return false;/);
    expect(failureBranch).not.toMatch(/fetch\(/);
  });

  it("fails closed (never silently proceeds) when activateSecureExamLockdown itself is missing from an old build", () => {
    expect(fnBody).toMatch(/typeof window\.sesLockdown\?\.activateSecureExamLockdown !== "function"/);
    expect(fnBody).toMatch(/return false;/);
  });
});

describe("Task 1/2: the real launch flow establishes a genuinely VERIFIED session (not just a created one)", () => {
  it("runLaunchSequence submits an attestation immediately after a successful manifest consumption, before redirecting into the exam", () => {
    const consumeIdx = tetherLaunchSource.indexOf("launch_manifest_consumed_session_created");
    const redirectIdx = tetherLaunchSource.indexOf("router.replace(`/student/exams/${submission.id}`);", consumeIdx);
    const betweenConsumeAndRedirect = tetherLaunchSource.slice(consumeIdx, redirectIdx);
    expect(betweenConsumeAndRedirect).toMatch(/submitInitialAttestation\(consumed\.sessionId, submission\.id\)/);
  });

  it("submitInitialAttestation actually POSTs to the attestation endpoint (not a stub)", () => {
    const fnBody = tetherLaunchSource.slice(
      tetherLaunchSource.indexOf("async function submitInitialAttestation"),
      tetherLaunchSource.indexOf("/** Task 3"),
    );
    expect(fnBody).toMatch(/fetch\(`\/api\/secure-client\/sessions\/\$\{sessionId\}\/attestation`/);
    expect(fnBody).toMatch(/method:\s*"POST"/);
  });
});

describe("Task 5: direct dashboard entry routes through the same /tether-launch page a protocol launch uses", () => {
  it("the dashboard computes an examEntryHref/continueEntryHref that resolves to the tether-launch path when inside Tether", () => {
    expect(dashboardSource).toMatch(/isRunningInLockdownBrowser/);
    expect(dashboardSource).toMatch(/buildTetherLaunchPagePath\(examId\)/);
  });

  it("both the Start-exam and Continue links use the Tether-aware href functions, not a hardcoded join/submission path", () => {
    expect(dashboardSource).toMatch(/href=\{examEntryHref\(exam\.id\)\}/);
    expect(dashboardSource).toMatch(/href=\{continueEntryHref\(exam\.id, exam\.submission\.id\)\}/);
  });
});
