/**
 * One-Question-At-A-Time Exam Delivery v1 — see
 * docs/one-question-delivery-v1.md.
 *
 * Pure, dependency-free helpers: stable per-submission question/option
 * ordering, and forward-only navigation clamping. No DOM, no Prisma, no
 * network — everything here is unit-testable without a browser or
 * database. The actual shuffle only ever runs once, at attempt start
 * (see POST /api/exams/[id]/start) — the resulting order is persisted in
 * Submission.questionOrderJson and always read back from there
 * afterwards, so "stable across refresh" is a property of persistence,
 * not of a reproducible/derivable seed. Nothing here ever exposes a seed
 * to the client — there is no seed, only the already-resolved order.
 */

/** Fisher–Yates shuffle using an injectable RNG (defaults to Math.random) — never mutates the input array. */
export function shuffleWithRng<T>(items: T[], rng: () => number = Math.random): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export type StoredQuestionOrder = {
  questionIds: string[];
  /** Per-question stable MCQ option order, keyed by questionId. Only present for questions actually randomised. */
  optionOrders?: Record<string, string[]>;
};

/**
 * Builds the question order to persist at attempt start. Returns the
 * original (lecturer-defined) order unchanged when randomiseQuestionOrder
 * is false — "preserve original order" is the literal identity function,
 * not a no-op shuffle.
 */
export function buildQuestionOrder(params: {
  questionIds: string[];
  randomiseQuestionOrder: boolean;
  rng?: () => number;
}): string[] {
  if (!params.randomiseQuestionOrder) return [...params.questionIds];
  return shuffleWithRng(params.questionIds, params.rng);
}

/** Builds the per-question MCQ option order to persist at attempt start — empty when randomiseMcqOptionOrder is off. */
export function buildOptionOrders(params: {
  questions: Array<{ id: string; type: string; options: string[] | null }>;
  randomiseMcqOptionOrder: boolean;
  rng?: () => number;
}): Record<string, string[]> {
  if (!params.randomiseMcqOptionOrder) return {};
  const result: Record<string, string[]> = {};
  for (const q of params.questions) {
    if (q.type === "MULTIPLE_CHOICE" && q.options && q.options.length > 1) {
      result[q.id] = shuffleWithRng(q.options, params.rng);
    }
  }
  return result;
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}

/**
 * Resolves the question order to actually use for a submission: the
 * stored order if present and valid (same set of ids as the exam
 * currently has — defensively falls back if a question was added/removed
 * after attempt start), otherwise the original exam order.
 */
export function resolveQuestionOrder(originalIds: string[], stored: unknown): string[] {
  if (
    stored &&
    typeof stored === "object" &&
    Array.isArray((stored as StoredQuestionOrder).questionIds) &&
    sameIdSet((stored as StoredQuestionOrder).questionIds, originalIds)
  ) {
    return (stored as StoredQuestionOrder).questionIds;
  }
  return originalIds;
}

/** Resolves the MCQ option order to display for one question — same fallback-if-invalid rule as resolveQuestionOrder. */
export function resolveOptionOrder(
  questionId: string,
  originalOptions: string[],
  stored: unknown,
): string[] {
  if (stored && typeof stored === "object") {
    const optionOrders = (stored as StoredQuestionOrder).optionOrders;
    const storedOptions = optionOrders?.[questionId];
    if (Array.isArray(storedOptions) && sameIdSet(storedOptions, originalOptions)) {
      return storedOptions;
    }
  }
  return originalOptions;
}

/** Clamps an index into the valid [0, total-1] range (or 0 if total is 0). */
export function clampQuestionIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(index, 0), total - 1);
}

export function canNavigatePrevious(currentIndex: number, allowBackNavigation: boolean): boolean {
  return allowBackNavigation && currentIndex > 0;
}

export function canNavigateNext(currentIndex: number, total: number): boolean {
  return currentIndex < total - 1;
}

/**
 * The actual index to persist/serve for a navigation request: clamps to
 * valid bounds, and — when back-navigation is disabled — never allows the
 * stored position to move backward, so "once the student moves forward,
 * they cannot return to earlier questions" holds even against a direct
 * API call, not just a disabled button in the UI.
 */
export function nextAllowedIndex(
  requestedIndex: number,
  storedIndex: number,
  allowBackNavigation: boolean,
  total: number,
): number {
  const clamped = clampQuestionIndex(requestedIndex, total);
  if (!allowBackNavigation && clamped < storedIndex) return storedIndex;
  return clamped;
}

/** Whether a navigation request was actually a blocked back-navigation attempt (for integrity logging). */
export function isBlockedBackNavigation(
  requestedIndex: number,
  storedIndex: number,
  allowBackNavigation: boolean,
): boolean {
  return !allowBackNavigation && requestedIndex < storedIndex;
}
