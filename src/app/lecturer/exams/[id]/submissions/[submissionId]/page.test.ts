/**
 * Controlled AI commercial completion pass — lecturer submission review
 * page. See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * No jsdom/React-Testing-Library infrastructure exists in this repo (see
 * src/app/lecturer/exams/[id]/page.test.ts and other *.test.ts files for
 * the same convention) — these assert directly on the page's source text.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("submission review page — Student Brainstorm Activity summary card (Section 6)", () => {
  it("fetches the summary from the EXISTING lecturer AI-assistance review endpoint — no new endpoint added", () => {
    expect(pageSource).toMatch(
      /fetch\(`\/api\/lecturer\/submissions\/\$\{submissionId\}\/ai-assistance`\)/,
    );
  });

  it("the summary fetch is a non-blocking secondary load — failures set an error flag, they never throw uncaught or block the main data load", () => {
    const loaderStart = pageSource.indexOf("const loadAiAssistanceSummary = useCallback(");
    const loaderEnd = pageSource.indexOf("}, [submissionId]);", loaderStart);
    const loaderBlock = pageSource.slice(loaderStart, loaderEnd);
    expect(loaderBlock).toMatch(/try\s*\{/);
    expect(loaderBlock).toMatch(/catch\s*\{/);
    expect(loaderBlock).toMatch(/setAiAssistanceSummaryError\(true\)/);
  });

  it("renders 'Student Brainstorm Activity' with the enabled+unused wording 'Enabled — no requests made.' — never implies anything negative", () => {
    expect(pageSource).toMatch(/Student Brainstorm Activity/);
    expect(pageSource).toMatch(/Enabled — no requests made\./);
  });

  it("when enabled with activity, shows requests / guidance shown / declined / questions used counts derived from the same summary object", () => {
    const cardStart = pageSource.indexOf("Student Brainstorm Activity");
    const cardEnd = pageSource.indexOf("</div>", pageSource.indexOf("Enabled for attempt"));
    const cardBlock = pageSource.slice(cardStart, cardEnd);
    expect(cardBlock).toMatch(/aiAssistanceSummary\.summary\.totalRequests/);
    expect(cardBlock).toMatch(/aiAssistanceSummary\.summary\.guidanceShownCount/);
    expect(cardBlock).toMatch(/aiAssistanceSummary\.summary\.declinedCount/);
    expect(cardBlock).toMatch(/aiAssistanceSummary\.summary\.questionsUsedCount/);
  });

  it("links to the existing full AI review route, not a new one, labeled 'View Student AI Activity' — no separate/duplicate top-level button pointing at the same route", () => {
    expect(pageSource).toMatch(
      /href=\{`\/lecturer\/submissions\/\$\{submissionId\}\/ai-assistance`\}/,
    );
    expect(pageSource).toMatch(/View Student AI Activity →/);
    const occurrences = pageSource.split("/ai-assistance`").length - 1;
    expect(occurrences).toBe(2); // the fetch() call + the one Link href — never a second nav button to the same place
  });

  it("shows a compact 'not enabled' state instead of a large empty card when Controlled AI was off for this attempt", () => {
    expect(pageSource).toMatch(/Controlled AI: Not enabled for this attempt\./);
  });

  it("shows a neutral 'unavailable' state on fetch failure, never blocking the rest of the page", () => {
    expect(pageSource).toMatch(/Controlled AI activity unavailable\./);
  });

  it("never derives or displays an AI risk/misconduct score from this summary", () => {
    const cardStart = pageSource.indexOf("Student Brainstorm Activity");
    const cardEnd = pageSource.indexOf("<div className=\"space-y-4\">");
    const cardBlock = pageSource.slice(cardStart, cardEnd);
    expect(cardBlock.toLowerCase()).not.toMatch(/risk score|misconduct|suspicion|dependency/);
  });
});

describe("submission review page — Integrity evidence timeline compact card (Section 3/6 of the Timeline v1 spec)", () => {
  it("fetches the summary from the timeline endpoint as a secondary, non-blocking load", () => {
    const loaderStart = pageSource.indexOf("const loadTimelineSummary = useCallback(");
    const loaderEnd = pageSource.indexOf("}, [submissionId]);", loaderStart);
    const loaderBlock = pageSource.slice(loaderStart, loaderEnd);
    expect(loaderBlock).toMatch(/fetch\(`\/api\/lecturer\/submissions\/\$\{submissionId\}\/timeline`\)/);
    expect(loaderBlock).toMatch(/try\s*\{/);
    expect(loaderBlock).toMatch(/catch\s*\{/);
    expect(loaderBlock).toMatch(/setTimelineSummaryError\(true\)/);
  });

  it("renders 'Integrity evidence timeline' with the factual explanation and count summary — no percentage, no score", () => {
    const cardStart = pageSource.indexOf("Integrity evidence timeline");
    const cardEnd = pageSource.indexOf("<div className=\"space-y-4\">");
    const cardBlock = pageSource.slice(cardStart, cardEnd);
    expect(cardBlock).toMatch(/Reconstruct this attempt from exam activity, Tether security events and supporting evidence\./);
    expect(cardBlock).toMatch(/timelineSummary\.totalEvents/);
    expect(cardBlock).toMatch(/timelineSummary\.evidenceAssetCount/);
    expect(cardBlock).toMatch(/timelineSummary\.needsReviewCount/);
    expect(cardBlock.toLowerCase()).not.toMatch(/coverage|completeness|risk score|cheating score/);
  });

  it("links to the full timeline route", () => {
    expect(pageSource).toMatch(/href=\{`\/lecturer\/submissions\/\$\{submissionId\}\/timeline`\}/);
    expect(pageSource).toMatch(/View timeline →/);
  });

  it("shows a neutral 'unavailable' state on fetch failure, never blocking grading or the rest of the page", () => {
    expect(pageSource).toMatch(/Integrity timeline unavailable\./);
  });
});

// AI Marking Assistance v1 — see docs/ai-marking-assistance-v1.md. Distinct
// from the "Student Brainstorm Activity" section tested above: this is the
// lecturer-facing essay-marking helper, never the Tether Brainstorm
// transcript.
describe("submission review page — AI Marking Assistance (per-question)", () => {
  it("calls the single-answer endpoint with NO request body — the marking guide always comes from the saved question, never typed on this page", () => {
    const fnStart = pageSource.indexOf("async function handleGetAiMarkingSuggestion(");
    const fnEnd = pageSource.indexOf('if (!data) return <LoadingState', fnStart);
    const fnBlock = pageSource.slice(fnStart, fnEnd);
    expect(fnBlock).toMatch(/fetch\(`\/api\/lecturer\/submissions\/\$\{submissionId\}\/answers\/\$\{questionId\}\/ai-mark`/);
    expect(fnBlock).not.toMatch(/ai-mark-essays/);
    expect(fnBlock).not.toMatch(/lecturerGuide/);
    expect(fnBlock).not.toMatch(/body:\s*JSON\.stringify/);
  });

  it("shows the 'AI Marking Assistance' guide-status panel only for an ESSAY question with no draft yet, never for MCQ, and never a textarea to type a guide", () => {
    const blockStart = pageSource.indexOf('{q.type === "ESSAY" && !hasAiDraft && (');
    const blockEnd = pageSource.indexOf('<div className="mt-2 flex items-center gap-3">', blockStart);
    const block = pageSource.slice(blockStart, blockEnd);
    expect(block).toMatch(/<AiMarkingGuideStatus guideText=\{q\.aiMarkingGuide \?\? null\} \/>/);
    expect(block).toMatch(/Get AI marking suggestion/);
    expect(block).not.toMatch(/<textarea/);
    expect(block).not.toMatch(/Optional: paste or describe your marking guide/);
  });

  it("the guide-status panel reads Marking guide: Lecturer marking guide / Tether default rubric from the question's own saved field", () => {
    const cStart = pageSource.indexOf("function AiMarkingGuideStatus(");
    const cEnd = pageSource.indexOf("Oral Verification Workflow v1", cStart);
    const cBlock = pageSource.slice(cStart, cEnd);
    expect(cBlock).toMatch(/Marking guide:/);
    expect(cBlock).toMatch(/Lecturer marking guide/);
    expect(cBlock).toMatch(/Tether default rubric/);
    expect(cBlock).toMatch(/View guide/);
  });

  it("uses the required terminology for the result display — Suggested score, Criterion breakdown, Strengths, Areas to improve", () => {
    expect(pageSource).toMatch(/Suggested score: \{answer\?\.aiDraftScore\}/);
    expect(pageSource).toMatch(/Criterion breakdown/);
    expect(pageSource).toMatch(/>Strengths</);
    expect(pageSource).toMatch(/Areas to improve/);
  });

  it("distinguishes a lecturer-supplied guide from the default rubric, with a 'View guide' toggle only for the lecturer-guide case", () => {
    expect(pageSource).toMatch(/Based on lecturer marking guide/);
    expect(pageSource).toMatch(/Based on Tether default rubric/);
    expect(pageSource).toMatch(/View guide/);
    expect(pageSource).toMatch(/aiResult\?\.rubricSource === "LECTURER"/);
  });

  it("offers 'Regenerate suggestion' next to the existing 'Accept AI draft' and 'Show details' actions, reusing the same single-answer endpoint", () => {
    const draftBlockStart = pageSource.indexOf('{hasAiDraft && (');
    const draftBlockEnd = pageSource.indexOf('{q.type === "ESSAY" && !hasAiDraft && (');
    const draftBlock = pageSource.slice(draftBlockStart, draftBlockEnd);
    expect(draftBlock).toMatch(/Accept AI draft/);
    expect(draftBlock).toMatch(/Show details/);
    expect(draftBlock).toMatch(/Regenerate suggestion/);
  });

  it("Accept AI draft only pre-fills the editable score — it never calls a save/finalize endpoint itself", () => {
    const fnStart = pageSource.indexOf("function handleAcceptAiDraft(");
    const fnEnd = pageSource.indexOf("AI Marking Assistance v1 — requests", fnStart);
    const fnBlock = pageSource.slice(fnStart, fnEnd);
    expect(fnBlock).toMatch(/setScores/);
    expect(fnBlock).not.toMatch(/fetch\(/);
  });

  it("never uses wording implying the AI awarded or finalized the grade", () => {
    const start = pageSource.indexOf("AI Marking Assistance");
    const end = pageSource.indexOf("Finalize grade");
    const section = pageSource.slice(start, end).toLowerCase();
    expect(section).not.toMatch(/ai awarded|ai finalized|ai graded the|automatically graded|final grade has been set by ai/);
  });

  it("the new single-answer route enforces lecturer ownership, institution scope, ESSAY-only eligibility, and never touches Submission.status/totalScore", () => {
    const routeSource = fs.readFileSync(
      path.join(__dirname, "../../../../../api/lecturer/submissions/[id]/answers/[questionId]/ai-mark/route.ts"),
      "utf8",
    );
    expect(routeSource).toMatch(/role !== "LECTURER"/);
    expect(routeSource).toMatch(/assertSameInstitution/);
    expect(routeSource).toMatch(/question\.type !== "ESSAY"/);
    expect(routeSource).not.toMatch(/submission\.update/);
    expect(routeSource).not.toMatch(/status: "GRADED"/);
  });
});

// VOIDED-attempt recovery v1 — see docs/voided-submission-recovery-v1.md.
// Eligibility itself (test items A-F) is exercised precisely, end to end,
// against a real database in voidedSubmissionRecovery.routes.test.ts via
// GET /api/submissions/[id]'s own voidRecoveryEligible field — this page
// never re-derives or second-guesses that computation, only reads it. The
// tests below are source-level, matching this repo's established
// no-jsdom convention, and cover exactly what this page itself controls:
// wording, gating on the server-provided flag, required-reason
// enforcement, and honest 409/success handling.
describe("submission review page — 'Void technical attempt and allow restart' (VOIDED-attempt recovery v1)", () => {
  it("names the action exactly 'Void technical attempt and allow restart' — never a generic reset/delete/void label", () => {
    expect(pageSource).toMatch(/Void technical attempt and allow restart/);
    expect(pageSource.toLowerCase()).not.toMatch(/>reset attempt<|>delete attempt<|>clear attempt</);
  });

  it("the trigger button is gated ONLY on the server-computed data.voidRecoveryEligible — never a client-side re-derivation of eligibility", () => {
    const triggerBlockStart = pageSource.indexOf("{data.voidRecoveryEligible && (");
    expect(triggerBlockStart).toBeGreaterThan(-1);
    const triggerBlockEnd = pageSource.indexOf("{voidDialogOpen && (", triggerBlockStart);
    const triggerBlock = pageSource.slice(triggerBlockStart, triggerBlockEnd);
    expect(triggerBlock).toMatch(/Void technical attempt and allow restart/);
    // Never a hand-rolled eligibility expression in the JSX itself —
    // no direct reference to secureClientPolicySnapshotJson/deliveryMode
    // fields, which would mean this page tried to re-implement the check.
    expect(triggerBlock).not.toMatch(/secureClientPolicySnapshotJson/);
    expect(triggerBlock).not.toMatch(/requireVerifiedClient/);
  });

  it("C/G: the confirmation dialog explains the required points and requires a non-empty reason before the primary action is enabled", () => {
    const dialogStart = pageSource.indexOf("Void technical attempt and allow restart?");
    const dialogEnd = pageSource.indexOf("{aiAssistanceSummary?.aiAssistanceEnabled", dialogStart);
    expect(dialogStart).toBeGreaterThan(-1);
    expect(dialogEnd).toBeGreaterThan(dialogStart);
    const dialogBlock = pageSource.slice(dialogStart, dialogEnd);
    expect(dialogBlock).toMatch(/cannot be securely resumed/i);
    expect(dialogBlock).toMatch(/preserved/i);
    expect(dialogBlock).toMatch(/marked Voided/i);
    expect(dialogBlock).toMatch(/not generate a score/i);
    expect(dialogBlock).toMatch(/not count against the student.{0,10}s permitted number of attempts/i);
    expect(dialogBlock).toMatch(/start a fresh/i);
    expect(dialogBlock).toMatch(/Reason \(required\)/);
    expect(dialogBlock).toMatch(/disabled=\{voidSubmitting \|\| !voidReason\.trim\(\)\}/);
  });

  it("primary/secondary button wording matches exactly: 'Void attempt and allow restart' and 'Cancel'", () => {
    expect(pageSource).toMatch(/Void attempt and allow restart/);
    const dialogStart = pageSource.indexOf("Void technical attempt and allow restart?");
    const dialogEnd = pageSource.indexOf("{aiAssistanceSummary?.aiAssistanceEnabled", dialogStart);
    const dialogBlock = pageSource.slice(dialogStart, dialogEnd);
    expect(dialogBlock).toMatch(/>\s*Cancel\s*</);
  });

  it("never implies student misconduct anywhere in the dialog or trigger copy", () => {
    const start = pageSource.indexOf("Secure delivery mismatch detected");
    const end = pageSource.indexOf("{aiAssistanceSummary?.aiAssistanceEnabled", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = pageSource.slice(start, end).toLowerCase();
    expect(section).not.toMatch(/misconduct|cheat|dishonest|violation|suspicious/);
  });

  it("J: on a non-ok response the error is surfaced from the server's own body.error, the dialog is never closed, and the page state is refreshed rather than assumed", () => {
    const fnStart = pageSource.indexOf("async function handleVoidAttempt(");
    const fnEnd = pageSource.indexOf("async function handleFinalize(", fnStart);
    const fnBlock = pageSource.slice(fnStart, fnEnd);
    const notOkBlockStart = fnBlock.indexOf("if (!res.ok) {");
    const notOkBlockEnd = fnBlock.indexOf("return;", notOkBlockStart);
    const notOkBlock = fnBlock.slice(notOkBlockStart, notOkBlockEnd);
    expect(notOkBlock).toMatch(/body\?\.error/);
    expect(notOkBlock).toMatch(/setVoidError/);
    expect(notOkBlock).not.toMatch(/setVoidDialogOpen\(false\)/);
    expect(notOkBlock).toMatch(/loadSubmission\(\)/);
  });

  it("H/L: on success the dialog closes, a preservation-confirming message is shown, and the submission is re-fetched — voidRecoveryEligible naturally becomes false server-side, so the trigger disappears without any separate client-side hiding logic", () => {
    const fnStart = pageSource.indexOf("async function handleVoidAttempt(");
    const fnEnd = pageSource.indexOf("async function handleFinalize(", fnStart);
    const fnBlock = pageSource.slice(fnStart, fnEnd);
    const successBlockStart = fnBlock.indexOf("setVoidDialogOpen(false);");
    expect(successBlockStart).toBeGreaterThan(-1);
    const successBlock = fnBlock.slice(successBlockStart);
    expect(successBlock).toMatch(/setVoidSuccessMessage\(/);
    expect(successBlock).toMatch(/preserved/i);
    expect(successBlock).toMatch(/fresh attempt/i);
    expect(successBlock).toMatch(/loadSubmission\(\)/);
    // The trigger itself is unconditionally gated on data.voidRecoveryEligible
    // (checked above) — once loadSubmission() refetches a VOIDED row, the
    // server reports voidRecoveryEligible: false and the button vanishes
    // with no extra logic needed here.
  });

  it("the request body sent to POST /void carries only reason and confirm — never the snapshot, never any submission field the server should be computing fresh", () => {
    const fnStart = pageSource.indexOf("async function handleVoidAttempt(");
    const fnEnd = pageSource.indexOf("async function handleFinalize(", fnStart);
    const fnBlock = pageSource.slice(fnStart, fnEnd);
    expect(fnBlock).toMatch(/JSON\.stringify\(\{ reason: voidReason\.trim\(\), confirm: true \}\)/);
  });

  it("Voided renders as a clean, neutral status label — never as Submitted/Graded/Pending grading", () => {
    expect(pageSource).toMatch(/VOIDED:\s*"Voided"/);
    expect(pageSource).toMatch(/SUBMISSION_STATUS_LABELS\[data\.status\]/);
  });

  it("a VOIDED submission never shows the 'Finalize grade' action — it is hidden, not left to fail on click", () => {
    const guardIdx = pageSource.indexOf('{data.status !== "VOIDED" && (');
    const financeIdx = pageSource.indexOf("Finalize grade", guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(financeIdx).toBeGreaterThan(guardIdx);
    expect(financeIdx - guardIdx).toBeLessThan(600); // the guard directly wraps the Finalize button, not some unrelated later block
  });
});
