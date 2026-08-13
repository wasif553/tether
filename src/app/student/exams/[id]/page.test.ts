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
