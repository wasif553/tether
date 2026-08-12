/**
 * P0 secure-launch redirect loop hotfix — regression tests. See
 * docs/tether-secure-launch-loop-hotfix.md.
 *
 * No DOM/testing-library dependency in this repo (see the established
 * pattern in src/components/ManualReviewNotice.test.tsx's own doc
 * comment) — `InsideTetherLaunchFlow` is a stateful component using
 * hooks, so it cannot be called directly like a pure function outside a
 * real React render either. These tests instead do two things:
 *
 *  1. Behaviorally test the extracted, pure decision function
 *     (isSecureClientSessionVerified) directly — see
 *     src/lib/tetherLaunch.test.ts for the full case coverage (cases 1,
 *     3, 4, 9, 10, 16 from the P0 task's regression list).
 *  2. Source-level structural assertions here, proving the DANGEROUS
 *     pattern that caused the physical loop is gone, and the SAFE
 *     pattern is in place — the same technique this file's neighboring
 *     precedent (ManualReviewNotice.test.tsx's own last test) already
 *     uses for exactly this class of regression.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

/**
 * Extracts the body of `function name(...) { ... }` by brace-matching, so
 * assertions below are scoped to it specifically and can't accidentally
 * match unrelated code elsewhere in the file. Searches for the opening
 * brace starting AFTER the end of `signature`, not from its start — a
 * function whose return type annotation itself contains braces (e.g.
 * `Promise<{ submitted: boolean }>`) would otherwise have its body
 * search anchored on the return-type's own brace instead of the real
 * body.
 */
function extractFunctionBody(fnSource: string, signature: string): string {
  const start = fnSource.indexOf(signature);
  if (start === -1) throw new Error(`Could not find "${signature}" in source`);
  const braceStart = fnSource.indexOf("{", start + signature.length);
  let depth = 0;
  for (let i = braceStart; i < fnSource.length; i++) {
    if (fnSource[i] === "{") depth++;
    if (fnSource[i] === "}") {
      depth--;
      if (depth === 0) return fnSource.slice(braceStart, i + 1);
    }
  }
  throw new Error(`Unbalanced braces extracting "${signature}"`);
}

const runLaunchSequenceBody = extractFunctionBody(source, "async function runLaunchSequence(");

