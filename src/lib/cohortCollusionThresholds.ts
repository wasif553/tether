/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — versioned
 * threshold configuration. See docs/cohort-collusion-graph-v1.md.
 *
 * Every number that decides whether a pair edge becomes eligible for
 * clustering, whether a cluster reaches NEEDS_REVIEW/HIGHER_CONCERN, or
 * how a signal is weighted lives here — never scattered across routes or
 * UI components. Bumping COHORT_COLLUSION_ALGORITHM_VERSION is the
 * documented way to change scoring behaviour for future analysis runs
 * without touching historical CohortCollusionAnalysis rows (whose
 * algorithmVersion field records which version produced them — exactly
 * the SIMILARITY_ALGORITHM_VERSION/TIME_ANOMALY_ALGORITHM_VERSION
 * precedent).
 *
 * Pure, dependency-free: no Prisma, no Next.js.
 */

export const COHORT_COLLUSION_ALGORITHM_VERSION = "v1.0";

// ---------------------------------------------------------------------------
// Signal families — Part 2/3. A pair edge or cluster's "independent family
// count" is the size of the SET of families below with at least one
// signal, never a raw signal count: three ANSWER_CONTENT signals still
// count as one family.
// ---------------------------------------------------------------------------

export const SIGNAL_FAMILIES = [
  "ANSWER_CONTENT",
  "RARE_MISTAKE",
  "MCQ_PATTERN",
  "TIMING_SYNCHRONISATION",
  "SESSION_NETWORK_DEVICE",
  "CROSS_EXAM_RECURRENCE",
] as const;
export type SignalFamily = (typeof SIGNAL_FAMILIES)[number];

export function isValidSignalFamily(value: string): value is SignalFamily {
  return (SIGNAL_FAMILIES as readonly string[]).includes(value);
}

/**
 * Maximum contribution ONE family can make to an edge's combinedScore, no
 * matter how many or how strong its individual signals are — "each signal
 * family must have a maximum contribution so one family cannot dominate
 * the combined score" (Part 3). SESSION_NETWORK_DEVICE and
 * CROSS_EXAM_RECURRENCE are capped lowest: a shared network/device is
 * explicitly "weak support" (students legitimately share university
 * networks, accommodation, libraries), and cross-exam recurrence is
 * explicitly "supporting evidence only" — see docs.
 */
export const FAMILY_SCORE_CAPS: Record<SignalFamily, number> = {
  ANSWER_CONTENT: 0.4,
  RARE_MISTAKE: 0.4,
  MCQ_PATTERN: 0.35,
  TIMING_SYNCHRONISATION: 0.35,
  SESSION_NETWORK_DEVICE: 0.2,
  CROSS_EXAM_RECURRENCE: 0.3,
};

/**
 * Families that are explicitly "supporting/corroborating evidence only" —
 * a shared network/device (students legitimately share university
 * networks, accommodation, libraries) or bare cross-exam recurrence
 * (meaningless without a concurrent behavioural signal). A member must
 * never remain in a cluster whose ENTIRE support, across every edge it
 * has into that cluster, comes only from families in this set — see
 * pruneUnsupportedMembers() in src/lib/cohortCollusion/graph.ts, which
 * implements "no isolated member included solely through a weak
 * shared-network relationship" (Part 3).
 */
export const WEAK_SUPPORT_ONLY_FAMILIES: readonly SignalFamily[] = ["SESSION_NETWORK_DEVICE", "CROSS_EXAM_RECURRENCE"];

// ---------------------------------------------------------------------------
// Pair-edge eligibility — Part 3, "the most important safety requirement".
// An edge becomes eligibleForClustering ONLY when BOTH conditions hold.
// Because every cap above is well below this threshold, no single family
// can ever push combinedScore over PAIR_ELIGIBILITY_SCORE_THRESHOLD on its
// own — the numeric threshold and the family-count check independently
// enforce the same safety property (belt and suspenders).
// ---------------------------------------------------------------------------

export const MIN_INDEPENDENT_FAMILIES_FOR_EDGE = 2;
export const PAIR_ELIGIBILITY_SCORE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Cluster eligibility — Part 3.
// ---------------------------------------------------------------------------

export const MIN_CLUSTER_MEMBERS = 3;
export const MIN_CLUSTER_INDEPENDENT_FAMILIES = 3;
/** A member must have at least this many eligible edges into the (remaining) cluster to avoid being pruned as an unsupported peripheral member. */
export const MIN_MEMBER_SUPPORTING_EDGES = 1;

