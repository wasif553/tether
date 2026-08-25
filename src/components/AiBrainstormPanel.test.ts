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
import { discussingPreview } from "./AiBrainstormPanel";

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