describe("runLaunchSequence — the dangerous pre-fix pattern must never reappear", () => {
  it("[5] never calls router.replace(`/student/exams/...`) immediately after submitInitialAttestation without an authoritative verification check in between", () => {
    // The pre-fix bug: attestation was submitted, then router.replace
    // followed unconditionally. Post-fix, every router.replace into exam
    // content in this function must be preceded (anywhere earlier in the
    // function body) by a call to checkAuthoritativeSessionVerified.
    const attestationCallIndex = runLaunchSequenceBody.indexOf("submitInitialAttestation(");
    const authoritativeCheckIndex = runLaunchSequenceBody.indexOf("checkAuthoritativeSessionVerified(");
    expect(attestationCallIndex).toBeGreaterThan(-1);
    expect(authoritativeCheckIndex).toBeGreaterThan(-1);
    expect(authoritativeCheckIndex).toBeGreaterThan(attestationCallIndex);

    // The navigation call after attestation must come AFTER the
    // authoritative check, not before it.
    const replaceCallsAfterAttestation = [...runLaunchSequenceBody.matchAll(/router\.replace\(/g)].map((m) => m.index!).filter((i) => i > attestationCallIndex);
    expect(replaceCallsAfterAttestation.length).toBeGreaterThan(0);
    for (const idx of replaceCallsAfterAttestation) {
      expect(idx).toBeGreaterThan(authoritativeCheckIndex);
    }
  });

  it("[6] a failed authoritative check sets a stable, non-accusatory error message and does not navigate", () => {
    const checkIndex = runLaunchSequenceBody.indexOf("checkAuthoritativeSessionVerified(");
    const afterCheck = runLaunchSequenceBody.slice(checkIndex);
    expect(afterCheck).toMatch(/if\s*\(!verified\)/);
    expect(afterCheck).toContain("Tether could not verify this secure exam session");
    // The failure branch must return before reaching any router.replace
    // — verified by the branch containing `return;` before the next
    // occurrence of router.replace at the top level.
    const failureBranchMatch = afterCheck.match(/if\s*\(!verified\)\s*\{([\s\S]*?)\n\s*\}/);
    expect(failureBranchMatch).not.toBeNull();
    expect(failureBranchMatch![1]).toContain("return");
    expect(failureBranchMatch![1]).not.toContain("router.replace");
  });

  // v1.7.4 pre-exam readiness — uncoverOnFailure() and its early,
  // speculative setSecureClientEnforcementState({active:true,ready:false})
  // cover no longer exist (see docs/tether-preflight-lifecycle-v1.7.4.md).
  // Native lockdown is never activated speculatively before verification
  // succeeds — it only ever activates atomically, inside
  // ensureSecureActivation, once every fresh Phase 2 check has already
  // passed — so there is nothing to "release" on a failed authoritative
  // check: this test now proves the failure branch is a plain, terminal
  // setError+return with no enforcement-toggling side effect at all.
  it("[15] a failed authoritative check sets an error and returns — no enforcement-toggling side effect (uncoverOnFailure no longer exists anywhere in this file)", () => {
    const checkIndex = runLaunchSequenceBody.indexOf("checkAuthoritativeSessionVerified(");
    const failureBranchMatch = runLaunchSequenceBody.slice(checkIndex).match(/if\s*\(!verified\)\s*\{([\s\S]*?)\n\s*\}/);
    expect(failureBranchMatch![1]).toContain("setError(");
    expect(failureBranchMatch![1]).toContain("return");
    expect(source).not.toContain("uncoverOnFailure");
    expect(source).not.toMatch(/setSecureClientEnforcementState\?\.\(\{\s*active:\s*true,\s*ready:\s*false/);
  });

  it("[12] every router.replace call in this function is guarded by an unmountedRef check immediately before it — a stale in-flight attempt can never navigate after the student has left the page", () => {
    const replaceMatches = [...runLaunchSequenceBody.matchAll(/router\.replace\(/g)];
    expect(replaceMatches.length).toBeGreaterThanOrEqual(2); // the ALLOW-path replace and the verified-path replace
    for (const match of replaceMatches) {
      const precedingSlice = runLaunchSequenceBody.slice(Math.max(0, match.index! - 200), match.index!);
      expect(precedingSlice).toMatch(/if\s*\(unmountedRef\.current\)\s*return;/);
    }
  });

  it("never reintroduces a bare, unconditional exam-content router.replace with no preceding gate at all", () => {
    // Defensive: every router.replace target in this file must be
    // preceded somewhere earlier in the same function by EITHER the
    // authoritative check or the (also-authoritative) `kind === "ALLOW"`
    // branch from POST /start — never neither.
    const hasAllowGate = runLaunchSequenceBody.includes('secureClientLaunch.kind === "ALLOW"');
    const hasAuthoritativeGate = runLaunchSequenceBody.includes("checkAuthoritativeSessionVerified(");
    expect(hasAllowGate).toBe(true);
    expect(hasAuthoritativeGate).toBe(true);
  });
});

// v1.7.4 pre-exam readiness — Part 13A: PHASE 1 PRECHECK never creates a
// submission, never starts a timer, and never auto-starts the exam even
// once clean. See docs/tether-preflight-lifecycle-v1.7.4.md.
describe("v1.7.4 Phase 1 PRECHECK — no submission/timer until an explicit Begin examination", () => {
  const runPrecheckBody = extractFunctionBody(source, "async function runPrecheck(");

  it("runPrecheck never calls fetch(`/api/exams/${examId}/start`) — no submission is ever created during precheck", () => {
    expect(runPrecheckBody).not.toMatch(/fetch\(`\/api\/exams\/\$\{examId\}\/start`/);
  });

  it("the Start-exam button only ever calls runPrecheck, never runLaunchSequence directly — precheck becoming clean sets precheckPassed, it never auto-launches", () => {
    const startButtonIdx = source.indexOf('{precheckChecking ? "Checking…" : "Start exam"}');
    const precedingSlice = source.slice(Math.max(0, startButtonIdx - 800), startButtonIdx);
    expect(precedingSlice).toMatch(/void runPrecheck\(/);
    expect(precedingSlice).toMatch(/setPrecheckPassed\(true\)/);
    expect(precedingSlice).not.toMatch(/void runLaunchSequence\(/);
  });

  it("the 'Ready to begin' screen's Begin examination button is the only thing that calls runLaunchSequence for a fresh (non-resume) attempt", () => {
    const readyScreenIdx = source.indexOf('<h1 className="text-lg font-medium">Ready to begin</h1>');
    const beginButtonSlice = source.slice(readyScreenIdx, readyScreenIdx + 500);
    expect(beginButtonSlice).toMatch(/void runLaunchSequence\(accessCode \|\| null\)/);
    expect(beginButtonSlice).toContain("Begin examination");
  });

  it("a BLOCKED process scan and a genuine display-topology issue both route through the SAME unified precheckIssue state — never two separate UI paths", () => {
    expect(runPrecheckBody).toMatch(/setPrecheckIssue\(\{/);
    expect(runPrecheckBody).toMatch(/setPrecheckIssue\(issue\)/);
  });
});

// v1.7.4 pre-exam readiness — Part 13E/F: PHASE 2 ordering. See
// docs/tether-preflight-lifecycle-v1.7.4.md's required ordering diagram.
describe("v1.7.4 Phase 2 — ensureSecureActivation runs strictly after verification and strictly before navigation", () => {
  it("runLaunchSequence calls ensureSecureActivation only after verified is true, and never navigates unless ensureSecureActivation returned true", () => {
    const verifiedCheckIdx = runLaunchSequenceBody.indexOf("if (!verified) {");
    const activationCallIdx = runLaunchSequenceBody.indexOf("ensureSecureActivation(submission.id)");
    const finalReplaceIdx = runLaunchSequenceBody.lastIndexOf("router.replace(`/student/exams/${submission.id}`);");
    expect(verifiedCheckIdx).toBeGreaterThan(-1);
    expect(activationCallIdx).toBeGreaterThan(verifiedCheckIdx);
    expect(finalReplaceIdx).toBeGreaterThan(activationCallIdx);
    expect(runLaunchSequenceBody).toMatch(/const activated = await ensureSecureActivation\(submission\.id\);\s*\n\s*if \(!activated\) return;/);
  });
});

// PR #22 follow-up review, Issue 2 — a missing/failed/malformed
// secure-client/status response must never silently disable a mandatory
// display/remote-session check. See src/lib/tetherLaunch.ts's
// parseSecureClientStatusForActivation for the pure-function coverage of
// the validation logic itself; these tests prove ensureSecureActivation
// actually refuses to call activateSecureExamLockdown at all when
// validation fails, and passes through the true validated values when it
// succeeds.
describe("PR #22 follow-up, Issue 2 — ensureSecureActivation never calls activateSecureExamLockdown without a validated secure-client/status", () => {
  const ensureSecureActivationBodyForStatus = extractFunctionBody(source, "async function ensureSecureActivation(submissionId: string): Promise<boolean> ");

  it("REQUIRED TESTS 1-3: the validation-failure branch returns false BEFORE the activateSecureExamLockdown call ever appears in the function", () => {
    const validationFailIdx = ensureSecureActivationBodyForStatus.indexOf("if (!validatedStatus) {");
    const activateCallIdx = ensureSecureActivationBodyForStatus.indexOf("window.sesLockdown.activateSecureExamLockdown(");
    expect(validationFailIdx).toBeGreaterThan(-1);
    expect(activateCallIdx).toBeGreaterThan(validationFailIdx);
    const failureBranchMatch = ensureSecureActivationBodyForStatus.match(/if \(!validatedStatus\) \{([\s\S]*?)\n\s*\}/);
    expect(failureBranchMatch).not.toBeNull();
    expect(failureBranchMatch![1]).toContain("return false;");
    expect(failureBranchMatch![1]).not.toContain("activateSecureExamLockdown");
  });

  it("REQUIRED TESTS 1-3: never defaults requireSingleDisplay/requireRemoteSessionCheck to false via optional chaining on a possibly-null status — the raw fetch body is validated FIRST via parseSecureClientStatusForActivation, and destructured only from its non-null result", () => {
    expect(ensureSecureActivationBodyForStatus).toMatch(/const validatedStatus = parseSecureClientStatusForActivation\(statusBody\);/);
    expect(ensureSecureActivationBodyForStatus).toMatch(/const \{ requireSingleDisplay, requireRemoteSessionCheck \} = validatedStatus;/);
    // The dangerous pre-fix pattern (`status?.displayRequirement?.status === ...`,
    // silently yielding false for a missing/failed status) must never
    // reappear.
    expect(ensureSecureActivationBodyForStatus).not.toMatch(/status\?\.displayRequirement\?\.status/);
    expect(ensureSecureActivationBodyForStatus).not.toMatch(/status\?\.requireRemoteSessionCheck/);
  });

  it("a thrown fetch exception is caught and also routes through the SAME validation-failure path (statusBody stays null, parseSecureClientStatusForActivation(null) is null)", () => {
    const tryBlockMatch = ensureSecureActivationBodyForStatus.match(/try \{([\s\S]*?)\n\s*\} catch \{([\s\S]*?)\n\s*\}/);
    expect(tryBlockMatch).not.toBeNull();
    expect(tryBlockMatch![2]).toContain("statusBody = null;");
  });

  it("REQUIRED TESTS 4-5: the validated requireSingleDisplay/requireRemoteSessionCheck values are passed straight through to activateSecureExamLockdown, unmodified", () => {
    expect(ensureSecureActivationBodyForStatus).toMatch(
      /activateSecureExamLockdown\(\{ requireSingleDisplay, requireRemoteSessionCheck \}\)/,
    );
  });

  it("the validation-failure screen is an ordinary, known-safe PreflightIssue (resolveSecureClientStatusUnavailableIssue) — native lockdown was never touched, so Recheck/Return to dashboard are both genuinely safe here", () => {
    const failureBranchMatch = ensureSecureActivationBodyForStatus.match(/if \(!validatedStatus\) \{([\s\S]*?)\n\s*\}/);
    expect(failureBranchMatch![1]).toContain("setPrecheckIssue(resolveSecureClientStatusUnavailableIssue());");
    expect(failureBranchMatch![1]).toContain("setPrecheckPassed(false);");
  });
});

// PR #22 follow-up review — secure-activation failure reconciliation,
// Issue 1 fix. See src/lib/tetherLaunch.ts's classifyActivatePostOutcome/
// classifyReconciliationCheck for the pure-function coverage of the
// classification logic itself; these tests prove ensureSecureActivation is
// actually WIRED to call restoreLockdownControls in exactly the right
// branches (and never in the wrong ones), and that the UNDETERMINED case
// no longer has ANY path — including unmount — that could restore native
// lockdown speculatively.
describe("PR #22 follow-up — ensureSecureActivation restores native lockdown on a definitive non-activation, never on success or genuine uncertainty", () => {
  const ensureSecureActivationBody = extractFunctionBody(source, "async function ensureSecureActivation(submissionId: string): Promise<boolean> ");
  const reconcileBody = extractFunctionBody(
    source,
    'async function reconcileServerActivationState(submissionId: string): Promise<"ACTIVATED" | "NOT_ACTIVATED" | "UNDETERMINED"> ',
  );
  const retryBody = extractFunctionBody(source, "async function retryActivationConfirmation() ");

  it("REQUIRED TEST 10: the immediate activateRes.ok success branch returns true directly and never calls restoreLockdownControls", () => {
    const successBranchMatch = ensureSecureActivationBody.match(/if \(activateRes\.ok\) \{([\s\S]*?)\n\s*\}/);
    expect(successBranchMatch).not.toBeNull();
    expect(successBranchMatch![1]).toContain("return true;");
    expect(successBranchMatch![1]).not.toContain("restoreLockdownControls");
  });

  it("REQUIRED TEST 8: an AMBIGUOUS-then-NOT_ACTIVATED or DEFINITIVE_REJECTION outcome falls through to a single restoreLockdownControls call, textually before the final return false", () => {
    const restoreIdx = ensureSecureActivationBody.indexOf('restoreLockdownControls?.("secure-activation-server-not-confirmed")');
    const finalReturnIdx = ensureSecureActivationBody.lastIndexOf("return false;");
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(finalReturnIdx).toBeGreaterThan(restoreIdx);
    // Exactly one restore call site in this function — no duplicate/divergent path.
    expect((ensureSecureActivationBody.match(/restoreLockdownControls\?\.\(/g) ?? []).length).toBe(1);
  });

  it("REQUIRED TEST 9: the reconciliation-ACTIVATED branch returns true and does not reach the restoreLockdownControls call", () => {
    const activatedBranchMatch = ensureSecureActivationBody.match(/if \(reconciliation === "ACTIVATED"\) \{([\s\S]*?)\n\s*\}/);
    expect(activatedBranchMatch).not.toBeNull();
    expect(activatedBranchMatch![1]).toContain("return true;");
    expect(activatedBranchMatch![1]).not.toContain("restoreLockdownControls");
  });

  it("REQUIRED TEST 7: the reconciliation-UNDETERMINED branch returns false WITHOUT calling restoreLockdownControls, and routes to activationConfirmationPending state — NEVER setPrecheckIssue (which would offer the unsafe ordinary Return-to-dashboard path)", () => {
    const undeterminedBranchMatch = ensureSecureActivationBody.match(/if \(reconciliation === "UNDETERMINED"\) \{([\s\S]*?)\n\s*\}/);
    expect(undeterminedBranchMatch).not.toBeNull();
    expect(undeterminedBranchMatch![1]).toContain("setActivationConfirmationPending({ submissionId });");
    expect(undeterminedBranchMatch![1]).toContain("return false;");
    expect(undeterminedBranchMatch![1]).not.toContain("restoreLockdownControls");
    expect(undeterminedBranchMatch![1]).not.toContain("setPrecheckIssue");
  });

  it("an AMBIGUOUS outcome is resolved via reconcileServerActivationState BEFORE any restore/issue decision is made — never guessed", () => {
    const ambiguousIdx = ensureSecureActivationBody.indexOf('outcome.kind === "AMBIGUOUS"');
    const reconcileCallIdx = ensureSecureActivationBody.indexOf("reconcileServerActivationState(submissionId)");
    const restoreIdx = ensureSecureActivationBody.indexOf('restoreLockdownControls?.("secure-activation-server-not-confirmed")');
    expect(ambiguousIdx).toBeGreaterThan(-1);
    expect(reconcileCallIdx).toBeGreaterThan(ambiguousIdx);
    expect(restoreIdx).toBeGreaterThan(reconcileCallIdx);
  });

  it("REQUIRED TEST 5: reconcileServerActivationState retries a bounded number of times and returns UNDETERMINED only after exhausting them — never a single-shot guess", () => {
    expect(reconcileBody).toMatch(/RECONCILIATION_ATTEMPTS/);
    expect(reconcileBody).toMatch(/for \(let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt\+\+\)/);
    expect(reconcileBody).toMatch(/return "UNDETERMINED";\s*\n\s*\}\s*$/);
  });

  it("reconcileServerActivationState never calls restoreLockdownControls or navigates itself — a pure, read-only, side-effect-free status check", () => {
    expect(reconcileBody).not.toContain("restoreLockdownControls");
    expect(reconcileBody).not.toContain("router.replace");
    expect(reconcileBody).toContain("/secure-client/status");
    expect(reconcileBody).not.toMatch(/method:\s*"POST"/);
  });

  it("REQUIRED TEST 8 / requirement: retrying after a definitive restore goes through the SAME Recheck -> Begin examination -> runLaunchSequence path as every other precheck failure — set via setPrecheckIssue + setPrecheckPassed(false), never a bespoke retry mechanism", () => {
    expect(ensureSecureActivationBody).toMatch(/setPrecheckIssue\(resolveServerActivationNotConfirmedIssue\(\)\);\s*\n\s*setPrecheckPassed\(false\);/);
  });

  it("retryActivationConfirmation only ever calls reconcileServerActivationState — never activateSecureExamLockdown or POST /activate again", () => {
    expect(retryBody).toContain("reconcileServerActivationState(submissionId)");
    expect(retryBody).not.toContain("activateSecureExamLockdown");
    expect(retryBody).not.toMatch(/fetch\(`\/api\/submissions\/\$\{submissionId\}\/activate`/);
  });

  it("REQUIRED TEST 9 (retry path): retryActivationConfirmation's ACTIVATED branch navigates directly into the exam and clears the pending state, without ever calling restoreLockdownControls", () => {
    const activatedBranchMatch = retryBody.match(/if \(reconciliation === "ACTIVATED"\) \{([\s\S]*?)\n\s*\}/);
    expect(activatedBranchMatch).not.toBeNull();
    expect(activatedBranchMatch![1]).toContain("router.replace(`/student/exams/${submissionId}`)");
    expect(activatedBranchMatch![1]).not.toContain("restoreLockdownControls");
  });

  it("REQUIRED TEST 8 (retry path): retryActivationConfirmation's NOT_ACTIVATED branch restores native lockdown and returns to the ordinary retryable screen", () => {
    const notActivatedBranchMatch = retryBody.match(/if \(reconciliation === "NOT_ACTIVATED"\) \{([\s\S]*?)\n\s*\}/);
    expect(notActivatedBranchMatch).not.toBeNull();
    expect(notActivatedBranchMatch![1]).toContain('restoreLockdownControls?.("secure-activation-server-not-confirmed")');
    expect(notActivatedBranchMatch![1]).toContain("setPrecheckIssue(resolveServerActivationNotConfirmedIssue());");
  });
});

// PR #22 follow-up review, Issue 1 — the unsafe unconditional
// unmount-restore effect from the previous commit has been REMOVED
// entirely (not merely guarded) — restoring native lockdown is NEVER
// safe based solely on "this component unmounted", since the server may
// have already committed activation before its response was lost. These
// tests prove that dangerous pattern cannot silently reappear.
describe("PR #22 follow-up — no code path restores native lockdown merely because the renderer unmounted", () => {
  it("the string 'nativeActivationPendingServerConfirmationRef' (the removed, unsafe ref) no longer appears anywhere in this file", () => {
    expect(source).not.toContain("nativeActivationPendingServerConfirmationRef");
  });

  it("'tether-launch-unmount-during-pending-activation' (the removed unmount-restore trigger string) no longer appears anywhere in this file", () => {
    expect(source).not.toContain("tether-launch-unmount-during-pending-activation");
  });

  it("the pre-existing unmountedRef cleanup effect is untouched by this fix — still exactly `{ unmountedRef.current = true; }`, with no second statement added to it", () => {
    expect(source).toMatch(/return\s*\(\)\s*=>\s*\{\s*unmountedRef\.current = true;\s*\};/);
  });

  it("restoreLockdownControls is called from exactly two places in this file: ensureSecureActivation's definitive-non-activation path, and retryActivationConfirmation's NOT_ACTIVATED path — never from any useEffect cleanup", () => {
    const allRestoreCalls = [...source.matchAll(/restoreLockdownControls\?\.\(/g)];
    // Plus the pre-existing, unrelated exam-page-unmount / submission-completed
    // calls do NOT exist in this file (they belong to the exam content
    // page) — every call here is one of this fix's own two sites.
    expect(allRestoreCalls.length).toBe(2);
  });
});

describe("PR #22 follow-up — the dedicated ACTIVATION_CONFIRMATION_PENDING screen never offers an ordinary Return-to-dashboard navigation", () => {
  it("REQUIRED TEST 7: the render branch for activationConfirmationPending uses ActivationConfirmationPending, never LockdownApplicationCheck", () => {
    const branchIdx = source.indexOf("if (activationConfirmationPending) {");
    expect(branchIdx).toBeGreaterThan(-1);
    const branchSlice = source.slice(branchIdx, branchIdx + 500);
    expect(branchSlice).toContain("<ActivationConfirmationPending");
    expect(branchSlice).not.toContain("<LockdownApplicationCheck");
  });

  it("this branch is checked BEFORE precheckIssue in render order — it must take priority so an UNDETERMINED state is never momentarily shown as an ordinary, safe-looking precheck screen", () => {
    const pendingBranchIdx = source.indexOf("if (activationConfirmationPending) {");
    const precheckIssueBranchIdx = source.indexOf("if (precheckIssue) {");
    expect(pendingBranchIdx).toBeGreaterThan(-1);
    expect(precheckIssueBranchIdx).toBeGreaterThan(pendingBranchIdx);
  });

  it("ActivationConfirmationPending.tsx itself contains no href/Link to the dashboard — the ordinary escape route is structurally absent, not just unused here", () => {
    const componentSource = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "components", "ActivationConfirmationPending.tsx"), "utf8");
    expect(componentSource).not.toMatch(/href=/);
  });
});

describe("PR #22 — requirement 7: the exam CONTENT page's during-exam enforcement is untouched by this fix", () => {
  it("this fix only modifies tether-launch/page.tsx and its supporting library — the exam content page's own strict enforcement code is unchanged", () => {
    const contentPageSource = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
    // The pre-activation gap this PR fixes is specific to tether-launch's
    // ensureSecureActivation — the content page never calls
    // activateSecureExamLockdown or POST /activate at all (it is only
    // ever reached AFTER both have already succeeded), so it has no
    // reconciliation concept to wire up in the first place.
    expect(contentPageSource).not.toContain("reconcileServerActivationState");
    expect(contentPageSource).not.toContain("classifyActivatePostOutcome");
  });
});

describe("mount effect — auto-resume guards [1, 8, 10]", () => {
  // The mount effect is identified by its unique marker
  // (`existingSubmission?.status === "IN_PROGRESS"` appears only once,
  // inside InsideTetherLaunchFlow's mount effect — OutsideTetherPrompt
  // has no such check) rather than brace-matching from `useEffect(`,
  // since this file has multiple `useEffect(() => {` blocks and exact
  // whitespace-sensitive string matching on the opening signature proved
  // too brittle.
  const markerIndex = source.indexOf('existingSubmission?.status === "IN_PROGRESS" && !autoAttemptedRef.current');
  const mountEffectBody = (() => {
    if (markerIndex === -1) throw new Error("Could not locate the mount effect's IN_PROGRESS auto-resume marker");
    const effectStart = source.lastIndexOf("useEffect(() => {", markerIndex);
    const effectDepsEnd = source.indexOf("}, [examId]);", markerIndex);
    return source.slice(effectStart, effectDepsEnd);
  })();

  it("[10] checks MANUAL_REVIEW_REQUIRED before ever calling runLaunchSequence, and returns early if required", () => {
    const manualReviewIndex = mountEffectBody.indexOf("checkManualReviewRequired(");
    const launchIndex = mountEffectBody.indexOf("void runLaunchSequence(");
    expect(manualReviewIndex).toBeGreaterThan(-1);
    expect(launchIndex).toBeGreaterThan(-1);
    expect(manualReviewIndex).toBeLessThan(launchIndex);
    expect(mountEffectBody).toMatch(/if\s*\(requiresManualReview\)\s*\{[\s\S]*?setManualReview\(true\);[\s\S]*?return;/);
  });

  it("[1, 8] the auto-resume path is guarded by autoAttemptedRef, set to true before the one auto-launch attempt — the mount effect can never fire a second automatic attempt", () => {
    expect(mountEffectBody).toContain("!autoAttemptedRef.current");
    const guardIndex = mountEffectBody.indexOf("!autoAttemptedRef.current");
    const setIndex = mountEffectBody.indexOf("autoAttemptedRef.current = true");
    const launchIndex = mountEffectBody.indexOf("void runLaunchSequence(");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(setIndex).toBeGreaterThan(-1);
    expect(setIndex).toBeLessThan(launchIndex);
  });

  it("[8] the auto-launch is also guarded against firing after unmount", () => {
    const launchIndex = mountEffectBody.indexOf("void runLaunchSequence(");
    const precedingSlice = mountEffectBody.slice(0, launchIndex);
    expect(precedingSlice).toMatch(/if\s*\(unmountedRef\.current\)\s*return;/);
  });
});

describe("manual retry [7]", () => {
  it("the 'Try again' retry button in the busy/error view calls runLaunchSequence directly, never gated by autoAttemptedRef", () => {
    expect(source).toMatch(/onClick=\{\(\)\s*=>\s*void runLaunchSequence\(accessCode \|\| null\)\}/);
  });

  it("P0 retest fix: the failed-verification retry button says 'Try again', never the installer-fallback copy 'I have installed it — open examination' (misleading here — the student is already inside Tether)", () => {
    const busyErrorViewStart = source.indexOf('result.existingSubmission?.status === "IN_PROGRESS" || busy');
    const busyErrorViewEnd = source.indexOf("return (", busyErrorViewStart) + 2000;
    const busyErrorView = source.slice(busyErrorViewStart, busyErrorViewEnd);
    expect(busyErrorView).toContain("Try again");
    expect(busyErrorView).not.toContain("I have installed it — open examination");
  });
});

describe("unmount cleanup", () => {
  it("sets unmountedRef.current = true on unmount, and it starts false", () => {
    expect(source).toMatch(/const unmountedRef = useRef\(false\);/);
    expect(source).toMatch(/return\s*\(\)\s*=>\s*\{\s*unmountedRef\.current = true;\s*\};/);
  });
});

describe("unrelated flows left untouched by this hotfix", () => {
  it("the deep-link / installer-fallback flow (OutsideTetherPrompt) is unchanged in shape — still builds the tether:// deep link and shows the installer fallback after a timeout", () => {
    expect(source).toContain("buildTetherDeepLink(examId)");
    expect(source).toContain("shouldShowInstallerFallback(");
  });

  it("V2 attestation remains best-effort and is never used to gate navigation (LEGACY mode policy unchanged)", () => {
    const v2CallIndex = runLaunchSequenceBody.indexOf("submitExamSessionAttestationV2(");
    expect(v2CallIndex).toBeGreaterThan(-1);
    // No `if` branching on its return value anywhere nearby — it's
    // called and awaited only for its side effect (recording evidence),
    // never inspected. The doc comment immediately preceding the
    // function (not the body itself) documents this design intent.
    const docCommentStart = source.lastIndexOf("/**", source.indexOf("async function submitExamSessionAttestationV2("));
    const docComment = source.slice(docCommentStart, source.indexOf("async function submitExamSessionAttestationV2("));
    expect(docComment).toContain("Every failure path here is silent by");
  });
});

// P0 runtime display-bridge failure capture — see
// docs/tether-secure-launch-verification-investigation.md. Structural
// proof that submitInitialAttestation is wired to the pure
// classification helpers (unit-tested directly in tetherLaunch.test.ts)
// correctly, and that displayCount/displayDiagnostic reach the
// attestation request body — covering cases 1-3, 5-7 at the integration
// level (the underlying classification logic itself is covered
// exhaustively, without a DOM, in tetherLaunch.test.ts).
describe("submitInitialAttestation — display-bridge diagnostic wiring [1, 2, 3, 5, 6, 7]", () => {
  // The full signature (through the return type annotation) is used as
  // the anchor — see extractFunctionBody's own doc comment for why a
  // bare "functionName(" anchor would incorrectly match the brace inside
  // this function's own `Promise<{ submitted: boolean }>` return type.
  const submitInitialAttestationBody = extractFunctionBody(
    source,
    "async function submitInitialAttestation(sessionId: string, submissionId: string): Promise<{ submitted: boolean }> ",
  );

  it("declares resolvedDisplayCount and displayDiagnostic, both defaulting to null (never fabricated)", () => {
    expect(submitInitialAttestationBody).toMatch(/let resolvedDisplayCount: number \| null = null;/);
    expect(submitInitialAttestationBody).toMatch(/let displayDiagnostic: DisplayDiagnostic \| null = null;/);
  });

  it("[1, 2] classifies bridge availability via the shared, unit-tested classifyDisplayBridgeAvailability helper — never a bespoke inline re-check", () => {
    const classifyIndex = submitInitialAttestationBody.indexOf("classifyDisplayBridgeAvailability(window.sesLockdown)");
    expect(classifyIndex).toBeGreaterThan(-1);
    expect(submitInitialAttestationBody).toContain('"SES_LOCKDOWN_UNAVAILABLE"');
    expect(submitInitialAttestationBody).toContain('"DISPLAY_COUNT_METHOD_UNAVAILABLE"');
  });

  it("[4] validates the resolved value via the SAME isValidReportedDisplayCount the server uses, before ever setting checks.displayCheck — an invalid value can never become PASS", () => {
    const validateIndex = submitInitialAttestationBody.indexOf("isValidReportedDisplayCount(rawDisplayCount)");
    const checksAssignIndex = submitInitialAttestationBody.indexOf("checks.displayCheck = rawDisplayCount <= 1");
    const invalidOutcomeIndex = submitInitialAttestationBody.indexOf('"DISPLAY_COUNT_INVALID_RESULT"');
    expect(validateIndex).toBeGreaterThan(-1);
    expect(checksAssignIndex).toBeGreaterThan(validateIndex);
    expect(invalidOutcomeIndex).toBeGreaterThan(validateIndex);
  });

  it("[3] a thrown/rejected bridge call is captured via buildDisplayInvokeFailedDiagnostic — never a bespoke inline error-message construction", () => {
    expect(submitInitialAttestationBody).toMatch(/catch \(err\) \{\s*displayDiagnostic = buildDisplayInvokeFailedDiagnostic\(err\);/);
  });

  it("[1, 2, 3] resolvedDisplayCount is set ONLY inside the DISPLAY_COUNT_OK success path — every failure classification (SES_LOCKDOWN_UNAVAILABLE, DISPLAY_COUNT_METHOD_UNAVAILABLE, DISPLAY_COUNT_INVOKE_FAILED, DISPLAY_COUNT_INVALID_RESULT) leaves it null", () => {
    const okAssignIndex = submitInitialAttestationBody.indexOf('displayDiagnostic = { outcome: "DISPLAY_COUNT_OK" };');
    const countAssignIndex = submitInitialAttestationBody.indexOf("resolvedDisplayCount = rawDisplayCount;");
    expect(okAssignIndex).toBeGreaterThan(-1);
    expect(countAssignIndex).toBeGreaterThan(-1);
    // The count assignment must come before the OK-outcome assignment,
    // both inside the same success branch — and nowhere else in the
    // function sets resolvedDisplayCount.
    expect(countAssignIndex).toBeLessThan(okAssignIndex);
    const allAssignments = [...submitInitialAttestationBody.matchAll(/resolvedDisplayCount = /g)];
    expect(allAssignments).toHaveLength(1);
  });

  it("[5, 6, 7] both displayCount and displayDiagnostic reach the attestation request body, alongside (never replacing) checks/required — the diagnostic can only ever be additive evidence", () => {
    expect(submitInitialAttestationBody).toMatch(/displayCount:\s*resolvedDisplayCount\s*\?\?\s*undefined,/);
    expect(submitInitialAttestationBody).toMatch(/displayDiagnostic:\s*displayDiagnostic\s*\?\?\s*undefined,/);
    expect(submitInitialAttestationBody).toContain("checks,");
    expect(submitInitialAttestationBody).toContain("required: requireDisplayCheck");
  });
});

describe("recordAttestation source — displayCount in the production diagnostic [4, 5]", () => {
  const secureClientRunnerSource = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "lib", "secureClientRunner.ts"), "utf8");
  const recordAttestationBody = extractFunctionBody(secureClientRunnerSource, "export async function recordAttestation(");

  it("[4] the not-reached-VERIFIED diagnostic includes the bounded, already-validated displayCount variable — never a raw/unvalidated client value", () => {
    const diagnosticIndex = recordAttestationBody.indexOf('console.error("recordAttestation: session did not reach VERIFIED"');
    expect(diagnosticIndex).toBeGreaterThan(-1);
    const diagnosticCallEnd = recordAttestationBody.indexOf(");", diagnosticIndex);
    const diagnosticPayload = recordAttestationBody.slice(diagnosticIndex, diagnosticCallEnd);
    expect(diagnosticPayload).toMatch(/\bdisplayCount,/);
    // Must reuse the SAME `displayCount` local (validated via
    // isValidReportedDisplayCount earlier in the function) — never
    // `input.displayCount` directly, which would bypass validation.
    expect(diagnosticPayload).not.toContain("input.displayCount");
  });

  it("[8] the not-reached-VERIFIED diagnostic also includes displayDiagnostic, passed straight through from the (already zod-bounded) request", () => {
    const diagnosticIndex = recordAttestationBody.indexOf('console.error("recordAttestation: session did not reach VERIFIED"');
    const diagnosticCallEnd = recordAttestationBody.indexOf(");", diagnosticIndex);
    const diagnosticPayload = recordAttestationBody.slice(diagnosticIndex, diagnosticCallEnd);
    expect(diagnosticPayload).toMatch(/displayDiagnostic:\s*input\.displayDiagnostic\s*\?\?\s*null,/);
  });

  it("[5] overallStatus/newVerificationStatus computation is unchanged by this diagnostic — the new displayCount field is added to the console.error payload only, never read back into any decision", () => {
    const diagnosticIndex = recordAttestationBody.indexOf('console.error("recordAttestation: session did not reach VERIFIED"');
    const afterDiagnostic = recordAttestationBody.slice(diagnosticIndex);
    // No branching on `displayCount` anywhere after the diagnostic log —
    // it is diagnostic/evidence only.
    expect(afterDiagnostic).not.toMatch(/if\s*\([^)]*displayCount[^)]*\)/);
  });
});
