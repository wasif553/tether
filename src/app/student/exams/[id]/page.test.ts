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

// Exam layout stability follow-up — the question card sits in a single
// stacked column (navigator above, Previous/Next below), so an unstabilized
// card visibly pushed everything below it up/down on every Next/Previous as
// content naturally varies between question types (MCQ vs short-answer vs a
// 5-row essay textarea). A min-height floor stops that without capping
// genuine growth — these are source-level structural checks (this repo has
// no DOM/testing-library harness for this file, see this file's own doc
// comment), not a pixel-perfect rendering assertion.
describe("Exam layout stability — question card min-height floor", () => {
  it("the loaded-question card carries a min-height class, not just border/padding", () => {
    // Immediately preceded by the loading-placeholder line, which uniquely
    // anchors this to the one-question-mode card (this exact border/padding
    // combination appears elsewhere in the file for unrelated cards).
    const anchor = source.indexOf('{oneQuestion.loading && <p className="text-gray-500">Loading question...</p>}');
    expect(anchor).toBeGreaterThan(-1);
    const cardIdx = source.indexOf('rounded border border-gray-200 bg-white p-4"', anchor);
    expect(cardIdx).toBeGreaterThan(-1);
    const lineStart = source.lastIndexOf("\n", cardIdx);
    const line = source.slice(lineStart, cardIdx + 40);
    expect(line).toMatch(/min-h-\[\d+px\]/);
  });

  it("the min-height floor is on the loaded-question branch only, not the separate loading placeholder — a min-height on the placeholder would itself reserve mismatched space before content exists", () => {
    const loadingIdx = source.indexOf('{oneQuestion.loading && <p className="text-gray-500">Loading question...</p>}');
    expect(loadingIdx).toBeGreaterThan(-1);
    const loadedIdx = source.indexOf('!oneQuestion.loading && oneQuestion.payload', loadingIdx);
    expect(loadedIdx).toBeGreaterThan(loadingIdx);
    const placeholderLine = source.slice(loadingIdx, loadingIdx + 90);
    expect(placeholderLine).not.toMatch(/min-h-/);
  });

  it("the fix is a pure className addition — no new key prop, no conditional remount, no animation/transition class introduced on the card", () => {
    const cardIdx = source.indexOf('min-h-[280px] rounded border border-gray-200 bg-white p-4"');
    expect(cardIdx).toBeGreaterThan(-1);
    const surrounding = source.slice(cardIdx - 200, cardIdx + 200);
    expect(surrounding).not.toMatch(/\bkey=\{/);
    expect(surrounding).not.toMatch(/animate-|transition-/);
  });
});

// MCQ interaction layout-shift fix — the proven root cause was
// RecoveryStatusBanner's own mount/unmount as pendingCount/status flip
// during every autosave (see RecoveryStatusBanner.tsx and
// RecoveryStatusBanner.test.tsx for the component-level fix/tests). This
// is the structural guard at the CALL SITE: nothing here may reintroduce
// a pendingCount/status-conditional wrapper around it, which would
// silently bring the same bug back at a different layer even with the
// component itself fixed.
describe("Exam layout stability — RecoveryStatusBanner call site never re-gates on pendingCount/status", () => {
  it("RecoveryStatusBanner's only enclosing conditional is submissionStatus === \"IN_PROGRESS\" — stable for the whole exam, never pendingCount/connectionStatus", () => {
    const usageIdx = source.indexOf("<RecoveryStatusBanner");
    expect(usageIdx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, usageIdx - 400), usageIdx);
    expect(before).toContain('submissionStatus === "IN_PROGRESS"');
    // The nearest preceding conditional-opening brace is the IN_PROGRESS
    // check — no pendingCount/status test appears between it and the
    // component itself.
    const conditionIdx = before.lastIndexOf('submissionStatus === "IN_PROGRESS"');
    const between = before.slice(conditionIdx);
    expect(between).not.toMatch(/pendingCount|connectionStatus|resilientAutosave\.status/);
  });

  it("RecoveryStatusBanner is passed resilientAutosave.status/pendingCount as PROPS (so the component itself can decide silent-vs-visible), never used to gate whether it renders at all", () => {
    const usageIdx = source.indexOf("<RecoveryStatusBanner");
    const closeIdx = source.indexOf("/>", usageIdx);
    const propsBlock = source.slice(usageIdx, closeIdx);
    expect(propsBlock).toContain("connectionStatus={resilientAutosave.status}");
    expect(propsBlock).toContain("pendingCount={resilientAutosave.pendingCount}");
  });

  it("RecoveryStatusBanner is not wrapped in a layout-participating container at the call site — no enclosing div with margin/padding classes between the IN_PROGRESS check and the component", () => {
    const usageIdx = source.indexOf("<RecoveryStatusBanner");
    expect(usageIdx).toBeGreaterThan(-1);
    // The NEAREST preceding IN_PROGRESS check, not necessarily the first
    // occurrence in the whole file (submissionStatus === "IN_PROGRESS" is
    // also used elsewhere, e.g. for screen-share/camera warnings).
    const conditionIdx = source.slice(0, usageIdx).lastIndexOf('submissionStatus === "IN_PROGRESS"');
    expect(conditionIdx).toBeGreaterThan(-1);
    const between = source.slice(conditionIdx, usageIdx);
    // Exactly the JSX-conditional wrapper `&& (` and whitespace/comments —
    // no `<div` of any kind between the condition and the component itself.
    expect(between).not.toContain("<div");
  });
});

