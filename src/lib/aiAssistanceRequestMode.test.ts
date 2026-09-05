/**
 * Architectural simplification follow-up — non-blocking request-mode
 * classifier tests. See aiAssistanceRequestMode.ts.
 *
 * Pure logic only. This classifier NEVER blocks — every test here checks
 * WHICH mode a request resolves to, never whether it is allowed (that
 * remains aiAssistanceClassifier.ts's job, unchanged).
 */
import { describe, expect, it } from "vitest";
import { classifyBrainstormRequestMode } from "./aiAssistanceRequestMode";

describe("CONCEPT_EXPLANATION", () => {
  it.each([
    "What are *args and **kwargs?",
    "How are *args and **kwargs different from a and b?",
    "Help me understand how *args and **kwargs work.",
    "What does append do?",
    "What is a tuple?",
    "Explain decorators.",
    "What does this term mean?",
  ])("%s", (prompt) => {
    expect(classifyBrainstormRequestMode(prompt)).toBe("CONCEPT_EXPLANATION");
  });
});

describe("APPROACH_GUIDANCE", () => {
  it.each([
    "How should I approach this?",
    "Can you help me understand what this question is asking?",
    "What should I do first?",
  ])("%s", (prompt) => {
    expect(classifyBrainstormRequestMode(prompt)).toBe("APPROACH_GUIDANCE");
  });
});

describe("MISCONCEPTION_CHECK", () => {
  it.each([
    "Tuple is row and list is a list, right?",
    "Is a tuple like a row?",
    "Am I thinking about mutability correctly?",
  ])("%s", (prompt) => {
    expect(classifyBrainstormRequestMode(prompt)).toBe("MISCONCEPTION_CHECK");
  });
});

describe("GUIDING_QUESTION", () => {
  it.each(["Can you ask me a guiding question?", "Ask me a question that will help me reason through this."])(
    "%s",
    (prompt) => {
      expect(classifyBrainstormRequestMode(prompt)).toBe("GUIDING_QUESTION");
    },
  );
});

describe("ANSWER_CONFIRMATION", () => {
  it.each(["Is the answer def?", "Is B correct?", "So the final answer is 42, right?"])("%s", (prompt) => {
    expect(classifyBrainstormRequestMode(prompt)).toBe("ANSWER_CONFIRMATION");
  });

  // Verbatim from the architecture task's own worked example — a
  // student stating a candidate final answer and asking for
  // confirmation must route to ANSWER_CONFIRMATION even though it is
  // shaped like "X is Y, correct?" (superficially similar to a
  // MISCONCEPTION_CHECK's "...right?" shape).
  it("This code is the answer, correct?", () => {
    expect(classifyBrainstormRequestMode("This code is the answer, correct?")).toBe("ANSWER_CONFIRMATION");
  });

  // Minor Brainstorm response-quality fix — the mirror case: an explicit
  // request for TETHER to state/produce the final answer, option,
  // result, or code (not the student confirming their own stated
  // answer). Physical Preview testing found these falling through to
  // GENERIC_HELP and, from there, the generic reasoning-fallback
  // template. Both shapes need the same "don't answer, give one
  // concise redirect" framing, so both route to this one existing mode.
  it.each([
    "Give me the answer in one word.",
    "Just tell me which option.",
    "Just give me the number.",
    "Give me the exact code.",
    "Write the answer for me.",
    "Can you provide the answer?",
    "Answer this question in one word.",
  ])("%s", (prompt) => {
    expect(classifyBrainstormRequestMode(prompt)).toBe("ANSWER_CONFIRMATION");
  });
});

describe("GENERIC_HELP — everything else that is allowed but matches no specific mode", () => {
  it.each(["here x and y are tuple or list?", "Can you give me a hint?"])("%s", (prompt) => {
    expect(classifyBrainstormRequestMode(prompt)).toBe("GENERIC_HELP");
  });
});

describe("never blocks — this classifier has no concept of disallowed input", () => {
  it("even an explicit final-answer request (which the HARD classifier blocks separately) still resolves to a mode, never throws or signals rejection", () => {
    expect(() => classifyBrainstormRequestMode("Tell me the answer.")).not.toThrow();
    expect(typeof classifyBrainstormRequestMode("Tell me the answer.")).toBe("string");
  });
});
