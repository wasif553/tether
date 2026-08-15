/**
 * v1.7.5 P0 + release-blocking follow-up review — regression tests. See
 * docs/tether-preflight-lifecycle-v1.7.5-policy-not-ready.md.
 *
 * No DOM/testing-library dependency in this repo (see
 * src/app/student/exams/[id]/tether-launch/page.test.ts's own doc
 * comment for the established precedent) — this component is far too
 * large/stateful to render directly. These tests instead:
 *
 *  1. Behaviorally test the extracted, pure decision module directly —
 *     see src/lib/secureExamNativeLockdown.test.ts for the full
 *     classification-logic coverage.
 *  2. Source-level structural assertions here, proving (a) the DANGEROUS
 *     pattern that caused the P0 (a blind, unconditional mount-time
 *     downgrade to {active:true, ready:false}) is gone, (b) the render
 *     gate is actually wired to the pure decision module's output, and
 *     (c) — the follow-up review's own finding — loadSubmission()
 *     (GET /api/submissions/[id], which returns full question text/
 *     options once server-activated) is NEVER called except from inside
 *     the CONFIRMED/NOT_APPLICABLE branches of the pre-fetch gate effect
 *     — a render gate alone was not sufficient; the FETCH itself must
 *     never happen before native lockdown is confirmed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

/** Extracts the pre-fetch gate effect's body (the one that decides whether loadSubmission() is ever called at all). */
function extractPreFetchGateEffect(): string {
  const startMarker = "async function resolveAndMaybeLoad() {";
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error("Could not locate resolveAndMaybeLoad in page.tsx");
  const braceStart = source.indexOf("{", start + startMarker.length - 1);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced braces extracting resolveAndMaybeLoad");
}

const preFetchGateEffect = extractPreFetchGateEffect();

describe("no call site anywhere in this file sends the removed Task C downgrading cover", () => {
  it("{active:true, ready:false, ...} never appears as an actual setSecureClientEnforcementState call argument", () => {
    const callSites = [...source.matchAll(/sesLockdown\?\.setSecureClientEnforcementState\?\.\(([\s\S]*?)\);/g)];
    expect(callSites.length).toBeGreaterThan(0); // still called somewhere (the real, reconciled path)
    for (const call of callSites) {
      expect(call[1]).not.toMatch(/active:\s*true,\s*ready:\s*false/);
    }
  });
});

describe("REQUIRED TESTS 2/3/4/5: loadSubmission() (the ONE fetch that can return question text/options) is only ever called from inside a confirmed-safe branch", () => {
  it("loadSubmission() is called in the NOT_APPLICABLE (non-Tether and non-gated) branches", () => {
    const nonTetherBranch = preFetchGateEffect.slice(preFetchGateEffect.indexOf("if (!detected) {"), preFetchGateEffect.indexOf("if (!detected) {") + 600);
    expect(nonTetherBranch).toContain('setContentGateState("NOT_APPLICABLE");');
    expect(nonTetherBranch).toContain("void loadSubmission();");

    const nonGatedBranch = preFetchGateEffect.slice(preFetchGateEffect.indexOf("if (!gated) {"), preFetchGateEffect.indexOf("if (!gated) {") + 300);
    expect(nonGatedBranch).toContain('setContentGateState("NOT_APPLICABLE");');
    expect(nonGatedBranch).toContain("void loadSubmission();");
  });

  it("REQUIRED TEST 1: loadSubmission() is called in the CONFIRMED branch, and only after resolveNativeLockdownConfirmation has already run", () => {
    const resolveIdx = preFetchGateEffect.indexOf("resolveNativeLockdownConfirmation(");
    const confirmedBranchIdx = preFetchGateEffect.indexOf('if (confirmation === "CONFIRMED") {');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(confirmedBranchIdx).toBeGreaterThan(resolveIdx);
    const confirmedBranch = preFetchGateEffect.slice(confirmedBranchIdx, confirmedBranchIdx + 300);
    expect(confirmedBranch).toContain("void loadSubmission();");
  });

  it("REQUIRED TEST 2/4: the REACTIVATION_REQUIRED branch (native inactive, OR active+ready but policy-incompatible) never calls loadSubmission — it only redirects", () => {
    const branchIdx = preFetchGateEffect.indexOf('if (confirmation === "REACTIVATION_REQUIRED") {');
    expect(branchIdx).toBeGreaterThan(-1);
    const branch = preFetchGateEffect.slice(branchIdx, branchIdx + 500);
    // A CALL site, not merely the identifier appearing in this branch's
    // own doc comment (which legitimately names it for documentation).
    expect(branch).not.toContain("void loadSubmission();");
    expect(branch).toContain("router.replace(buildTetherLaunchPagePath(statusBody.examId));");
  });

  it("REQUIRED TEST 5: the UNSUPPORTED_BUILD path (implicit fallthrough after the REACTIVATION_REQUIRED branch) never calls loadSubmission and never redirects", () => {
    const redirectCall = "router.replace(buildTetherLaunchPagePath(statusBody.examId));";
    const redirectIdx = preFetchGateEffect.indexOf(redirectCall);
    expect(redirectIdx).toBeGreaterThan(-1);
    // Everything AFTER the one legitimate redirect call (the
    // REACTIVATION_REQUIRED branch's own) — the UNSUPPORTED_BUILD
    // fallthrough that follows it.
    const afterReactivationBranch = preFetchGateEffect.slice(redirectIdx + redirectCall.length);
    // A CALL site, not merely the identifier appearing in an adjacent
    // doc comment (which legitimately names it for documentation).
    expect(afterReactivationBranch).not.toContain("void loadSubmission();");
    expect(afterReactivationBranch).not.toContain("router.replace(");
  });

  it("the STATUS_UNAVAILABLE branch (fetch itself failed/malformed) returns before ever reaching the gated/native-state logic — never calls loadSubmission", () => {
    const malformedBranchIdx = preFetchGateEffect.indexOf("!statusBody ||");
    const gatedIdx = preFetchGateEffect.indexOf("const gated = statusBody.deliveryMode");
    expect(malformedBranchIdx).toBeGreaterThan(-1);
    expect(gatedIdx).toBeGreaterThan(malformedBranchIdx);
    const malformedBranch = preFetchGateEffect.slice(malformedBranchIdx, gatedIdx);
    expect(malformedBranch).toContain('setContentGateState("STATUS_UNAVAILABLE");');
    expect(malformedBranch).not.toContain("void loadSubmission();");
  });
});

