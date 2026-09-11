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