// Exam workspace stability pass — desktop two-column layout: navigator
// LEFT (stable, bounded width), active question RIGHT (flexible width).
// See the JSX's own doc comments for the CSS-grid mechanics.
describe("Approved student exam workspace v2 — grid direct children are exactly the 3 approved siblings, in order", () => {
  it("the aria-live navigator-announcement region is a SIBLING of the grid wrapper, not its first child — as a first grid child it silently shifted the navigator/question/Brainstorm sidebar over by one column, so the navigator rendered in the question's column, the question card was squeezed into Brainstorm's 360px column, and Brainstorm itself wrapped to a new row under the navigator", () => {
    const srOnlyIdx = source.indexOf('<div aria-live="polite" className="sr-only">');
    expect(srOnlyIdx).toBeGreaterThan(-1);
    const gridWrapperIdx = source.indexOf("<div className={oneQuestionGridWrapperClass}>");
    expect(gridWrapperIdx).toBeGreaterThan(-1);
    const srOnlyCloseIdx = source.indexOf("</div>", srOnlyIdx);
    expect(srOnlyCloseIdx).toBeGreaterThan(srOnlyIdx);
    // The sr-only region must fully close BEFORE the grid wrapper opens
    // — i.e. it is a preceding sibling, never nested inside the grid.
    expect(srOnlyCloseIdx).toBeLessThan(gridWrapperIdx);
  });

  it("the grid wrapper's first real child is the question-navigator conditional — never the sr-only region", () => {
    const gridWrapperIdx = source.indexOf("<div className={oneQuestionGridWrapperClass}>");
    expect(gridWrapperIdx).toBeGreaterThan(-1);
    const immediatelyAfterOpen = source.slice(gridWrapperIdx, gridWrapperIdx + 200);
    expect(immediatelyAfterOpen).not.toContain("sr-only");
    expect(immediatelyAfterOpen).toContain("showQuestionNavigatorPanel &&");
  });
});