describe("REQUIRED TEST 4: policy compatibility — requireSingleDisplay is derived from THIS attempt's frozen policy and passed to resolveNativeLockdownConfirmation, never assumed satisfied by active+ready alone", () => {
  it("requireSingleDisplay is computed from statusBody.displayRequirement.status, and passed through to resolveNativeLockdownConfirmation", () => {
    expect(preFetchGateEffect).toMatch(/const requireSingleDisplay = statusBody\.displayRequirement\?\.status === "ENFORCED_BY_SECURE_CLIENT";/);
    expect(preFetchGateEffect).toMatch(/resolveNativeLockdownConfirmation\(\{ gated, bridgeAvailable, nativeState, requireSingleDisplay \}\)/);
  });
});

describe("the fetch ordering: /secure-client/status (no question content) resolves BEFORE getSecureClientEnforcementState is queried, which resolves BEFORE loadSubmission can ever be called", () => {
  it("the status fetch, the native-state query, and the confirmation branches appear in that exact textual order inside one linear async function", () => {
    const statusFetchIdx = preFetchGateEffect.indexOf("fetch(`/api/submissions/${id}/secure-client/status`)");
    const nativeQueryIdx = preFetchGateEffect.indexOf("getSecureClientEnforcementState!()");
    const confirmedIdx = preFetchGateEffect.indexOf('confirmation === "CONFIRMED"');
    expect(statusFetchIdx).toBeGreaterThan(-1);
    expect(nativeQueryIdx).toBeGreaterThan(statusFetchIdx);
    expect(confirmedIdx).toBeGreaterThan(nativeQueryIdx);
  });

  it("examId used for the reactivation redirect comes from statusBody (the narrow, no-content endpoint) — never from `data` (which does not exist yet on this path)", () => {
    expect(preFetchGateEffect).toContain("statusBody.examId");
    expect(preFetchGateEffect).not.toContain("data.exam.id");
    expect(preFetchGateEffect).not.toContain("data?.exam.id");
  });
});

describe("REQUIRED TESTS 8/9: no eager question-bearing useEffect fires independently of loadSubmission's own gated trigger", () => {
  it("the one-question-at-a-time fetch effect is gated on data?.status === IN_PROGRESS, which can only become true once loadSubmission has already (safely) populated `data`", () => {
    const effectMarker = "if (!oneQuestionAtATime || !gateAcknowledged || data?.status !== \"IN_PROGRESS\") return;";
    expect(source).toContain(effectMarker);
  });

  it("oneQuestionAtATime itself defaults to false until `data` loads — the full exam.questions array (data.exam.questions) is likewise only ever populated by loadSubmission's own applySubmissionData, never fetched separately on mount", () => {
    expect(source).toContain('const oneQuestionAtATime = data?.exam.secureSettings.oneQuestionAtATime ?? false;');
    expect(source).not.toMatch(/fetch\(`\/api\/submissions\/\$\{id\}\/questions`\)/);
  });
});

describe("REQUIRED TEST 7: STANDARD_WEB / non-Tether-required access is unchanged — loadSubmission() fires immediately, with no extra status fetch, no added latency", () => {
  it("the !detected (non-Tether) branch calls loadSubmission() directly, without ever fetching /secure-client/status first", () => {
    const branchStart = preFetchGateEffect.indexOf("if (!detected) {");
    expect(branchStart).toBeGreaterThan(-1);
    // Fixed-length window over just this branch — mirrors the fixed-
    // length-slice convention already used elsewhere in this file
    // (avoids depending on exact newline/indentation bytes to find a
    // closing brace).
    const branch = preFetchGateEffect.slice(branchStart, branchStart + 500);
    expect(branch).not.toContain("fetch(");
    expect(branch).toContain("void loadSubmission();");
  });
});

