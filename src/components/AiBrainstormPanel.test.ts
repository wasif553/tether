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
import { discussingPreview, STARTER_ACTIONS } from "./AiBrainstormPanel";

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

describe("Simplify Brainstorm actions — preset buttons", () => {
  it("keeps exactly the two approved presets, in order", () => {
    expect(STARTER_ACTIONS.map((a) => a.label)).toEqual(["Help me understand the question", "Ask me a guiding question"]);
  });

  it("removed the four other presets from the actual button list (still referenced only in an explanatory doc comment, never as a live entry)", () => {
    const removedLabels = [
      "Give me a starting point",
      "Help me organise my ideas",
      "Challenge my reasoning",
      "Suggest what I should check",
    ];
    const labels = STARTER_ACTIONS.map((a) => a.label);
    for (const removed of removedLabels) {
      expect(labels).not.toContain(removed);
    }
    // Exactly two entries — no dead/commented-out object literal left
    // behind in the actual STARTER_ACTIONS array.
    expect(STARTER_ACTIONS).toHaveLength(2);
  });

  it("preserves each surviving preset's exact prompt text unchanged", () => {
    const byLabel = Object.fromEntries(STARTER_ACTIONS.map((a) => [a.label, a.prompt]));
    expect(byLabel["Help me understand the question"]).toBe("Can you help me understand what this question is asking?");
    expect(byLabel["Ask me a guiding question"]).toBe("Can you ask me a guiding question to help me think this through?");
  });
});

describe("Enter-key submission — single form onSubmit path", () => {
  it("the free-text input and Ask button are inside one <form onSubmit>, not a separate onClick handler", () => {
    expect(source).toContain("<form");
    expect(source).toContain("onSubmit={(e) => {");
    expect(source).toContain('type="submit"');
    // No second submission path — the button no longer has its own
    // onClick calling sendPrompt directly (that would double-fire
    // alongside the form's onSubmit on a click, and give Enter and
    // click two different code paths to keep in sync).
    expect(source).not.toContain('onClick={() => sendPrompt(customPrompt)}');
  });

  it("prevents the native page navigation a plain form submit would otherwise cause", () => {
    expect(source).toContain("e.preventDefault();");
  });

  it("the submit control's disabled expression covers empty/whitespace input, in-flight requests, and exhausted limits — the same expression Enter-triggered implicit submission also respects", () => {
    // `disabled` already folds in sending/historyLoading/atQuestionLimit/
    // atAttemptLimit (see its own definition); the submit button adds
    // the empty-input check on top of it. Per the HTML implicit-
    // submission spec, a disabled default submit button also blocks
    // Enter from submitting the form — so this ONE expression is both
    // the click-guard and the Enter-guard, never a duplicated check.
    expect(source).toContain("disabled={disabled || !customPrompt.trim()}");
    expect(source).toContain("const disabled = sending || historyLoading || atQuestionLimit || atAttemptLimit;");
  });

  it("uses a plain single-line text input — no custom onKeyDown handler wired up that could intercept an IME composition Enter", () => {
    // A native <form> + single-line <input type="text"> does not treat
    // an IME-composition-confirming Enter as a submit trigger — that is
    // standard browser behaviour, not something this component
    // implements itself. Checking for the JSX attribute form
    // (`onKeyDown=`), not just the bare word, so this doesn't trip over
    // this test file's/the component's own doc comments that mention
    // onKeyDown by name while explaining why one isn't needed.
    expect(source).toContain('type="text"');
    expect(source).not.toMatch(/onKeyDown\s*=/);
  });
});
