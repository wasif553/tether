/**
 * AI Marking Assistance v1 — exam-level marking guide management page.
 * See docs/ai-marking-assistance-v1.md.
 *
 * No jsdom/React-Testing-Library infrastructure exists in this repo (see
 * other *.test.ts files for the same convention) — these assert directly
 * on the page's source text.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("AI Marking Guides page", () => {
  it("reads from the existing GET /api/exams/[id] route — no new GET endpoint added just to read guides", () => {
    expect(pageSource).toMatch(/fetch\(`\/api\/exams\/\$\{examId\}`\)/);
  });

  it("saves via PATCH /api/lecturer/exams/[examId]/marking-guides, in one request for every essay question shown", () => {
    const fnStart = pageSource.indexOf("async function handleSave(");
    const fnEnd = pageSource.indexOf("function handleCopyToAll(", fnStart);
    const fnBlock = pageSource.slice(fnStart, fnEnd);
    expect(fnBlock).toMatch(/fetch\(`\/api\/lecturer\/exams\/\$\{examId\}\/marking-guides`, \{/);
    expect(fnBlock).toMatch(/method: "PATCH"/);
    expect(fnBlock).toMatch(/guides: essayQuestions\.map/);
  });

  it("only shows ESSAY questions — MCQ/SHORT_ANSWER never get a marking-guide field here", () => {
    expect(pageSource).toMatch(/exam\?\.questions\.filter\(\(q\) => q\.type === "ESSAY"\)/);
  });

  it("uses the required terminology: 'AI Marking Guides' heading and 'Lecturer marking guide' label", () => {
    expect(pageSource).toMatch(/title="AI Marking Guides"/);
    expect(pageSource).toMatch(/Lecturer marking guide/);
  });

  it("offers an optional 'Copy this guide to all essay questions' action only when there is more than one essay question", () => {
    const start = pageSource.indexOf("essayQuestions.length > 1");
    expect(start).toBeGreaterThan(-1);
    expect(pageSource).toMatch(/Copy this guide to all essay questions/);
    expect(pageSource).toMatch(/handleCopyToAll/);
  });

  it("has a single 'Save marking guides' action for the whole page, not a per-question save button", () => {
    const occurrences = pageSource.split("Save marking guides").length - 1;
    expect(occurrences).toBe(1);
  });

  it("never implies the AI awards or finalizes a grade — this page only configures marking criteria", () => {
    expect(pageSource.toLowerCase()).not.toMatch(/final grade|ai awarded|ai finalized/);
  });
});
