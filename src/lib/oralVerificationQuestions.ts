/**
 * Oral Verification Workflow v1 — see
 * docs/oral-verification-workflow-v1.md.
 *
 * Deterministic follow-up question generation — pure, no LLM, no
 * network, no Prisma, no DOM. Generates 3–5 discussion questions from
 * the student's ACTUAL submitted answer and the original question text,
 * using fixed templates plus important terms extracted from the answer.
 * The lecturer can edit every generated question before use; nothing is
 * ever sent or scheduled automatically. Never includes the correct
 * answer. (Optional AI-assisted generation may be layered on later
 * behind the existing AI configuration, but this deterministic path must
 * always work standalone.)
 */
import { normalizeAnswerText, tokenizeNormalized } from "@/lib/answerSimilarity";

export const ORAL_VERIFICATION_STATUSES = [
  "NOT_REQUIRED",
  "REQUIRED",
  "SCHEDULED",
  "COMPLETED_NO_CONCERN",
  "COMPLETED_CONCERN_REMAINS",
  "CANCELLED",
] as const;
export type OralVerificationStatus = (typeof ORAL_VERIFICATION_STATUSES)[number];

export function isValidOralVerificationStatus(value: string): value is OralVerificationStatus {
  return (ORAL_VERIFICATION_STATUSES as readonly string[]).includes(value);
}

/** Neutral labels — never "suspected of cheating". */
export const ORAL_VERIFICATION_STATUS_LABELS: Record<OralVerificationStatus, string> = {
  NOT_REQUIRED: "Not required",
  REQUIRED: "Oral verification recommended",
  SCHEDULED: "Scheduled",
  COMPLETED_NO_CONCERN: "Reviewed — no concern",
  COMPLETED_CONCERN_REMAINS: "Concern remains",
  CANCELLED: "Cancelled",
};

/** Neutral wording for any student-facing notification — see docs/oral-verification-workflow-v1.md. */
export const ORAL_VERIFICATION_STUDENT_NOTICE =
  "A follow-up academic discussion has been requested for this assessment.";

// Common words that should never be treated as "important terms".
const STOPWORDS = new Set(
  (
    "the a an and or but if then else of to in on at for with from by as is are was were be been being " +
    "this that these those it its they them their there here we you i he she his her not no yes do does " +
    "did done can could should would will shall may might must have has had having about into over under " +
    "between because so such which what when where who whom whose how why more most some any all each very " +
    "also just only than too own same other another my our your us"
  ).split(" "),
);

const IMPORTANT_TERM_MIN_LENGTH = 5;
const MAX_IMPORTANT_TERMS = 3;

/**
 * Extracts up to MAX_IMPORTANT_TERMS distinctive terms from the
 * student's answer: non-stopword tokens of meaningful length, ranked by
 * frequency then length, first-seen order as tiebreak. Deterministic.
 */
export function extractImportantTerms(answerText: string | null | undefined): string[] {
  const tokens = tokenizeNormalized(normalizeAnswerText(answerText));
  const counts = new Map<string, { count: number; firstIndex: number }>();
  tokens.forEach((token, index) => {
    if (token.length < IMPORTANT_TERM_MIN_LENGTH || STOPWORDS.has(token) || /^\d+$/.test(token)) return;
    const existing = counts.get(token);
    if (existing) existing.count++;
    else counts.set(token, { count: 1, firstIndex: index });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[0].length - a[0].length || a[1].firstIndex - b[1].firstIndex)
    .slice(0, MAX_IMPORTANT_TERMS)
    .map(([term]) => term);
}

export type OralQuestionGenerationInput = {
  /** 1-based question number as shown to the lecturer (display context only). */
  questionNumber: number;
  questionText: string;
  answerText: string | null;
};

/**
 * Generates 3–5 deterministic discussion questions grounded in the
 * student's actual response. Never includes or hints at the correct
 * answer (this function is never given it).
 */
export function generateOralVerificationQuestions(input: OralQuestionGenerationInput): string[] {
  const questions: string[] = [
    `Explain how you arrived at your answer to Question ${input.questionNumber}.`,
    `Walk through the reasoning or calculation in your answer to Question ${input.questionNumber} step by step.`,
    `Identify one limitation of the approach you used in Question ${input.questionNumber}.`,
  ];
  const terms = extractImportantTerms(input.answerText);
  if (terms[0]) {
    questions.push(`Explain the meaning of "${terms[0]}" in your own words, as you used it in your answer.`);
  }
  if (terms[1]) {
    questions.push(`Give an alternative example that demonstrates the same concept as "${terms[1]}".`);
  }
  return questions.slice(0, 5);
}
