/**
 * Question-scoped brainstorm sidebar v1 — pure-logic tests for
 * discussingPreview (the "Discussing: ..." header line derivation).
 * No rendering — this repo has no component-render test tooling
 * installed (no @testing-library/react, no jsdom/happy-dom test
 * environment); DOM-level assertions (empty-state copy, guardrail
 * styling, disabled controls) are covered by manual Preview QA instead,
 * consistent with every other client component in this codebase.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discussingPreview } from "./AiBrainstormPanel";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "AiBrainstormPanel.tsx"), "utf8");

describe("discussingPreview", () => {
  it("returns short question text unchanged", () => {
    expect(discussingPreview("Explain photosynthesis.")).toBe("Explain photosynthesis.");
  });

  it("truncates long question text to 70 characters with an ellipsis, never generating a new summary", () => {
    const long = "Evaluate the advantages and disadvantages of migrating a legacy monolith to microservices for a mid-size retailer.";
    const result = discussingPreview(long);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBe(71); // 70 chars + ellipsis
    expect(long.startsWith(result.slice(0, -1))).toBe(true);
  });

  it("collapses internal whitespace/newlines before truncating", () => {
    expect(discussingPreview("Explain   the\nwater cycle.")).toBe("Explain the water cycle.");
  });

  it("does not append an ellipsis when the text is exactly at the boundary", () => {
    const exact = "a".repeat(70);
    expect(discussingPreview(exact)).toBe(exact);
  });
});

describe("Brainstorm counter clarity pass — prompts-remaining display wiring", () => {
  it("uses formatPromptsRemainingLabel for both the per-question and per-exam counters", () => {
    expect(source).toContain('import { formatPromptsRemainingLabel } from "@/lib/brainstormCounterDisplay"');
    expect(source).toContain("formatPromptsRemainingLabel(promptsRemainingForQuestion, maxPromptsPerQuestion)");
    expect(source).toContain("formatPromptsRemainingLabel(promptsRemainingForAttempt, maxPromptsPerAttempt)");
  });

  it("no longer renders the ambiguous bare 'remaining / max' fraction for the two counters", () => {
    expect(source).not.toContain("{promptsRemainingForQuestion ?? \"–\"} / {maxPromptsPerQuestion ?? \"–\"}");
    expect(source).not.toContain("{promptsRemainingForAttempt ?? \"–\"} / {maxPromptsPerAttempt ?? \"–\"}");
  });

  it("still shows two distinct labelled rows — 'This question' and 'This exam' remain two genuinely independent counters", () => {
    expect(source).toContain("<span>This question</span>");
    expect(source).toContain("<span>This exam</span>");
  });
});
