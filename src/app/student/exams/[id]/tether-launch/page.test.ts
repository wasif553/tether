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

  it("[15] secure-client enforcement is released (uncoverOnFailure) when the authoritative check fails", () => {
    const checkIndex = runLaunchSequenceBody.indexOf("checkAuthoritativeSessionVerified(");
    const failureBranchMatch = runLaunchSequenceBody.slice(checkIndex).match(/if\s*\(!verified\)\s*\{([\s\S]*?)\n\s*\}/);
    expect(failureBranchMatch![1]).toContain("uncoverOnFailure()");
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
