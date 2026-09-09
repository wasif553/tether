/**
 * Question Bank / Exam Pools redesign v1 — see
 * docs/question-bank-exam-pools-v1.md. Single source of truth for
 * Question.source's validated values (a plain String column, not a
 * Prisma enum — see that field's own schema.prisma doc comment for why).
 * Every question-creation call site imports this rather than writing the
 * literal strings inline, so the set can never silently drift.
 */
export const QUESTION_SOURCES = ["MANUAL", "AI_GENERATED", "BULK_IMPORT", "QUESTION_BANK"] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

export const QUESTION_SOURCE_LABELS: Record<QuestionSource, string> = {
  MANUAL: "Manual",
  AI_GENERATED: "AI generated",
  BULK_IMPORT: "Bulk import",
  QUESTION_BANK: "Question Bank",
};