/**
 * HIGHER_CONCERN requires strictly more than the NEEDS_REVIEW minimum —
 * "four or more independent families" (Part 3).
 */
export const HIGHER_CONCERN_MIN_INDEPENDENT_FAMILIES = 4;
/** "Multiple strong eligible edges" — at least this many edges scoring at/above this share of the max possible combined score. */
export const HIGHER_CONCERN_MIN_STRONG_EDGES = 2;
export const STRONG_EDGE_SCORE_THRESHOLD = 0.75;
/** "Repeated recurrence across examinations" — at least this many prior exams with a recurring signal for the same group. */
export const HIGHER_CONCERN_MIN_CROSS_EXAM_RECURRENCE_COUNT = 2;
/** A family's capped contribution counts as "strong" for that family once it reaches this fraction of its own cap — used for the "strong rare-mistake and timing evidence together" HIGHER_CONCERN rule. */
export const STRONG_FAMILY_SCORE_FRACTION_OF_CAP = 0.8;

/**
 * A structurally-qualifying cluster (>= MIN_CLUSTER_MEMBERS, >=
 * MIN_CLUSTER_INDEPENDENT_FAMILIES) is only labelled NEEDS_REVIEW once its
 * average member edge score reaches this — otherwise it is labelled WATCH
 * (still visible to lecturers, but explicitly a lighter-touch status).
 * Never below PAIR_ELIGIBILITY_SCORE_THRESHOLD, since every included edge
 * already cleared that bar individually.
 */
export const CLUSTER_NEEDS_REVIEW_MIN_AVG_EDGE_SCORE = 0.6;

// ---------------------------------------------------------------------------
// Rarity weighting — Part 2 (RARE_MISTAKE, MCQ_PATTERN). A mistake/wrong
// answer shared by most of the cohort gets little or no weight; one
// shared by almost nobody gets full weight. Expressed as the fraction of
// the ANALYSED cohort who gave that same (incorrect) response.
// ---------------------------------------------------------------------------

export const RARE_MISTAKE_RARE_MAX_FRACTION = 0.1;
export const RARE_MISTAKE_UNCOMMON_MAX_FRACTION = 0.25;

export type RarityBand = "RARE" | "UNCOMMON" | "COMMON";

/** Classifies how rare a specific (incorrect) response is within its cohort — never inputs a correct answer. */
export function rarityBandForFraction(fractionOfCohort: number): RarityBand {
  if (fractionOfCohort <= RARE_MISTAKE_RARE_MAX_FRACTION) return "RARE";
  if (fractionOfCohort <= RARE_MISTAKE_UNCOMMON_MAX_FRACTION) return "UNCOMMON";
  return "COMMON";
}

/** Weight in [0, 1] applied to a matching-mistake signal before any family cap. COMMON mistakes get little/no weight; RARE mistakes get full weight. */
export function rarityWeightForFraction(fractionOfCohort: number): number {
  const band = rarityBandForFraction(fractionOfCohort);
  if (band === "RARE") return 1.0;
  if (band === "UNCOMMON") return 0.5;
  return 0.05;
}

// ---------------------------------------------------------------------------
// ANSWER_CONTENT — rare-phrase / code-structure thresholds (Part 5).
// ---------------------------------------------------------------------------

export const ANSWER_CONTENT_SHINGLE_SIZE = 3;
/** A shingle/phrase shared by at most this fraction of the analysed cohort counts as "distinctive"/rare — otherwise it's ordinary shared phrasing (question wording, required terminology). */
export const RARE_PHRASE_MAX_COHORT_FRACTION = 0.15;
export const ANSWER_CONTENT_MIN_CHARS = 60;
export const ANSWER_CONTENT_MIN_WORDS = 12;
export const ANSWER_CONTENT_HIGH_WEIGHTED_JACCARD = 0.55;
export const ANSWER_CONTENT_MEDIUM_WEIGHTED_JACCARD = 0.35;
/** Longest excerpt of matched text ever stored in evidenceJson — the relevant passage only, mirrors MATCHED_EXCERPT_MAX_CHARS in answerSimilarity.ts. */
export const ANSWER_CONTENT_EXCERPT_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// MCQ_PATTERN thresholds (Part 2.3).
// ---------------------------------------------------------------------------