describe("the render gate runs BEFORE the generic !data loading fallback — data can now legitimately stay null indefinitely on the REACTIVATION_REQUIRED/STATUS_UNAVAILABLE/UNSUPPORTED_BUILD paths", () => {
  it("shouldBlockExamContentRendering is checked before both `if (!data && loadError)` and `if (!data) return Loading`", () => {
    const gateCallIdx = source.indexOf("shouldBlockExamContentRendering(inLockdownBrowser, contentGateState)");
    const dataErrorIdx = source.indexOf("if (!data && loadError) {");
    const notDataIdx = source.indexOf('if (!data) return <p className="text-gray-500">Loading...</p>;');
    const inProgressCheckIdx = source.indexOf('if (data.status !== "IN_PROGRESS")');
    expect(gateCallIdx).toBeGreaterThan(-1);
    expect(dataErrorIdx).toBeGreaterThan(gateCallIdx);
    expect(notDataIdx).toBeGreaterThan(dataErrorIdx);
    expect(inProgressCheckIdx).toBeGreaterThan(notDataIdx);
  });

  it("REQUIRED TEST 3/5: the STATUS_UNAVAILABLE/UNSUPPORTED_BUILD branches offer their own specific messages, never masked by the generic Loading fallback", () => {
    const gateIdx = source.indexOf("shouldBlockExamContentRendering(inLockdownBrowser, contentGateState)");
    const gateBlock = source.slice(gateIdx, gateIdx + 2000);
    expect(gateBlock).toContain("Update required");
    expect(gateBlock).toContain("Tether could not verify this examination");
    expect(gateBlock).toContain("Try again");
  });

  it("the PENDING/REACTIVATION_REQUIRED fallback is a plain Loading message — never question content, never a native overlay", () => {
    const gateIdx = source.indexOf("shouldBlockExamContentRendering(inLockdownBrowser, contentGateState)");
    const gateBlock = source.slice(gateIdx, gateIdx + 2500);
    expect(gateBlock).toContain("Loading...");
    expect(gateBlock).not.toContain("oneQuestion.payload.question.text");
  });
});

describe("REQUIRED TEST 6: normal successful Phase 2 navigation — no unnecessary redirect back to tether-launch, no duplicate/reset timer activation", () => {
  it("the CONFIRMED branch never calls router.replace(buildTetherLaunchPagePath(...)) — only the REACTIVATION_REQUIRED branch does", () => {
    const confirmedBranchIdx = preFetchGateEffect.indexOf('if (confirmation === "CONFIRMED") {');
    const confirmedBranchEnd = preFetchGateEffect.indexOf("return;\n      }", confirmedBranchIdx) + "return;\n      }".length;
    const confirmedBranch = preFetchGateEffect.slice(confirmedBranchIdx, confirmedBranchEnd);
    expect(confirmedBranch).not.toContain("buildTetherLaunchPagePath");
  });

  it("this fix never calls POST /api/exams/[id]/start or POST /activate itself — timer activation remains solely tether-launch/page.tsx's responsibility, never duplicated here", () => {
    expect(preFetchGateEffect).not.toMatch(/\/start`/);
    expect(preFetchGateEffect).not.toMatch(/\/activate`/);
  });
});

describe("REQUIRED TESTS: active-exam enforcement (genuine display/process violations) is untouched by this fix", () => {
  it("this fix touches only the pre-fetch gate — the onDisplayEnforcementEvent/onLockdownCapabilityTransition listeners that report genuine during-exam violations are unchanged in shape", () => {
    expect(source).toContain("window.sesLockdown?.onDisplayEnforcementEvent?.(");
    expect(source).toContain("window.sesLockdown?.onLockdownCapabilityTransition?.(");
    expect(source).toContain('window.sesLockdown?.setLockdownExamActive?.(gated && verified);');
  });
});

/**
 * Physical acceptance follow-up ("answer could not be saved" / question-
 * navigation latency review). This component is too large/stateful to
 * render directly (see this file's own doc comment) — these are the same
 * kind of source-level structural assertions used throughout this file,
 * proving the actual control flow rather than guessing from a rendered
 * DOM this repo has no harness for.
 */
function extractFunctionBody(startMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Could not locate "${startMarker}" in page.tsx`);
  const braceStart = source.indexOf("{", start + startMarker.length - 1);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces extracting "${startMarker}"`);
}