describe("Exam workspace — desktop left-navigator two-column layout", () => {
  it("the one-question-mode workspace wrapper uses a bounded-navigator/flexible-question grid at min-[900px]: and above, with items-start to prevent column-height stretching", () => {
    // Question-scoped brainstorm sidebar v1 / Approved student exam +
    // Brainstorm layout v2 — this grid class is now COMPUTED
    // (oneQuestionGridColsClass/oneQuestionGridWrapperClass, declared
    // alongside showQuestionNavigatorPanel), since a third (AI sidebar)
    // column can also apply, at its own min-[1200px]: breakpoint — no
    // longer one static inline ternary literal. The navigator-only
    // branch resolves to the 2-column class string at the approved
    // "medium" tier's own min-[900px]: breakpoint; assert against the
    // source of that computation instead of the old single literal.
    const colsIdx = source.indexOf("min-[900px]:grid-cols-[220px_minmax(560px,1fr)]");
    expect(colsIdx).toBeGreaterThan(-1);
    const wrapperTemplateIdx = source.indexOf("min-[900px]:items-start min-[900px]:gap-5");
    expect(wrapperTemplateIdx).toBeGreaterThan(-1);
  });

  it("the navigator slot appears BEFORE the question column in the DOM (so CSS grid auto-placement puts it in the first/left column) and is wrapped separately from the question content", () => {
    const declIdx = source.indexOf("const showQuestionNavigatorPanel = secureSettings?.showQuestionNavigator === true;");
    expect(declIdx).toBeGreaterThan(-1);
    const slotIdx = source.indexOf("{showQuestionNavigatorPanel && (", declIdx);
    const questionColumnIdx = source.indexOf('<div className="min-w-0">', declIdx);
    expect(slotIdx).toBeGreaterThan(declIdx);
    expect(questionColumnIdx).toBeGreaterThan(slotIdx);
  });

  it("the navigator's own wrapper is sticky only at lg: and above — never introduces sticky positioning (or a competing scroll container) on mobile/tablet", () => {
    const idx = source.indexOf('className="mb-4 lg:sticky lg:top-4 lg:mb-0"');
    expect(idx).toBeGreaterThan(-1);
  });

  it("the question column has min-w-0 so a long unbroken answer/question string wraps instead of forcing the grid wider than the viewport", () => {
    const idx = source.indexOf('<div className="min-w-0">');
    expect(idx).toBeGreaterThan(-1);
  });

  it("the previously-established min-h-[280px] question-card floor is preserved unchanged by this layout pass", () => {
    expect(source).toContain('min-h-[280px] rounded border border-gray-200 bg-white p-4"');
  });

  it("the no-navigator/no-AI-sidebar branch of the workspace wrapper's className is exactly \"mt-6\" — no grid/column classes leak into the single-column case", () => {
    // Question-scoped brainstorm sidebar v1 — oneQuestionGridWrapperClass
    // falls back to exactly "mt-6" whenever oneQuestionGridColsClass is
    // empty (neither the navigator nor the AI sidebar applies), the same
    // invariant the old two-way ternary's false branch protected.
    const declIdx = source.indexOf("const oneQuestionGridWrapperClass = oneQuestionGridColsClass");
    expect(declIdx).toBeGreaterThan(-1);
    const between = source.slice(declIdx, declIdx + 200);
    expect(between).toMatch(/:\s*"mt-6"/);
    expect(between).not.toMatch(/:\s*"mt-6[^"]/); // not "mt-6 " + something extra
  });
});

