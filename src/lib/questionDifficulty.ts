/**
 * Pool Selection Refinement v1 — see docs/pool-selection-refinement-v1.md.
 * Question.difficulty and BankQuestion.difficulty share this same value
 * set; validated here rather than as a Prisma enum (see Question.difficulty's
 * own schema doc comment for why).
 */
export const QUESTION_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

export const QUESTION_DIFFICULTY_LABELS: Record<QuestionDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export function isQuestionDifficulty(value: unknown): value is QuestionDifficulty {
  return typeof value === "string" && (QUESTION_DIFFICULTIES as readonly string[]).includes(value);
}