describe("PART 1 — navigation only ever proceeds after the server has acknowledged the save, never before", () => {
  // Question-navigation performance follow-up — navigateQuestion now
  // branches into two save paths (a combined save-and-navigate for a
  // DIRTY answer, or a plain flushAnswerNow + navigation-only request for
  // an already-acknowledged/in-flight one) — both must still return on
  // failure before ever applying a payload or calling the navigation
  // request, exactly like the single pre-refactor path did.
  it("the DIRTY path returns on a failed saveAndNavigate BEFORE ever applying the next-question payload", () => {
    const fn = extractFunctionBody("async function navigateQuestion(requestedIndex: number) {");
    const callIdx = fn.indexOf("const result = await resilientAutosave.saveAndNavigate(questionId, response, requestedIndex);");
    const notOkIdx = fn.indexOf("if (!result.ok) {", callIdx);
    const applyIdx = fn.indexOf("applyOneQuestionPayload(result.payload);");
    expect(callIdx).toBeGreaterThan(-1);
    expect(notOkIdx).toBeGreaterThan(callIdx);
    const failureBranch = fn.slice(notOkIdx, fn.indexOf("return;", notOkIdx) + "return;".length);
    expect(failureBranch).toContain("setNavigatingQuestion(false);");
    expect(failureBranch).toContain("return;");
    expect(applyIdx).toBeGreaterThan(notOkIdx); // applying the payload is textually AFTER (gated behind) the failure return, never run unconditionally first
  });

  it("the CLEAN/in-flight path returns on a failed flushAnswerNow BEFORE ever calling the navigation-only request", () => {
    const fn = extractFunctionBody("async function navigateQuestion(requestedIndex: number) {");
    const savedIdx = fn.indexOf("const saved = await flushAnswerNow(questionId);");
    const notSavedIdx = fn.indexOf("if (!saved) {", savedIdx);
    const requestOnlyIdx = fn.indexOf("await requestNavigationOnly(requestedIndex, navigationStartedAtMs, questionId, response ?? null, strategy);");
    expect(savedIdx).toBeGreaterThan(-1);
    expect(notSavedIdx).toBeGreaterThan(savedIdx);
    const failureBranch = fn.slice(notSavedIdx, fn.indexOf("return;", notSavedIdx) + "return;".length);
    expect(failureBranch).toContain("setNavigatingQuestion(false);");
    expect(failureBranch).toContain("return;");
    expect(requestOnlyIdx).toBeGreaterThan(notSavedIdx);
  });

  it("requestNavigationOnly (the shared navigation-only leg) never applies a payload unless the fetch itself succeeded", () => {
    const fn = extractFunctionBody("async function requestNavigationOnly(");
    const throwIdx = fn.indexOf('if (!res.ok) throw new Error("navigation failed");');
    const applyIdx = fn.indexOf("applyOneQuestionPayload(payload);");
    expect(throwIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(throwIdx);
  });

  it("navigateQuestionDirect has the exact same save-before-navigate ordering as the sequential path", () => {
    const fn = extractFunctionBody("async function navigateQuestionDirect(targetIndex: number) {");
    const savedIdx = fn.indexOf("const saved = await flushAnswerNow(oneQuestion.payload.question.id);");
    const notSavedIdx = fn.indexOf("if (!saved) {");
    const fetchIdx = fn.indexOf("fetch(`/api/submissions/${id}/question-progress`");
    expect(savedIdx).toBeGreaterThan(-1);
    expect(notSavedIdx).toBeGreaterThan(savedIdx);
    expect(fetchIdx).toBeGreaterThan(notSavedIdx);
  });

  it("flushAnswerNow's own external contract: returns false (never throws) on a non-acknowledged save, and the caller treats false as failure to navigate", () => {
    const fn = extractFunctionBody("async function flushAnswerNow(questionId: string): Promise<boolean> {");
    expect(fn).toContain("const acknowledged = await resilientAutosave.save(questionId, response);");
    expect(fn).toContain("if (!acknowledged) {");
    expect(fn).toMatch(/if \(!acknowledged\) \{[\s\S]*?return false;/);
  });
});

describe("PART 4 — phone-detection calibration logging is bounded, metadata-only, and gated behind the existing sesAiCameraDebug opt-in flag", () => {
  it("the calibration candidate log runs AFTER second-stage verification, so a demoted candidate's rejectedReason can reflect it", () => {
    const verificationCallIdx = source.indexOf('tracker.applyVerification(track.id, verifyPhone != null, verifyPhone?.score ?? 0);');
    const calibrationLogIdx = source.indexOf('logAiCameraDebug("tick: phone calibration candidates"');
    expect(verificationCallIdx).toBeGreaterThan(-1);
    expect(calibrationLogIdx).toBeGreaterThan(verificationCallIdx);
  });

  it("geometry-rejected candidates are captured from BOTH the full-frame and crop detection passes, via the same sink array", () => {
    // Scoped to the tick handler (well after the function's own
    // definition, which the naive regex below would otherwise also match
    // against — its body contains unrelated "...);" occurrences).
    const tickScope = source.slice(source.indexOf('logAiCameraDebug("tick: start"'));
    const calls = [...tickScope.matchAll(/phoneObservationsFromDetections\(([\s\S]*?)\);/g)];
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call[1]).toContain("geometryRejectedPhoneCandidates");
    }
  });

  it("logAiCameraDebug (and therefore this calibration log) is a no-op unless shouldLogAiCameraDebug's opt-in flag is set — never fires in production, never fires without the explicit local debug flag", () => {
    const fn = extractFunctionBody('function logAiCameraDebug(message: string, data: Record<string, unknown>) {');
    expect(fn).toContain("shouldLogAiCameraDebug(");
  });

  it("PhoneCalibrationCandidate never carries image/frame/video data — every field is a plain number, string, boolean, or bounded box", () => {
    const typeIdx = source.indexOf("type PhoneCalibrationCandidate = {");
    expect(typeIdx).toBeGreaterThan(-1);
    const typeBlock = source.slice(typeIdx, source.indexOf("};", typeIdx));
    expect(typeBlock).not.toMatch(/image|frame(?!Quality)|dataUrl|base64|video/i);
  });
});