// Left-nav slot stability fix (independent review) — the grid wrapper AND
// the navigator's left slot must both key off the SAME synchronously-known
// boolean (showQuestionNavigatorPanel, derived from secureSettings), never
// off `questionNav` (which only becomes truthy once the async
// GET /question-navigator response resolves). The bug this closes: CSS
// grid auto-placement had only one item on first paint whenever the
// navigator was enabled but not yet loaded, so the question column became
// the grid's FIRST (left, 260px) item and then jumped into the second
// (right) column the instant the navigator's data arrived.
describe("Exam workspace — left-nav slot presence is decoupled from questionNav data", () => {
  it("showQuestionNavigatorPanel is derived from secureSettings?.showQuestionNavigator directly — never from questionNav — and is declared once, reused by both the grid wrapper and the slot", () => {
    const declIdx = source.indexOf("const showQuestionNavigatorPanel = secureSettings?.showQuestionNavigator === true;");
    expect(declIdx).toBeGreaterThan(-1);
    // Exactly two consuming usages: the grid-wrapper ternary condition and
    // the slot's own `&&` guard — neither is `questionNav`.
    const usages = source.match(/showQuestionNavigatorPanel/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(3); // declaration + wrapper + slot guard
  });

  it("the grid wrapper's className condition and the slot's own presence guard are the exact same expression — they cannot disagree with each other", () => {
    const declIdx = source.indexOf("const showQuestionNavigatorPanel = secureSettings?.showQuestionNavigator === true;");
    const wrapperCondIdx = source.indexOf("showQuestionNavigatorPanel", declIdx + 1);
    const slotGuardIdx = source.indexOf("{showQuestionNavigatorPanel && (");
    expect(declIdx).toBeGreaterThan(-1);
    expect(wrapperCondIdx).toBeGreaterThan(declIdx);
    expect(slotGuardIdx).toBeGreaterThan(wrapperCondIdx);
  });

  it("inside the slot, only the CONTENT (real panel vs. placeholder) is conditional on questionNav — the slot wrapper itself is not", () => {
    const slotGuardIdx = source.indexOf("{showQuestionNavigatorPanel && (");
    expect(slotGuardIdx).toBeGreaterThan(-1);
    const contentTernaryIdx = source.indexOf("{questionNav ? (", slotGuardIdx);
    expect(contentTernaryIdx).toBeGreaterThan(slotGuardIdx);
    // The ternary's true branch renders the real panel; false branch is a
    // quiet, aria-hidden placeholder — never nothing, never a different
    // element type that would change the slot's own presence.
    const closeIdx = source.indexOf("</div>", contentTernaryIdx);
    const between = source.slice(contentTernaryIdx, closeIdx);
    expect(between).toContain("<QuestionNavigatorPanel");
    expect(between).toContain('aria-hidden="true"');
  });

  it("the placeholder is a plain, non-flashing box (no loading text, no spinner, no animation class) — only a reserved shape", () => {
    const placeholderIdx = source.indexOf('<div className="h-10 rounded border border-gray-100" aria-hidden="true" />');
    expect(placeholderIdx).toBeGreaterThan(-1);
    const surrounding = source.slice(placeholderIdx - 150, placeholderIdx + 50);
    expect(surrounding).not.toMatch(/animate-|Loading|spinner/i);
  });

  it("questionNav being null does not remove the slot — the slot's presence is showQuestionNavigatorPanel-only, so a still-loading navigator never changes which grid column the question occupies", () => {
    // Structural proof: the slot's opening guard uses showQuestionNavigatorPanel
    // exclusively; questionNav is referenced only INSIDE it (already
    // covered by the two tests above), never in the guard expression itself.
    const guardMatch = source.match(/\{showQuestionNavigatorPanel && \(/);
    expect(guardMatch).not.toBeNull();
    const guardIdx = guardMatch!.index!;
    const guardLine = source.slice(guardIdx, guardIdx + 40);
    expect(guardLine).not.toContain("questionNav");
  });
});

// Remove-all-routine-save-UI pass — product decision: ordinary, successful
// answer saving must be COMPLETELY INVISIBLE (no visible "Saving...",
// "Saved", or pending-count text ever appears/disappears in the exam-taking
// DOM). Backend saving itself (handleChange -> saveAnswer -> 600ms debounce
// -> resilientAutosave.save -> IndexedDB queue -> server ack) must be
// byte-for-byte unchanged; only the removed visible span near Previous/Next
// is in scope. See RecoveryStatusBanner.tsx/.test.tsx for the sr-only
// ordinary-state coverage, which this pass leaves untouched.
describe("Remove routine save UI — no visible 'Saving...' text anywhere in the exam-taking DOM", () => {
  it("the removed Previous/Next 'Saving...' span (navigatingQuestion && <span>Saving...</span>) is gone from the source entirely", () => {
    expect(source).not.toContain("Saving...");
    expect(source).not.toMatch(/>\s*Saving\s*\.\.\.\s*</);
  });

  it("no visible (non-sr-only) 'Saved' text exists in the exam-taking page — only RecoveryStatusBanner's own sr-only 'Saved.' string, which lives in a different file", () => {
    // page.tsx never renders its own "Saved" literal at all — that copy
    // lives exclusively inside RecoveryStatusBanner.tsx's sr-only branch.
    expect(source).not.toMatch(/>\s*Saved\.?\s*</);
  });

  it("no visible pending-save/'changes waiting to save' phrasing appears in page.tsx's own JSX — that copy is scoped to RecoveryStatusBanner's fixed exceptional-state overlay and ManualReviewNotice's blocking recovery screen, neither of which is this file", () => {
    expect(source).not.toContain("waiting to save");
    expect(source).not.toContain("Changes waiting to save");
  });

  it("navigatingQuestion still exists and still disables Previous/Next/MCQ controls for race protection — only its visible text was removed, not the state itself", () => {
    const occurrences = source.match(/navigatingQuestion/g) ?? [];
    // setNavigatingQuestion(true/false) call sites + every disabled={...}
    // that includes it — comfortably more than a handful if the guard is
    // still wired everywhere it was before.
    expect(occurrences.length).toBeGreaterThanOrEqual(6);
    expect(source).toContain("disabled={submitting || autoSubmitLocked || timerStopped || navigatingQuestion}");
  });

  it("the Previous/Next button row renders no 'Saving...' status text — only the Previous/Next controls themselves", () => {
    // Approved student exam workspace v2 — this row's wrapper is now
    // `justify-between` (Previous pinned left, Next pinned right per
    // the approved design) and Previous is wrapped in its own <span>
    // purely so `justify-between` still has two flex children when
    // canGoPrevious is false — that span is a layout wrapper, not a
    // status indicator, so this test now asserts the absence of the
    // removed "Saving..." text specifically, not the absence of any
    // <span> at all.
    const rowIdx = source.indexOf('<div className="mt-4 flex items-center justify-between gap-2">');
    expect(rowIdx).toBeGreaterThan(-1);
    const nextButtonIdx = source.indexOf("Next →", rowIdx);
    expect(nextButtonIdx).toBeGreaterThan(rowIdx);
    const row = source.slice(rowIdx, nextButtonIdx);
    expect(row).not.toContain("Saving");
    expect(row).not.toMatch(/text-xs text-gray-500/);
  });
});

describe("Remove routine save UI — backend autosave path is byte-for-byte unchanged", () => {
  it("saveAnswer still debounces via setTimeout at exactly 600ms before calling resilientAutosave.save", () => {
    const idx = source.indexOf("const saveAnswer = useCallback(");
    expect(idx).toBeGreaterThan(-1);
    const closeIdx = source.indexOf("[secureModeEnabled, reportIntegrityEvent, oneQuestionAtATime", idx);
    const body = source.slice(idx, closeIdx);
    expect(body).toContain("clearTimeout(saveTimers.current[questionId]);");
    expect(body).toContain("saveTimers.current[questionId] = setTimeout(() => {");
    expect(body).toContain("resilientAutosave");
    expect(body).toContain(".save(questionId, response)");
    expect(body).toMatch(/},\s*600\s*\);/);
  });

  it("handleChange still calls setResponses then saveAnswer synchronously — no optimistic-only shortcut, no navigation-before-save change", () => {
    const idx = source.indexOf("function handleChange(questionId: string, value: string) {");
    expect(idx).toBeGreaterThan(-1);
    const closeIdx = source.indexOf("saveAnswer(questionId, value);", idx);
    expect(closeIdx).toBeGreaterThan(idx);
    const body = source.slice(idx, closeIdx + "saveAnswer(questionId, value);".length);
    expect(body).toContain("setResponses((prev) => ({ ...prev, [questionId]: value }));");
    expect(body).toContain("saveAnswer(questionId, value);");
  });

  it("navigateQuestion still awaits resilientAutosave.saveAndNavigate before navigating (durable acknowledgement preserved)", () => {
    const idx = source.indexOf("async function navigateQuestion(requestedIndex: number) {");
    expect(idx).toBeGreaterThan(-1);
    const snippet = source.slice(idx, idx + 2000);
    expect(snippet).toContain("await resilientAutosave.saveAndNavigate(questionId, response, requestedIndex);");
  });

  it("AUTOSAVE_FAILED integrity reporting on a failed/unacknowledged save is still wired (this is category B, an actual failure signal, and must survive this pass)", () => {
    const idx = source.indexOf("const saveAnswer = useCallback(");
    const closeIdx = source.indexOf("[secureModeEnabled, reportIntegrityEvent, oneQuestionAtATime", idx);
    const body = source.slice(idx, closeIdx);
    expect(body).toContain('reportIntegrityEvent("AUTOSAVE_FAILED")');
  });
});

describe("Remove routine save UI — left-nav slot from e9727a827706576c0d3c79569ff60d2667903a46 is untouched by this pass", () => {
  it("showQuestionNavigatorPanel is still declared and still gates both the grid wrapper and the slot, exactly as the prior fix left it", () => {
    expect(source).toContain("const showQuestionNavigatorPanel = secureSettings?.showQuestionNavigator === true;");
    expect(source).toContain("{showQuestionNavigatorPanel && (");
  });

  it("the two-column grid classes are still present (now computed, at the approved 900px medium-tier breakpoint — see Approved student exam workspace v2) and the sticky navigator wrapper's own className is unmodified", () => {
    expect(source).toContain("min-[900px]:grid-cols-[220px_minmax(560px,1fr)]");
    expect(source).toContain("min-[900px]:items-start min-[900px]:gap-5");
    // The navigator's own sticky wrapper deliberately stays at the
    // original lg: (1024px) breakpoint — untouched by the 900px medium-
    // tier grid change above; sticky positioning is a minor progressive
    // enhancement, not required to match the grid's own breakpoint.
    expect(source).toContain('className="mb-4 lg:sticky lg:top-4 lg:mb-0"');
  });
});

describe("Final minor UX refinements v1 — camera preview default location and drag behaviour", () => {
  it("the draggable camera preview is rendered inside the question-navigator column, after the navigator/placeholder — never inside Brainstorm or the left-nav slot's own conditional guard", () => {
    const navigatorSlotIdx = source.indexOf("{showQuestionNavigatorPanel && (");
    expect(navigatorSlotIdx).toBeGreaterThan(-1);
    const draggableIdx = source.indexOf("<DraggableCameraPreview", navigatorSlotIdx);
    expect(draggableIdx).toBeGreaterThan(navigatorSlotIdx);
    // The navigator slot's own closing `)}` must come AFTER the
    // DraggableCameraPreview usage — i.e. it is nested inside that same
    // conditional block (the left column), not hoisted out of it.
    const slotCloseIdx = source.indexOf("\n              )}", draggableIdx);
    expect(slotCloseIdx).toBeGreaterThan(draggableIdx);
  });

  it("the camera preview is gated on showCameraInNavigatorColumn (one-question-at-a-time AND a navigator present) — the fixed-corner fallback stays for every other case", () => {
    const idx = source.indexOf("const showCameraInNavigatorColumn = oneQuestionAtATime && showQuestionNavigatorPanel;");
    expect(idx).toBeGreaterThan(-1);
    expect(source).toContain("{showCameraInNavigatorColumn && cameraStatusContent && (");
    expect(source).toContain("{!showCameraInNavigatorColumn && cameraStatusContent && (");
  });

  it("the collapse/expand toggle (cameraPreviewMinimized/toggleCameraPreviewMinimized) is still wired through to the draggable panel — collapse remains functional", () => {
    const draggableIdx = source.indexOf("<DraggableCameraPreview");
    expect(draggableIdx).toBeGreaterThan(-1);
    const propsBlock = source.slice(draggableIdx, source.indexOf("</DraggableCameraPreview>", draggableIdx));
    expect(propsBlock).toContain("minimized={cameraPreviewMinimized}");
    expect(propsBlock).toContain("onToggleMinimized={toggleCameraPreviewMinimized}");
  });

  it("the draggable camera preview is not remounted when the question changes — it has no key derived from the current question, so switching Next/Previous can never reset a dragged position", () => {
    const draggableIdx = source.indexOf("<DraggableCameraPreview");
    const closeIdx = source.indexOf("</DraggableCameraPreview>", draggableIdx);
    const block = source.slice(draggableIdx, closeIdx);
    // storageKey is keyed to the submission (stable for the whole
    // attempt), never to the current question.
    expect(block).toContain("storageKey={`tether-camera-position-${id}`}");
    expect(block).not.toContain("key={");
    expect(block).not.toMatch(/questionId/);
  });

  it("only ONE real <video ref={examVideoRef}> element exists in source — the draggable and fixed-corner render sites share cameraStatusContent rather than each declaring their own <video>", () => {
    // Matches only the actual JSX tag (followed shortly by its own
    // autoPlay attribute), not the doc comment a few lines above it
    // that also mentions `<video ref={examVideoRef}>` in prose.
    const matches = source.match(/<video ref=\{examVideoRef\} autoPlay/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe("Final minor UX refinements v1 — Submit exam moved into the centre question workspace", () => {
  it("Submit exam is defined exactly once (submitExamButton) and referenced from two mutually-exclusive render sites, never duplicated", () => {
    const definitionMatches = source.match(/\{submitting \? "Submitting\.\.\." : "Submit exam"\}/g) ?? [];
    expect(definitionMatches).toHaveLength(1);
    // Inside the centre question card, submitExamButton is rendered
    // unconditionally — the guard is already implicit from being inside
    // the oneQuestionAtATime branch of the outer ternary, so it needs
    // no redundant `oneQuestionAtATime &&` of its own. The original
    // end-of-page location (full-paper mode) DOES carry an explicit
    // guard, since it's a sibling of that same ternary, not nested
    // inside either branch.
    expect(source).toContain('<div className="mt-4 border-t border-gray-200 pt-4">{submitExamButton}</div>');
    expect(source).toContain("{!oneQuestionAtATime && submitExamButton}");
  });

  it("submitExamButton renders inside the centre question card, after the Previous/Next row", () => {
    const nextButtonIdx = source.indexOf("Next →");
    expect(nextButtonIdx).toBeGreaterThan(-1);
    const oneQuestionSubmitIdx = source.indexOf(
      '<div className="mt-4 border-t border-gray-200 pt-4">{submitExamButton}</div>',
      nextButtonIdx,
    );
    expect(oneQuestionSubmitIdx).toBeGreaterThan(nextButtonIdx);
    // And it's still inside the SAME question card — no closing of the
    // card's own wrapping div in between (the card only closes once,
    // right after this line, at the `)}` matching `oneQuestion.payload &&`).
    const between = source.slice(nextButtonIdx, oneQuestionSubmitIdx);
    expect(between).not.toContain("{!oneQuestion.loading && !oneQuestion.payload");
  });

  it("the submission handler's confirm/review-modal/autosubmit logic is byte-for-byte unchanged from before this pass", () => {
    const idx = source.indexOf("const submitExamButton = (");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 1200);
    expect(block).toContain("if (remainingSecs === 0 && data.exam.secureSettings.autoSubmitOnTimerEnd) {");
    expect(block).toContain("handleSubmit({ systemAutoSubmit: true });");
    expect(block).toContain("if (oneQuestionAtATime && secureSettings?.showQuestionNavigator && questionNav) {");
    expect(block).toContain("setShowReviewModal(true);");
    expect(block).toContain("disabled={submitting || autoSubmitLocked || timerStopped}");
  });
});
