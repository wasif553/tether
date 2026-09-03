/**
 * Simplify automatic question pool workflow — see
 * docs/pool-selection-refinement-v1.md.
 *
 * Pure planning helpers behind the "Select automatically" tab of the
 * Add-from-Question-Bank modal (src/app/lecturer/exams/[id]/page.tsx).
 * Extracted out of the component so the eligibility/empty-state/
 * validation logic — the part a lecturer actually needs to trust — is
 * unit-testable without a browser or a rendered React tree, which this
 * repo has no harness for. The component calls these and renders their
 * output; it does not duplicate this logic inline.
 */
import type { QuestionDifficulty } from "./questionDifficulty";

export type BankQuestionForPlanning = {
  id: string;
  type: string;
  topic: string | null;
  difficulty: QuestionDifficulty | null;
};

export type DifficultyCounts = { easy: number; medium: number; hard: number };

export type AutomaticPoolEmptyState =
  | "bank-empty"
  | "no-filter-matches"
  | "all-already-copied"
  | "none-classified"
  | null;

export type AutomaticPoolPlan = {
  matchingFilters: BankQuestionForPlanning[];
  /** matchingFilters minus anything already copied into this exam. */
  matchingFresh: BankQuestionForPlanning[];
  /** Selectable counts, by difficulty — never includes a null-difficulty question. */
  available: DifficultyCounts;
  /**
   * Never silently folded into any Easy/Medium/Hard band — questions
   * with no recorded difficulty simply cannot honestly satisfy a
   * quota, so they're counted separately and surfaced to the lecturer
   * instead of being guessed at.
   */
  unclassifiedCount: number;
  /**
   * Which single message (if any) should replace the normal build-pool
   * UI — ordered most-specific-first: an empty bank beats "nothing
   * matches filters," which beats "everything matching is already
   * copied," which beats "nothing has a difficulty yet."
   */
  emptyState: AutomaticPoolEmptyState;
};

export function planAutomaticPoolSelection(params: {
  bankQuestions: BankQuestionForPlanning[];
  alreadyCopiedIds: Set<string>;
  filterType?: string;
  filterTopic?: string;
}): AutomaticPoolPlan {
  const filterType = params.filterType?.trim() || "";
  const filterTopic = params.filterTopic?.trim().toLowerCase() || "";

  const matchingFilters = params.bankQuestions.filter(
    (q) => (!filterType || q.type === filterType) && (!filterTopic || (q.topic ?? "").toLowerCase().includes(filterTopic)),
  );
  const matchingFresh = matchingFilters.filter((q) => !params.alreadyCopiedIds.has(q.id));

  const available: DifficultyCounts = {
    easy: matchingFresh.filter((q) => q.difficulty === "easy").length,
    medium: matchingFresh.filter((q) => q.difficulty === "medium").length,
    hard: matchingFresh.filter((q) => q.difficulty === "hard").length,
  };
  const unclassifiedCount = matchingFresh.filter((q) => q.difficulty == null).length;
  const totalClassified = available.easy + available.medium + available.hard;

  let emptyState: AutomaticPoolEmptyState = null;
  if (params.bankQuestions.length === 0) emptyState = "bank-empty";
  else if (matchingFilters.length === 0) emptyState = "no-filter-matches";
  else if (matchingFresh.length === 0) emptyState = "all-already-copied";
  else if (totalClassified === 0) emptyState = "none-classified";

  return { matchingFilters, matchingFresh, available, unclassifiedCount, emptyState };
}

/** What the pool will actually contain, by difficulty, once `quotas` are copied in on top of whatever it already has. */
export function computeResultingComposition(existing: DifficultyCounts, quotas: DifficultyCounts): DifficultyCounts {
  return {
    easy: existing.easy + quotas.easy,
    medium: existing.medium + quotas.medium,
    hard: existing.hard + quotas.hard,
  };
}

const DIFFICULTY_BANDS = ["easy", "medium", "hard"] as const;

/** Bands where the requested pool-composition quota exceeds what's actually available. */
export function findOverQuotaBands(quotas: DifficultyCounts, available: DifficultyCounts): QuestionDifficulty[] {
  return DIFFICULTY_BANDS.filter((d) => quotas[d] > available[d]);
}

/** Bands where the requested per-student draw exceeds what the resulting pool will actually contain. */
export function findOverDrawBands(draws: DifficultyCounts, resultingComposition: DifficultyCounts): QuestionDifficulty[] {
  return DIFFICULTY_BANDS.filter((d) => draws[d] > resultingComposition[d]);
}

export function totalOf(counts: DifficultyCounts): number {
  return counts.easy + counts.medium + counts.hard;
}