export const MCQ_PATTERN_MIN_SHARED_QUESTIONS = 5;
/** Cohort-average rarity-weighted wrong-match ratio (correct matches contribute 0) at/above which HIGH_MCQ_SEQUENCE_SIMILARITY fires. */
export const MCQ_PATTERN_HIGH_WEIGHTED_RATIO = 0.35;
/** Minimum count of individually rare/uncommon wrong matches (mirrors MCQ_MIN_SAME_WRONG_COUNT in answerSimilarity.ts) before MATCHING_RARE_WRONG_SEQUENCE fires as a fallback to the ratio check. */
export const MCQ_PATTERN_MIN_RARE_WRONG_COUNT = 3;
/** Minimum distinct questions with a synchronised final-answer change (both students changed their answer, landing on the same rare wrong choice, within TIMING_SYNC_SAVE_WINDOW_MS) before SYNCHRONISED_MCQ_CHANGES fires. */
export const MCQ_PATTERN_MIN_SYNCHRONISED_CHANGES = 2;

// ---------------------------------------------------------------------------
// TIMING_SYNCHRONISATION thresholds (Part 2.4). Server timestamps are
// always authoritative — see docs. "One timing match must never be
// enough": every function in src/lib/cohortCollusion/timingSync.ts
// requires repeated synchronisation across multiple questions/events
// before producing a signal at all.
// ---------------------------------------------------------------------------

/** Two students' saves for the SAME question within this window count as "synchronised". */
export const TIMING_SYNC_SAVE_WINDOW_MS = 20_000;
/** Minimum number of distinct questions with synchronised saves before a signal is produced at all. */
export const TIMING_SYNC_MIN_SYNCHRONISED_QUESTIONS = 3;
/** A "substantial" edit, for SYNCHRONISED_SUBSTANTIAL_EDITS purposes. */
export const TIMING_SYNC_SUBSTANTIAL_EDIT_MIN_CHARS = 150;
/** Minimum synchronised substantial-edit pairs before a signal is produced. */
export const TIMING_SYNC_MIN_SUBSTANTIAL_EDIT_EVENTS = 2;
/** Spearman rank-correlation threshold for "highly similar question progression" (reuses the same statistic as timeAnomalyDetection.ts, scoped here to pairs already past the synchronised-saves gate). */
export const TIMING_SYNC_PROGRESSION_CORRELATION_THRESHOLD = 0.9;
export const TIMING_SYNC_MIN_SHARED_QUESTIONS_FOR_PROGRESSION = 5;
/** Two students both active in the same short burst window, repeated at least this many times, before REPEATED_SHARED_ACTIVITY_BURSTS fires. */
export const TIMING_SYNC_BURST_WINDOW_MS = 15_000;
export const TIMING_SYNC_MIN_REPEATED_BURSTS = 3;

// ---------------------------------------------------------------------------
// SESSION_NETWORK_DEVICE thresholds (Part 2.5). Weak by construction — see
// FAMILY_SCORE_CAPS.SESSION_NETWORK_DEVICE above. A shared IP/network
// alone must never create an eligible edge — enforced both by the low
// cap and by MIN_INDEPENDENT_FAMILIES_FOR_EDGE requiring a second family.
// ---------------------------------------------------------------------------

/** Two submissions sharing the same hashed IP/24 (or /48) prefix at least this many times counts as REPEATED_SHARED_NETWORK (a single shared prefix observation is not enough). */
export const NETWORK_MIN_SHARED_OBSERVATIONS = 2;
/** Concurrently active ExamAttemptSession windows overlapping by at least this long. */
export const SESSION_MIN_OVERLAP_MS = 5_000;

// ---------------------------------------------------------------------------
// CROSS_EXAM_RECURRENCE thresholds (Part 2.6). Supporting evidence only —
// never independently sufficient to create a cluster; see
// HIGHER_CONCERN_MIN_CROSS_EXAM_RECURRENCE_COUNT above for the one place
// recurrence count also strengthens a concern-level decision.
// ---------------------------------------------------------------------------

/** How many prior COMPLETE analyses (same institution) to look back across for a student pair. */
export const CROSS_EXAM_LOOKBACK_MAX_ANALYSES = 25;
/** Minimum number of PRIOR exams with an eligible (>= 2 family) edge for the same student pair before CROSS_EXAM_RECURRENCE fires at all. */
export const CROSS_EXAM_MIN_RECURRING_EXAMS = 2;

// ---------------------------------------------------------------------------
// Cohort-size / performance limits (Part 4). Documented v1 cohort cap for
// the synchronous, lecturer-triggered run — mirrors
// MAX_ANALYSIS_SUBMISSIONS in similarityAnalysisRunner.ts.
// ---------------------------------------------------------------------------

export const MAX_COLLUSION_ANALYSIS_SUBMISSIONS = 80;
