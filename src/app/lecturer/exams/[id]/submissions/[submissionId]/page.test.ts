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

describe("submission review page — Controlled AI activity summary card (Section 6)", () => {
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

  it("renders 'Controlled AI activity' with the enabled+unused wording 'Enabled — no requests made.' — never implies anything negative", () => {
    expect(pageSource).toMatch(/Controlled AI activity/);
    expect(pageSource).toMatch(/Enabled — no requests made\./);
  });

  it("when enabled with activity, shows requests / guidance shown / declined / questions used counts derived from the same summary object", () => {
    const cardStart = pageSource.indexOf("Controlled AI activity");
    const cardEnd = pageSource.indexOf("</div>", pageSource.indexOf("Enabled for attempt"));
    const cardBlock = pageSource.slice(cardStart, cardEnd);
    expect(cardBlock).toMatch(/aiAssistanceSummary\.summary\.totalRequests/);
    expect(cardBlock).toMatch(/aiAssistanceSummary\.summary\.guidanceShownCount/);
    expect(cardBlock).toMatch(/aiAssistanceSummary\.summary\.declinedCount/);
    expect(cardBlock).toMatch(/aiAssistanceSummary\.summary\.questionsUsedCount/);
  });

  it("links to the existing full AI review route, not a new one", () => {
    expect(pageSource).toMatch(
      /href=\{`\/lecturer\/submissions\/\$\{submissionId\}\/ai-assistance`\}/,
    );
  });

  it("shows a compact 'not enabled' state instead of a large empty card when Controlled AI was off for this attempt", () => {
    expect(pageSource).toMatch(/Controlled AI: Not enabled for this attempt\./);
  });

  it("shows a neutral 'unavailable' state on fetch failure, never blocking the rest of the page", () => {
    expect(pageSource).toMatch(/Controlled AI activity unavailable\./);
  });

  it("never derives or displays an AI risk/misconduct score from this summary", () => {
    const cardStart = pageSource.indexOf("Controlled AI activity");
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
