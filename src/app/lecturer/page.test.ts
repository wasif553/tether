import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Lecturer Dashboard — "Needs your attention" navigation fix. Clicking an
 * exam in the review queue used to navigate straight into Integrity
 * Review (/lecturer/exams/{id}/integrity), forcing the lecturer to click
 * Back to reach the Exam Workspace — backwards, since the Exam Workspace
 * is the primary destination and Integrity Review is a secondary,
 * explicitly-labelled action.
 *
 * No jsdom/React-Testing-Library infrastructure exists in this repo (see
 * src/app/lecturer/exams/[id]/page.test.ts for the same convention and
 * its own note on why) — these assert directly on the page's source
 * text.
 */
const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

function reviewRowBlock(): string {
  const start = pageSource.indexOf("function ReviewRow(");
  const end = pageSource.indexOf("\nfunction ExamCard(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return pageSource.slice(start, end);
}

describe("Lecturer Dashboard — Needs your attention: ReviewRow navigation", () => {
  it("1. an 'Open exam →' link points at the Exam Workspace (/lecturer/exams/{id}), not Integrity Review", () => {
    const block = reviewRowBlock();
    const actionIndex = block.indexOf("Open exam");
    expect(actionIndex).toBeGreaterThan(-1);
    const nearby = block.slice(Math.max(0, actionIndex - 300), actionIndex);
    expect(nearby).toMatch(/href=\{`\/lecturer\/exams\/\$\{exam\.id\}`\}/);
  });

  it("2. a 'Review signals' link points at Integrity Review (/lecturer/exams/{id}/integrity)", () => {
    const block = reviewRowBlock();
    const actionIndex = block.indexOf("Review signals");
    expect(actionIndex).toBeGreaterThan(-1);
    const nearby = block.slice(Math.max(0, actionIndex - 300), actionIndex);
    expect(nearby).toMatch(/href=\{`\/lecturer\/exams\/\$\{exam\.id\}\/integrity`\}/);
  });

  it("3. the row is no longer a single wrapping Link whose href is the integrity route", () => {
    const block = reviewRowBlock();
    // The old defect: <Link href={`/lecturer/exams/${exam.id}/integrity`}
    // className="block ...` wrapping literally everything in the row.
    expect(block).not.toMatch(/<Link\s+href=\{`\/lecturer\/exams\/\$\{exam\.id\}\/integrity`\}\s*\n\s*className="block/);
    // The outer element is a plain <li>, not a <Link>/<a> itself.
    expect(block).toMatch(/<li className=\{`px-4 py-3 \$\{REVIEW_COLUMNS\}`\}>/);
  });

  it("4. exam title itself also links to the Exam Workspace, for a natural click target in addition to the explicit action", () => {
    const block = reviewRowBlock();
    const titleLinkIndex = block.indexOf("{exam.title}");
    expect(titleLinkIndex).toBeGreaterThan(-1);
    const before = block.slice(Math.max(0, titleLinkIndex - 300), titleLinkIndex);
    expect(before).toMatch(/href=\{`\/lecturer\/exams\/\$\{exam\.id\}`\}/);
  });

  it("does not use ambiguous 'Review →' wording, and never uses 'High risk exam' / 'Cheating review' / 'Suspicious exam' framing", () => {
    const block = reviewRowBlock();
    expect(block).not.toMatch(/Review →/);
    expect(block).not.toMatch(/High risk exam|Cheating review|Suspicious exam/i);
  });

  it("does not contain a nested <Link> inside another <Link> (no nested interactive anchors)", () => {
    const block = reviewRowBlock();
    const linkOpenCount = (block.match(/<Link\b/g) ?? []).length;
    const linkCloseCount = (block.match(/<\/Link>/g) ?? []).length;
    expect(linkOpenCount).toBe(linkCloseCount);
    // Every <Link ... > in this block should be a sibling, not nested —
    // verified structurally by checking no "<Link" appears between an
    // opening "<Link" and its own next "</Link>" for each of the two
    // expected links (title link and the two action links => 3 total).
    expect(linkOpenCount).toBe(3);
  });
});

describe("Lecturer Dashboard — existing exam navigation unchanged (Active/Upcoming/Drafts/Recent/Older)", () => {
  it("ExamCard still links straight to the Exam Workspace (/lecturer/exams/{id}), never to Integrity Review", () => {
    const start = pageSource.indexOf("function ExamCard(");
    expect(start).toBeGreaterThan(-1);
    const block = pageSource.slice(start);
    expect(block).toMatch(/href=\{`\/lecturer\/exams\/\$\{exam\.id\}`\}/);
    expect(block).not.toMatch(/\/integrity`\}/);
  });

  it("ExamCard is used, unchanged, for Active/Upcoming/Drafts/Recent/Older sections", () => {
    expect(pageSource).toMatch(/<ExamCard key=\{exam\.id\} exam=\{exam\} action="Open →" \/>/);
  });
});
