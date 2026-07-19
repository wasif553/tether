/**
 * Question Navigator v1 — pure navigation-rule and state-derivation
 * module. See docs/question-navigator-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no
 * browser APIs, no environment variables. Operates entirely on
 * already-resolved data (the submission's persisted selected/ordered
 * question ids, answers, visit/flag records) supplied by the caller
 * (src/lib/questionNavigatorRunner.ts). SERVER AUTHORITY: every function
 * here is the single source of truth the API routes call before
 * accepting a navigation or mutation request — the client's disabled
 * button state is a UX convenience only, never the actual enforcement.
 */

export const QUESTION_DISPLAY_STATES = ["CURRENT", "ANSWERED", "SKIPPED", "NOT_VISITED"] as const;
export type QuestionDisplayState = (typeof QUESTION_DISPLAY_STATES)[number];

export type QuestionType = "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";

/**
 * A meaningful answer exists when there is a non-empty response after
 * trimming whitespace — a whitespace-only response is never "answered".
 * MCQ and short-answer/essay use the same rule (the stored response is
 * always the selected option's text value for MCQ, never a positional
 * index — see docs/one-question-delivery-v1.md).
 */
export function isMeaningfulAnswer(_questionType: QuestionType, response: string | null | undefined): boolean {
  return typeof response === "string" && response.trim().length > 0;
}

/** Current always wins display priority; otherwise answered > visited-but-unanswered (skipped) > never visited. */
export function deriveQuestionDisplayState(params: {
  isCurrent: boolean;
  hasMeaningfulAnswer: boolean;
  visited: boolean;
}): QuestionDisplayState {
  if (params.isCurrent) return "CURRENT";
  if (params.hasMeaningfulAnswer) return "ANSWERED";
  if (params.visited) return "SKIPPED";
  return "NOT_VISITED";
}

// ---------------------------------------------------------------------------
// Navigation authorisation — the actual security boundary.
// ---------------------------------------------------------------------------

export const NAVIGATION_REASON_CODES = [
  "CURRENT",
  "SEQUENTIAL_NEXT_ALLOWED",
  "SEQUENTIAL_PREVIOUS_ALLOWED",
  "FORWARD_JUMP_ALLOWED",
  "BACKWARD_JUMP_ALLOWED",
  "JUMPING_NOT_ALLOWED",
  "BACK_NAVIGATION_NOT_ALLOWED",
  "INVALID_INDEX",
  "SUBMISSION_NOT_IN_PROGRESS",
] as const;
export type NavigationReasonCode = (typeof NAVIGATION_REASON_CODES)[number];

export type NavigationCheckResult = { allowed: boolean; reasonCode: NavigationReasonCode };

/**
 * Authorises a SEQUENTIAL move (the existing Next/Previous buttons —
 * always adjacent, currentIndex ± 1). Behaves EXACTLY as the pre-existing
 * one-question-delivery navigation always has — unaffected by
 * allowQuestionJumping, so every existing exam (which defaults
 * allowQuestionJumping: false) keeps working identically. Backward moves
 * still require allowBackNavigation.
 */
export function canNavigateSequential(params: {
  targetIndex: number;
  currentIndex: number;
  totalQuestions: number;
  allowBackNavigation: boolean;
  submissionInProgress: boolean;
}): NavigationCheckResult {
  if (!params.submissionInProgress) return { allowed: false, reasonCode: "SUBMISSION_NOT_IN_PROGRESS" };
  if (params.targetIndex < 0 || params.targetIndex >= params.totalQuestions) {
    return { allowed: false, reasonCode: "INVALID_INDEX" };
  }
  if (params.targetIndex === params.currentIndex) return { allowed: true, reasonCode: "CURRENT" };
  if (params.targetIndex === params.currentIndex + 1) return { allowed: true, reasonCode: "SEQUENTIAL_NEXT_ALLOWED" };
  if (params.targetIndex === params.currentIndex - 1) {
    return params.allowBackNavigation
      ? { allowed: true, reasonCode: "SEQUENTIAL_PREVIOUS_ALLOWED" }
      : { allowed: false, reasonCode: "BACK_NAVIGATION_NOT_ALLOWED" };
  }
  // A non-adjacent request on the sequential path is never authorised —
  // that always requires the explicit GOTO/direct-navigation path below.
  return { allowed: false, reasonCode: "JUMPING_NOT_ALLOWED" };
}

/**
 * Authorises a DIRECT/GOTO move (grid-tile selection). Per Part 3: every
 * non-current question — including one position away — requires
 * `allowQuestionJumping: true` on this path (the grid is a distinct
 * navigation surface from the Next/Previous buttons). Backward targets
 * additionally require `allowBackNavigation: true`.
 */