describe("PART 1/2 — a slow response cannot cause duplicate navigation: navigateQuestion is guarded against re-entrancy for its entire duration", () => {
  it("navigateQuestion bails out immediately if a previous call is still in flight, and sets the in-flight flag BEFORE its first await", () => {
    const fn = extractFunctionBody("async function navigateQuestion(requestedIndex: number) {");
    const guardIdx = fn.indexOf("if (!oneQuestion.payload || navigatingQuestion) return;");
    const setTrueIdx = fn.indexOf("setNavigatingQuestion(true);");
    const firstAwaitIdx = fn.indexOf("await flushAnswerNow(");
    // The re-entrancy guard is the first STATEMENT in the function body —
    // only the opening brace/whitespace and this file's own added latency-
    // timing comment (never another await or state check) precede it.
    const bodyOpenIdx = fn.indexOf("{");
    const betweenOpenAndGuard = fn.slice(bodyOpenIdx + 1, guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(betweenOpenAndGuard).not.toMatch(/await |setNavigatingQuestion|setOneQuestion/);
    expect(setTrueIdx).toBeGreaterThan(guardIdx);
    expect(setTrueIdx).toBeLessThan(firstAwaitIdx); // flag flips to true before any async gap a second click could race into
  });

  it("navigateQuestion always clears the in-flight flag on every exit path — the dirty-path failure/success returns, the clean-path failure return, and (via requestNavigationOnly) the catch/finally around the navigation-only request", () => {
    const fn = extractFunctionBody("async function navigateQuestion(requestedIndex: number) {");
    const setNavigatingQuestionCalls = fn.match(/setNavigatingQuestion\((true|false)\)/g) ?? [];
    // true once at entry, false on every one of navigateQuestion's OWN
    // return points (dirty-path failure, dirty-path success, clean-path
    // failure) — a slow or failed request can never leave the flag
    // permanently stuck true.
    expect(setNavigatingQuestionCalls.filter((c) => c.includes("true")).length).toBe(1);
    expect(setNavigatingQuestionCalls.filter((c) => c.includes("false")).length).toBeGreaterThanOrEqual(3);
    // The remaining exit path — a clean/in-flight navigation-only request
    // — delegates to requestNavigationOnly, which has its OWN try/finally
    // clearing the flag no matter how the fetch resolves.
    const requestOnlyFn = extractFunctionBody("async function requestNavigationOnly(");
    expect(requestOnlyFn).toMatch(/\}\s*finally\s*\{\s*setNavigatingQuestion\(false\);\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// Question Navigator immediate-local-synchronization (Tether v1.7.6, Part
// 10). See src/lib/navigatorLocalSync.test.ts for the behavioral unit
// tests of applyLocalNavigatorTransition itself — these are the
// structural (source-text) tests proving it is actually WIRED into
// navigateQuestion/requestNavigationOnly ahead of, not instead of, the
// existing background GET question-navigator refresh, and that
// loadNavigator's stale-request guard is in place.
// ---------------------------------------------------------------------------

describe("Part 10 (1)/(10) — a successful navigation updates the CURRENT tile immediately and never waits on the navigator GET", () => {
  it("the dirty (save-and-navigate) path calls applyLocalNavigatorTransition synchronously, textually AFTER the question content is already applied — never behind an await of loadNavigator/fetch(question-navigator)", () => {
    const fn = extractFunctionBody("async function navigateQuestion(requestedIndex: number) {");
    const applyContentIdx = fn.indexOf("applyOneQuestionPayload(result.payload);");
    const syncIdx = fn.indexOf("applyLocalNavigatorTransition(prev, {", applyContentIdx);
    expect(applyContentIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(applyContentIdx);
    // The setQuestionNav(...) call wrapping it is a plain synchronous
    // updater — no await anywhere between applying the question content
    // and the end of the setQuestionNav(...) call, so nothing can block
    // question content from being the fast path.
    const setQuestionNavCall = fn.slice(fn.indexOf("setQuestionNav((prev) =>", applyContentIdx), fn.indexOf(");", syncIdx) + 2);
    expect(setQuestionNavCall).not.toMatch(/await |fetch\(/);
    expect(fn).not.toMatch(/await loadNavigator\(\)/);
  });

  it("the clean (navigation-only) path in requestNavigationOnly does the same — applies the question content, then synchronously syncs the navigator, never awaiting loadNavigator/fetch(question-navigator) itself", () => {
    const fn = extractFunctionBody("async function requestNavigationOnly(");
    const applyContentIdx = fn.indexOf("applyOneQuestionPayload(payload);");
    const syncIdx = fn.indexOf("applyLocalNavigatorTransition(prev, {", applyContentIdx);
    expect(applyContentIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(applyContentIdx);
    const setQuestionNavCall = fn.slice(fn.indexOf("setQuestionNav((prev) =>", applyContentIdx), fn.indexOf(");", syncIdx) + 2);
    expect(setQuestionNavCall).not.toMatch(/await |fetch\(/);
    expect(fn).not.toMatch(/await loadNavigator\(\)/);
  });
});

describe("Part 10 (9) — save-and-navigate request count is unchanged by the navigator-sync addition", () => {
  it("the dirty path still issues exactly one resilientAutosave.saveAndNavigate call — the local navigator sync adds no new request", () => {
    const fn = extractFunctionBody("async function navigateQuestion(requestedIndex: number) {");
    const calls = fn.match(/resilientAutosave\.saveAndNavigate\(/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("requestNavigationOnly still issues exactly one fetch to question-progress — the local navigator sync adds no new request", () => {
    const fn = extractFunctionBody("async function requestNavigationOnly(");
    const calls = fn.match(/fetch\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});

describe("Part 10 (6)/(7) — loadNavigator's stale-request guard: only the latest generation may update questionNav", () => {
  it("increments a monotonic generation token before the fetch, and only calls setQuestionNav when that token is still current when the response arrives", () => {
    const fn = extractFunctionBody("const loadNavigator = useCallback(async () => {");
    const generationIdx = fn.indexOf("const generation = ++navigatorRequestGenerationRef.current;");
    const fetchIdx = fn.indexOf("fetch(`/api/submissions/${id}/question-navigator`)");
    const guardIdx = fn.indexOf("if (generation !== navigatorRequestGenerationRef.current) return;");
    const setIdx = fn.indexOf("setQuestionNav(data);");
    expect(generationIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(generationIdx);
    expect(guardIdx).toBeGreaterThan(fetchIdx);
    expect(setIdx).toBeGreaterThan(guardIdx); // setQuestionNav is textually gated BEHIND the staleness check, never called unconditionally first
  });
});

// ---------------------------------------------------------------------------
// Tether v1.7.6 pre-commit audit — Native Display State Bridge
// registration-race fix. See apps/lockdown/src/removableListenerRegistry.test.ts
// for the genuine behavioral coverage of the underlying cleanup mechanism
// (Part 4.E/F) — these are the structural (source-text) tests proving the
// exam page actually WIRES it correctly: listener before query, a
// stale-initial-query guard, and cleanup on unmount.
// ---------------------------------------------------------------------------

function extractDisplayBridgeEffect(): string {
  const startMarker = "if (!data?.id || !inLockdownBrowser) return;";
  const endMarker = "}, [data?.id, inLockdownBrowser]);";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error("Could not locate the display-bridge registration effect in page.tsx");
  return source.slice(start, end + endMarker.length);
}

describe("Part 4.A/B/C — Native Display State Bridge: the listener is registered before the initial query, so no transition during the query's IPC round trip can be missed", () => {
  it("onDisplayEnforcementStateChanged is called textually BEFORE getDisplayEnforcementStatus — required safe ordering (register, then query)", () => {
    const effect = extractDisplayBridgeEffect();
    const listenerIdx = effect.indexOf("window.sesLockdown?.onDisplayEnforcementStateChanged?.(");
    const queryIdx = effect.indexOf("?.getDisplayEnforcementStatus?.()");
    expect(listenerIdx).toBeGreaterThan(-1);
    expect(queryIdx).toBeGreaterThan(listenerIdx);
  });

  it("the listener applies whatever status it receives unconditionally (both initial-OK-then-BLOCKED and initial-BLOCKED-then-OK are handled identically — no directional bias)", () => {
    const effect = extractDisplayBridgeEffect();
    const listenerBody = effect.slice(
      effect.indexOf("window.sesLockdown?.onDisplayEnforcementStateChanged?.("),
      effect.indexOf("});", effect.indexOf("window.sesLockdown?.onDisplayEnforcementStateChanged?.(")) + 3,
    );
    expect(listenerBody).toMatch(/liveDisplayUpdateReceived\s*=\s*true;/);
    expect(listenerBody).toMatch(/setDisplayEnforcementStatus\(status\);/);
    // Never gated on status.state — applies BLOCKED and OK identically.
    expect(listenerBody).not.toMatch(/status\.state\s*===\s*"(OK|BLOCKED)"/);
  });
});

describe("Part 4.D — a stale initial-query result can never overwrite a newer live transition", () => {
  it("the initial query's .then() checks liveDisplayUpdateReceived and bails out before calling setDisplayEnforcementStatus if a live push already arrived", () => {
    const effect = extractDisplayBridgeEffect();
    const queryStart = effect.indexOf("?.getDisplayEnforcementStatus?.()");
    const thenIdx = effect.indexOf(".then((status) => {", queryStart);
    const catchIdx = effect.indexOf(".catch(() => {", queryStart);
    const queryBlock = effect.slice(thenIdx, catchIdx);
    const guardIdx = queryBlock.indexOf("if (cancelled || !status || liveDisplayUpdateReceived) return;");
    const applyIdx = queryBlock.indexOf("setDisplayEnforcementStatus(status);");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(guardIdx); // setDisplayEnforcementStatus is textually gated BEHIND the staleness check, never called unconditionally first
  });

  it("liveDisplayUpdateReceived starts false and is declared before both the listener and the query use it (no TDZ/ordering bug)", () => {
    const effect = extractDisplayBridgeEffect();
    const declIdx = effect.indexOf("let liveDisplayUpdateReceived = false;");
    const listenerIdx = effect.indexOf("window.sesLockdown?.onDisplayEnforcementStateChanged?.(");
    const queryIdx = effect.indexOf("?.getDisplayEnforcementStatus?.()");
    expect(declIdx).toBeGreaterThan(-1);
    expect(listenerIdx).toBeGreaterThan(declIdx);
    expect(queryIdx).toBeGreaterThan(declIdx);
  });
});

describe("Part 4.E/F — cleanup removes exactly the display-state listener; remount cannot accumulate duplicates", () => {
  it("the listener registration captures the returned unsubscribe function, and the effect's own cleanup calls it", () => {
    const effect = extractDisplayBridgeEffect();
    expect(effect).toMatch(/const unsubscribeDisplayEnforcementState = window\.sesLockdown\?\.onDisplayEnforcementStateChanged\?\.\(/);
    const cleanupIdx = effect.indexOf("return () => {");
    expect(cleanupIdx).toBeGreaterThan(-1);
    const cleanupBlock = effect.slice(cleanupIdx);
    expect(cleanupBlock).toMatch(/unsubscribeDisplayEnforcementState\?\.\(\);/);
  });

  it("this effect's own dependency array is the stable [data?.id, inLockdownBrowser] pair — it does not re-run (and therefore does not re-register the listener) on every unrelated re-render", () => {
    expect(source).toMatch(/\}, \[data\?\.id, inLockdownBrowser\]\);/);
  });
});

// ---------------------------------------------------------------------------
// Pre-commit audit fix (PR #26) — the initial getDisplayEnforcementStatus()
// IPC query can itself REJECT. Silently doing nothing would be a fail-OPEN
// presentation gap: native state could already be BLOCKED before this
// renderer mounted, and because live pushes are deduplicated against the
// last status, an unchanged BLOCKED state may never fire another push to
// recover from. See src/lib/displayViolationOverlay.test.ts for the
// behavioral coverage of displayStatusOnInitialQueryFailure/
// computeDisplayViolationModal (items 4/5/6/7); these are the structural
// tests proving the exam page actually wires the failure handler in, and
// that it never fires for STANDARD_WEB (item 8).
// ---------------------------------------------------------------------------

describe("Pre-commit audit fix (PR #26), item 4/5 — a rejected initial query fails closed with the neutral status, never silently ignored", () => {
  it("the query's .catch() sets displayStatusOnInitialQueryFailure() — never an empty/no-op handler", () => {
    const effect = extractDisplayBridgeEffect();
    const queryStart = effect.indexOf("?.getDisplayEnforcementStatus?.()");
    const queryBlock = effect.slice(queryStart);
    expect(queryBlock).toMatch(/\.catch\(\(\) => \{\s*if \(cancelled \|\| liveDisplayUpdateReceived\) return;\s*setDisplayEnforcementStatus\(displayStatusOnInitialQueryFailure\(\)\);\s*\}\);/);
  });

  it("imports displayStatusOnInitialQueryFailure from src/lib/displayViolationOverlay", () => {
    expect(source).toMatch(/import \{\s*computeDisplayViolationModal,\s*displayStatusOnInitialQueryFailure,/);
  });
});

describe("Pre-commit audit fix (PR #26), item 6/7 — recovery after a failure state is the SAME mechanism as any other transition", () => {
  it("the live listener is a single, unconditional registration — never disabled or bypassed by the query's own catch block, so a later OK or genuine BLOCKED push always still applies normally", () => {
    const effect = extractDisplayBridgeEffect();
    // Exactly one registration of the listener in this effect — the
    // catch-block addition did not fork a second, conditional listener
    // path; recovery/replacement after a failure state goes through the
    // SAME setDisplayEnforcementStatus(status) call the listener always
    // used.
    const registrations = effect.match(/window\.sesLockdown\?\.onDisplayEnforcementStateChanged\?\.\(/g) ?? [];
    expect(registrations.length).toBe(1);
  });
});

describe("Pre-commit audit fix (PR #26), item 8 — STANDARD_WEB (no window.sesLockdown) is never affected", () => {
  it("the failure handler's .catch() is chained directly off the SAME optional ?.getDisplayEnforcementStatus?.() call — never a separate, unguarded statement that could run without a Tether bridge present", () => {
    const effect = extractDisplayBridgeEffect();
    const queryIdx = effect.indexOf("?.getDisplayEnforcementStatus?.()");
    const thenIdx = effect.indexOf(".then((status) => {", queryIdx);
    const catchIdx = effect.indexOf(".catch(() => {", queryIdx);
    expect(queryIdx).toBeGreaterThan(-1);
    // .then and .catch both appear AFTER the optional ?.() call with no
    // semicolon (i.e. no statement break) in between — proving they are
    // part of the SAME expression that short-circuits to undefined
    // (never even reaching .then/.catch) whenever window.sesLockdown or
    // getDisplayEnforcementStatus itself is absent, exactly as
    // STANDARD_WEB/non-Tether exams require.
    // Between the optional call and .then(...) there is no statement-
    // terminating semicolon — proving .then is chained directly off the
    // SAME expression, not a separate statement that would run even when
    // window.sesLockdown?.getDisplayEnforcementStatus?.() short-circuited
    // to undefined.
    const betweenQueryAndThen = effect.slice(queryIdx, thenIdx);
    expect(betweenQueryAndThen).not.toContain(";");
    expect(catchIdx).toBeGreaterThan(thenIdx);
  });

  it("there is no second, separately-invoked display-status fetch/IPC call anywhere in this effect that could bypass the optional chain", () => {
    const effect = extractDisplayBridgeEffect();
    const occurrences = effect.match(/getDisplayEnforcementStatus/g) ?? [];
    // Exactly one call site (?.getDisplayEnforcementStatus?.()) — the
    // preceding doc comments legitimately name it in prose too, so this
    // just proves there's a single call, not a duplicated/unguarded one.
    const callSites = effect.match(/\?\.getDisplayEnforcementStatus\?\.\(\)/g) ?? [];
    expect(callSites.length).toBe(1);
    expect(occurrences.length).toBeGreaterThanOrEqual(callSites.length);
  });
});

describe("Part 4 — preload.ts's onDisplayEnforcementStateChanged returns an unsubscribe function (never repeats onDisplayEnforcementEvent's no-removal limitation)", () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "apps", "lockdown", "src", "preload.ts"), "utf8");

  it("the exposed method's return type is a function, backed by a removable listener registry rather than a plain push-only array", () => {
    expect(preloadSource).toContain(
      'onDisplayEnforcementStateChanged(callback: (status: { state: "OK" | "BLOCKED"; reason: string | null; displayCount: number }) => void): () => void {',
    );
    expect(preloadSource).toContain("return displayEnforcementStateRegistry.add(callback);");
    expect(preloadSource).toContain('import { createRemovableListenerRegistry } from "./removableListenerRegistry";');
  });
});

describe("Part 10 (8) — a background navigator-refresh failure never rolls back the already-displayed question", () => {
  it("loadNavigator's catch block never touches oneQuestion/setOneQuestion — a failed background refresh only ever leaves the locally-synced navigator in place", () => {
    const fn = extractFunctionBody("const loadNavigator = useCallback(async () => {");
    const catchIdx = fn.indexOf("} catch {");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = fn.slice(catchIdx);
    expect(catchBlock).not.toMatch(/setOneQuestion|setNavigatingQuestion/);
  });
});

// Physical acceptance follow-up — phone-detection calibration
// observability. Structural checks that this is purely additive metadata
// on the EXISTING POSSIBLE_PHONE_VISIBLE report — never a new request,
// never a change to detection decisions/cadence/emission.
describe("phone-detection calibration observability — structural checks on runDetectionTick", () => {
  it("the calibration summary is gated behind isPhoneCalibrationEnabled — never built unconditionally", () => {
    const fn = extractFunctionBody("async function runDetectionTick() {");
    const gateIdx = fn.indexOf("const calibrationEnabled = isPhoneCalibrationEnabled(process.env.NEXT_PUBLIC_TETHER_PHONE_CALIBRATION_ENABLED);");
    const ternaryIdx = fn.indexOf("const calibration = calibrationEnabled", gateIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(ternaryIdx).toBeGreaterThan(gateIdx);
    expect(fn.slice(ternaryIdx, ternaryIdx + 800)).toContain(": undefined;");
  });

  it("the calibration object is only spread into the event metadata conditionally — never an unconditional key", () => {
    const fn = extractFunctionBody("async function runDetectionTick() {");
    expect(fn).toContain("...(calibration ? { calibration } : {}),");
  });

  it("attaching calibration metadata introduces no new network call — the block between building the summary and the existing reportIntegrityEvent call contains no fetch()", () => {
    const fn = extractFunctionBody("async function runDetectionTick() {");
    const calibrationIdx = fn.indexOf("const calibrationEnabled = isPhoneCalibrationEnabled(");
    const reportIdx = fn.indexOf('reportIntegrityEvent("POSSIBLE_PHONE_VISIBLE"', calibrationIdx);
    expect(calibrationIdx).toBeGreaterThan(-1);
    expect(reportIdx).toBeGreaterThan(calibrationIdx);
    const between = fn.slice(calibrationIdx, reportIdx);
    expect(between).not.toMatch(/\bfetch\(/);
  });

  it("there is still exactly one POSSIBLE_PHONE_VISIBLE report call site in the whole file — calibration did not introduce a second/duplicate emission path", () => {
    const matches = source.match(/reportIntegrityEvent\("POSSIBLE_PHONE_VISIBLE"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("buildPhoneCalibrationEventSummary is only ever called from inside the phoneDecision.shouldEmit branch — never on every tick", () => {
    const fn = extractFunctionBody("async function runDetectionTick() {");
    const shouldEmitIdx = fn.indexOf("if (phoneDecision.shouldEmit && bestConfirmedPhoneTrack) {");
    const summaryCallIdx = fn.indexOf("buildPhoneCalibrationEventSummary({");
    expect(shouldEmitIdx).toBeGreaterThan(-1);
    expect(summaryCallIdx).toBeGreaterThan(shouldEmitIdx);
    // Only one call site of the summary builder exists in the file at all.
    expect(source.match(/buildPhoneCalibrationEventSummary\(/g)?.length).toBe(1);
  });
});
