/**
 * Manual multi-question entry (Assessment Operations v1 follow-up) —
 * see docs/assessment-operations-v1.md. Pure, dependency-free draft
 * validation so the exact same rules run client-side (as the lecturer
 * fills in each card) and server-side (the API route re-validates
 * every draft itself — it never trusts a client-computed result,
 * matching the same discipline as src/lib/bulkQuestionParser.ts).
 */

export type ManualQuestionType = "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";

export type ManualQuestionDraft = {
  type: ManualQuestionType;
  text: string;
  options: string[];
  correctAnswer: string;
  points: number;
};

export function createEmptyManualDraft(): ManualQuestionDraft {
  return { type: "MULTIPLE_CHOICE", text: "", options: ["", "", "", ""], correctAnswer: "", points: 1 };
}

/** Returns a list of human-readable errors; an empty array means the draft is valid. */
export function validateManualDraft(draft: ManualQuestionDraft): string[] {
  const errors: string[] = [];

  if (!draft.text.trim()) errors.push("Question text is required.");

  if (draft.type === "MULTIPLE_CHOICE") {
    const filledOptions = draft.options.map((o) => o.trim()).filter(Boolean);
    if (filledOptions.length < 2) {
      errors.push("MCQ questions require at least two options.");
    }
    const trimmedAnswer = draft.correctAnswer.trim();
    if (!trimmedAnswer) {
      errors.push("Correct answer is required for MCQ questions.");
    } else if (filledOptions.length >= 2 && !filledOptions.includes(trimmedAnswer)) {
      errors.push("Correct answer must match one of the options.");
    }
  }

  if (!Number.isFinite(draft.points) || !Number.isInteger(draft.points) || draft.points <= 0) {
    errors.push("Points must be greater than 0.");
  }

  return errors;
}

export type NormalizedQuestion = {
  type: ManualQuestionType;
  text: string;
  options: string[];
  correctAnswer: string | null;
  points: number;
};

/**
 * Converts a validated draft into the same shape the exam-question save
 * path expects (essay never carries a correctAnswer; empty option slots
 * are dropped). Callers must validate first — this does not re-check.
 */
export function normalizeManualDraft(draft: ManualQuestionDraft): NormalizedQuestion {
  const options = draft.options.map((o) => o.trim()).filter(Boolean);
  return {
    type: draft.type,
    text: draft.text.trim(),
    options: draft.type === "MULTIPLE_CHOICE" ? options : [],
    correctAnswer: draft.type === "ESSAY" ? null : draft.correctAnswer.trim() || null,
    points: draft.points,
  };
}