export function canNavigateToQuestion(params: {
  targetIndex: number;
  currentIndex: number;
  totalQuestions: number;
  allowQuestionJumping: boolean;
  allowBackNavigation: boolean;
  submissionInProgress: boolean;
}): NavigationCheckResult {
  if (!params.submissionInProgress) return { allowed: false, reasonCode: "SUBMISSION_NOT_IN_PROGRESS" };
  if (params.targetIndex < 0 || params.targetIndex >= params.totalQuestions) {
    return { allowed: false, reasonCode: "INVALID_INDEX" };
  }
  if (params.targetIndex === params.currentIndex) return { allowed: true, reasonCode: "CURRENT" };
  if (!params.allowQuestionJumping) return { allowed: false, reasonCode: "JUMPING_NOT_ALLOWED" };
  if (params.targetIndex > params.currentIndex) return { allowed: true, reasonCode: "FORWARD_JUMP_ALLOWED" };
  return params.allowBackNavigation
    ? { allowed: true, reasonCode: "BACKWARD_JUMP_ALLOWED" }
    : { allowed: false, reasonCode: "BACK_NAVIGATION_NOT_ALLOWED" };
}

// ---------------------------------------------------------------------------
// Navigator tile / progress derivation (GET .../question-navigator)
// ---------------------------------------------------------------------------

export type QuestionStateInput = {
  questionId: string;
  questionType: QuestionType;
  response: string | null;
  visited: boolean;
  flaggedForReview: boolean;
};

export type QuestionNavigatorTile = {
  questionId: string;
  index: number;
  number: number;
  isCurrent: boolean;
  answered: boolean;
  visited: boolean;
  flaggedForReview: boolean;
  state: QuestionDisplayState;
  locked: boolean;
  canNavigate: boolean;
};

export type NavigatorContext = {
  currentIndex: number;
  allowQuestionJumping: boolean;
  allowBackNavigation: boolean;
  submissionInProgress: boolean;
};

/** Builds the full per-question navigator tile array — the pure core of the navigator API's response. */
export function deriveQuestionNavigatorState(
  questions: QuestionStateInput[],
  ctx: NavigatorContext,
): QuestionNavigatorTile[] {
  return questions.map((q, index) => {
    const isCurrent = index === ctx.currentIndex;
    const answered = isMeaningfulAnswer(q.questionType, q.response);
    const nav = canNavigateToQuestion({
      targetIndex: index,
      currentIndex: ctx.currentIndex,
      totalQuestions: questions.length,
      allowQuestionJumping: ctx.allowQuestionJumping,
      allowBackNavigation: ctx.allowBackNavigation,
      submissionInProgress: ctx.submissionInProgress,
    });
    return {
      questionId: q.questionId,
      index,
      number: index + 1,
      isCurrent,
      answered,
      visited: q.visited,
      flaggedForReview: q.flaggedForReview,
      state: deriveQuestionDisplayState({ isCurrent, hasMeaningfulAnswer: answered, visited: q.visited }),
      locked: !nav.allowed,
      canNavigate: nav.allowed,
    };
  });
}

export type ProgressSummary = {
  answeredCount: number;
  unansweredCount: number;
  flaggedCount: number;
  visitedCount: number;
  totalQuestions: number;
};

/** Current question always counts as visited, even before its own SubmissionQuestionState row is written. */
export function summariseQuestionProgress(tiles: QuestionNavigatorTile[]): ProgressSummary {
  const answeredCount = tiles.filter((t) => t.answered).length;
  return {
    answeredCount,
    unansweredCount: tiles.length - answeredCount,
    flaggedCount: tiles.filter((t) => t.flaggedForReview).length,
    visitedCount: tiles.filter((t) => t.visited || t.isCurrent).length,
    totalQuestions: tiles.length,
  };
}

// ---------------------------------------------------------------------------
// Review-before-submit helpers (Part 13)
// ---------------------------------------------------------------------------

function findFirstNavigableMatching(
  tiles: QuestionNavigatorTile[],
  predicate: (tile: QuestionNavigatorTile) => boolean,
  ctx: NavigatorContext,
): number | null {
  for (const t of tiles) {
    if (!predicate(t)) continue;
    const nav = canNavigateToQuestion({
      targetIndex: t.index,
      currentIndex: ctx.currentIndex,
      totalQuestions: tiles.length,
      allowQuestionJumping: ctx.allowQuestionJumping,
      allowBackNavigation: ctx.allowBackNavigation,
      submissionInProgress: ctx.submissionInProgress,
    });
    if (nav.allowed) return t.index;
  }
  return null;
}

/** First unanswered question the student is actually permitted to reopen right now — never bypasses navigation policy. */
export function findFirstNavigableUnanswered(tiles: QuestionNavigatorTile[], ctx: NavigatorContext): number | null {
  return findFirstNavigableMatching(tiles, (t) => !t.answered, ctx);
}

/** First flagged question the student is actually permitted to reopen right now. */
export function findFirstNavigableFlagged(tiles: QuestionNavigatorTile[], ctx: NavigatorContext): number | null {
  return findFirstNavigableMatching(tiles, (t) => t.flaggedForReview, ctx);
}
