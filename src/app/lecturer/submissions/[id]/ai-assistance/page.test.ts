/**
 * Controlled AI commercial completion pass — full lecturer AI interaction
 * review page. See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * No jsdom/React-Testing-Library infrastructure exists in this repo (see
 * src/app/lecturer/exams/[id]/page.test.ts for the same convention) —
 * these assert directly on the page's source text.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const pageSource = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const flat = pageSource.replace(/\s+/g, " ");

describe("full AI review page — permitted-resource notice and terminology (Section 4/7)", () => {
  it("still states this is an allowed assessment resource, not an integrity violation", () => {
    expect(flat).toMatch(/Tether Controlled AI was an allowed assessment resource for this attempt/);
    expect(flat).toMatch(/Its permitted use is not an integrity violation/);
  });

  it("uses the commercial name 'Tether Controlled AI' and 'Controlled AI activity' / 'AI interaction record' headings, not the old internal name", () => {
    expect(pageSource).toMatch(/Controlled AI activity/);
    expect(pageSource).toMatch(/AI interaction record/);
    expect(pageSource).not.toMatch(/<h1[^>]*>AI Brainstorming Assistance<\/h1>/);
  });

  it("never introduces AI risk/misconduct/suspicion/dependency language anywhere on the page", () => {
    expect(pageSource.toLowerCase()).not.toMatch(/ai risk|ai misuse|ai suspicion|ai dependency|ai cheating/);
  });

  it("friendly status labels remain exactly: Guidance shown, Request declined, Could not be completed", () => {
    expect(pageSource).toMatch(/APPROVED:\s*"Guidance shown"/);
    expect(pageSource).toMatch(/FALLBACK:\s*"Guidance shown"/);
    expect(pageSource).toMatch(/BLOCKED:\s*"Request declined"/);
    expect(pageSource).toMatch(/FAILED:\s*"Could not be completed"/);
  });

  it("still distinguishes a regenerated APPROVED response and a FALLBACK response from a plain approval, without changing the underlying interaction model", () => {
    expect(pageSource).toMatch(/regenerated under stricter guidance/);
    expect(pageSource).toMatch(/standard guidance response/);
  });

  it("each interaction shows the student's request and Tether's guidance with friendly labels, not raw field names", () => {
    expect(pageSource).toMatch(/Student request:/);
    expect(pageSource).toMatch(/Tether guidance:/);
  });

  it("shows the compact summary (requests / guidance shown / declined / questions used) derived from the review's summary field", () => {
    expect(pageSource).toMatch(/summary\.totalRequests/);
    expect(pageSource).toMatch(/summary\.guidanceShownCount/);
    expect(pageSource).toMatch(/summary\.declinedCount/);
    expect(pageSource).toMatch(/summary\.questionsUsedCount/);
  });

  it("keeps the technical policy version secondary — behind a progressive disclosure, not shown as a prominent badge", () => {
    expect(pageSource).toMatch(/<details>\s*<summary[^>]*>Policy details<\/summary>/);
  });

  it("never exposes provider/internal implementation details in the rendered page (model name, provider name, credentials) — the file-level doc comment documenting that this is intentional is out of scope for this check", () => {
    const componentSource = pageSource.slice(pageSource.indexOf("export default function"));
    expect(componentSource.toLowerCase()).not.toMatch(/anthropic|claude|system prompt|api key/);
  });
});
