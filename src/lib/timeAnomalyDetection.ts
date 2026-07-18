/**
 * Time Anomaly Review v1 — pure timing-signal analysis. See
 * docs/time-anomaly-review-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no
 * browser APIs, no external services. Operates entirely on plain
 * timestamps (epoch milliseconds) and counts supplied by the caller
 * (src/lib/timingAnalysisRunner.ts). Server-received timestamps are
 * always authoritative; any client-supplied elapsed time is
 * supplementary only and is never accepted as an input to any threshold
 * comparison here.
 *
 * Every function produces a REVIEW SIGNAL for a human lecturer: "Timing
 * review recommended", never "pasted answer confirmed" — the lecturer/
 * institution makes the final decision. See the neutral-wording
 * convention in docs/time-anomaly-review-v1.md.
 */

export const TIME_ANOMALY_ALGORITHM_VERSION = "v1.0";

export const SIGNAL_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type SignalLevel = (typeof SIGNAL_LEVELS)[number];

export const TIMING_SIGNAL_TYPES = [
  "EXTREMELY_FAST_ATTEMPT",
  "RAPID_MULTI_QUESTION_COMPLETION",
  "RAPID_LARGE_RESPONSE_APPEARANCE",
  "LONG_INACTIVITY_THEN_LARGE_RESPONSE",
  "VERY_FAST_CORRECT_RESPONSE_PATTERN",
  "SIMILAR_RESPONSE_TIMING_PATTERN",
  "ABRUPT_ACTIVITY_BURST",
  "INSUFFICIENT_TIMING_DATA",
] as const;
export type TimingSignalType = (typeof TIMING_SIGNAL_TYPES)[number];

export const TIMING_REVIEW_STATUSES = [
  "NEEDS_REVIEW",
  "REVIEWED_NO_CONCERN",
  "REVIEWED_CONCERN_REMAINS",
  "ESCALATED",
  "RESOLVED",
] as const;
export type TimingReviewStatus = (typeof TIMING_REVIEW_STATUSES)[number];

export function isValidTimingReviewStatus(value: string): value is TimingReviewStatus {
  return (TIMING_REVIEW_STATUSES as readonly string[]).includes(value);
}

export const TIMING_REVIEW_STATUS_LABELS: Record<TimingReviewStatus, string> = {
  NEEDS_REVIEW: "Timing review recommended",
  REVIEWED_NO_CONCERN: "Reviewed — no concern",
  REVIEWED_CONCERN_REMAINS: "Concern remains",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
};

export type TimingSignalRecord = {
  signalType: TimingSignalType;
  signalLevel: SignalLevel;
  explanation: string;
  evidence: string[];
  limitation: string;
  reasonCode: string;
};

// ---------------------------------------------------------------------------
// Shared input types
// ---------------------------------------------------------------------------

export type ActivityEventType =
  | "ATTEMPT_STARTED"
  | "QUESTION_OPENED"
  | "ANSWER_SAVED"
  | "QUESTION_NAVIGATED"
  | "HEARTBEAT"
  | "PAGE_HIDDEN"
  | "PAGE_VISIBLE"
  | "ATTEMPT_SUBMITTED";

export type ActivityEventForAnalysis = {
  eventType: ActivityEventType;
  questionId: string | null;
  /** Authoritative server receipt time — never overridden by client-supplied elapsed time. */
  serverReceivedAtMs: number;
  responseLength: number | null;
  responseLengthDelta: number | null;
};

export type SubmissionLifecycle = {
  startedAtMs: number;
  submittedAtMs: number | null;
};

function insufficientTimingDataSignal(reason: string): TimingSignalRecord {
  return {
    signalType: "INSUFFICIENT_TIMING_DATA",
    signalLevel: "LOW",
    explanation: reason,
    evidence: [],
    limitation: "Absence of timing data is not evidence of anything — this is an informational result, not a review signal about the student.",
    reasonCode: "INSUFFICIENT_TIMING_DATA",
  };
}

// ---------------------------------------------------------------------------
// 10.1 — Extremely fast attempt
// ---------------------------------------------------------------------------

/** Below this many answered questions, "fast completion" is not meaningfully distinguishable from a short quiz. */
export const MIN_QUESTIONS_FOR_FAST_ATTEMPT_SIGNAL = 10;
/** Average seconds-per-question at or below this is MEDIUM. */
export const FAST_ATTEMPT_MEDIUM_SECONDS_PER_QUESTION = 3;
/** Average seconds-per-question at or below this is HIGH. */
export const FAST_ATTEMPT_HIGH_SECONDS_PER_QUESTION = 1;

export function analyzeExtremelyFastAttempt(
  lifecycle: SubmissionLifecycle,
  answeredQuestionCount: number,
): TimingSignalRecord | null {
  if (lifecycle.submittedAtMs == null) return null;
  if (answeredQuestionCount < MIN_QUESTIONS_FOR_FAST_ATTEMPT_SIGNAL) return null;
  const totalSeconds = (lifecycle.submittedAtMs - lifecycle.startedAtMs) / 1000;
  if (totalSeconds <= 0) return null;
  const secondsPerQuestion = totalSeconds / answeredQuestionCount;
  if (secondsPerQuestion > FAST_ATTEMPT_MEDIUM_SECONDS_PER_QUESTION) return null;

  return {
    signalType: "EXTREMELY_FAST_ATTEMPT",
    signalLevel: secondsPerQuestion <= FAST_ATTEMPT_HIGH_SECONDS_PER_QUESTION ? "HIGH" : "MEDIUM",
    explanation: `${answeredQuestionCount} questions were completed within ${Math.round(totalSeconds)} seconds.`,
    evidence: [`Average time per question: ${secondsPerQuestion.toFixed(1)}s`],
    limitation: "Fast completion may be legitimate for simple or previously reviewed questions.",
    reasonCode: "EXTREMELY_FAST_ATTEMPT",
  };
}

// ---------------------------------------------------------------------------
// 10.2 — Rapid multi-question completion
// ---------------------------------------------------------------------------

export const RAPID_MULTI_QUESTION_WINDOW_MS = 60_000;
export const RAPID_MULTI_QUESTION_MIN_DISTINCT_COUNT = 8;

/** Flags many distinct-question save/navigation events, with non-empty responses, in a very short server-timestamped window. */
export function analyzeRapidMultiQuestionCompletion(events: ActivityEventForAnalysis[]): TimingSignalRecord | null {
  const relevant = events
    .filter((e) => (e.eventType === "ANSWER_SAVED" || e.eventType === "QUESTION_NAVIGATED") && e.questionId != null)
    .filter((e) => e.eventType !== "ANSWER_SAVED" || (e.responseLength ?? 0) > 0)
    .sort((a, b) => a.serverReceivedAtMs - b.serverReceivedAtMs);

  let left = 0;
  let bestDistinctCount = 0;
  let bestWindowStart = 0;
  let bestWindowEnd = 0;
  for (let right = 0; right < relevant.length; right++) {
    while (relevant[right].serverReceivedAtMs - relevant[left].serverReceivedAtMs > RAPID_MULTI_QUESTION_WINDOW_MS) left++;
    const windowIds = new Set(relevant.slice(left, right + 1).map((e) => e.questionId));
    if (windowIds.size > bestDistinctCount) {
      bestDistinctCount = windowIds.size;
      bestWindowStart = relevant[left].serverReceivedAtMs;
      bestWindowEnd = relevant[right].serverReceivedAtMs;
    }
  }

  if (bestDistinctCount < RAPID_MULTI_QUESTION_MIN_DISTINCT_COUNT) return null;
  const windowSeconds = Math.round((bestWindowEnd - bestWindowStart) / 1000);
  return {
    signalType: "RAPID_MULTI_QUESTION_COMPLETION",
    signalLevel: "MEDIUM",
    explanation: `${bestDistinctCount} different questions were saved or navigated within a ${windowSeconds}-second window.`,
    evidence: [`Distinct questions: ${bestDistinctCount}`, `Window: ${windowSeconds}s`],
    limitation: "This relies on server-received timestamps only. Rapid completion may be legitimate for simple or previously reviewed questions.",
    reasonCode: "RAPID_MULTI_QUESTION_COMPLETION",
  };
}

// ---------------------------------------------------------------------------
// 10.3 — Rapid large response appearance
// ---------------------------------------------------------------------------

/** A "large amount" of response growth between two consecutive saves, in characters. */
export const RAPID_RESPONSE_MIN_CHAR_DELTA = 500;
/** "Very short" elapsed server time between the two saves. */
export const RAPID_RESPONSE_MAX_ELAPSED_MS = 5_000;

/**
 * Flags a large character-count jump between two CONSECUTIVE saved
 * versions of the same question's answer within a very short server
 * interval, with no intermediate saved growth (i.e. the jump appears in
 * one step, not gradually across several saves). Never calls this
 * "pasted" — paste is already blocked elsewhere, so this uses neutral,
 * observable wording only.
 */
export function analyzeRapidLargeResponseAppearance(events: ActivityEventForAnalysis[]): TimingSignalRecord[] {
  const saves = events
    .filter((e) => e.eventType === "ANSWER_SAVED" && e.questionId != null)
    .sort((a, b) => a.serverReceivedAtMs - b.serverReceivedAtMs);

  const byQuestion = new Map<string, ActivityEventForAnalysis[]>();
  for (const e of saves) {
    const list = byQuestion.get(e.questionId!) ?? [];
    list.push(e);
    byQuestion.set(e.questionId!, list);
  }

  const signals: TimingSignalRecord[] = [];
  for (const [questionId, questionSaves] of byQuestion) {
    for (let i = 1; i < questionSaves.length; i++) {
      const prev = questionSaves[i - 1];
      const curr = questionSaves[i];
      const delta = curr.responseLengthDelta ?? (curr.responseLength ?? 0) - (prev.responseLength ?? 0);
      const elapsedMs = curr.serverReceivedAtMs - prev.serverReceivedAtMs;
      if (delta >= RAPID_RESPONSE_MIN_CHAR_DELTA && elapsedMs > 0 && elapsedMs <= RAPID_RESPONSE_MAX_ELAPSED_MS) {
        signals.push({
          signalType: "RAPID_LARGE_RESPONSE_APPEARANCE",
          signalLevel: "MEDIUM",
          explanation: `A response of roughly ${delta} characters appeared between two saved versions within ${(elapsedMs / 1000).toFixed(1)} seconds.`,
          evidence: [`Growth: ~${delta} characters`, `Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`, `Question: ${questionId}`],
          limitation: "This may result from browser recovery, delayed autosave, accessibility software, or offline buffering.",
          reasonCode: "RAPID_LARGE_RESPONSE_APPEARANCE",
        });
      }
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// 10.4 — Long inactivity followed by large response
// ---------------------------------------------------------------------------

export const LONG_INACTIVITY_THRESHOLD_MS = 10 * 60 * 1000;
export const LARGE_RESPONSE_DELTA_AFTER_INACTIVITY = 300;

/**
 * Flags a substantial saved-response growth immediately following a long
 * gap in ANY activity (not just answer saves — a heartbeat gap counts as
 * inactivity too). Never treats a heartbeat gap alone as proof — a closed
 * laptop or a network outage produces an identical gap.
 */
export function analyzeLongInactivityThenLargeResponse(events: ActivityEventForAnalysis[]): TimingSignalRecord[] {
  const sorted = [...events].sort((a, b) => a.serverReceivedAtMs - b.serverReceivedAtMs);
  const signals: TimingSignalRecord[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const gapMs = sorted[i].serverReceivedAtMs - sorted[i - 1].serverReceivedAtMs;
    if (gapMs < LONG_INACTIVITY_THRESHOLD_MS) continue;
    const after = sorted[i];
    if (after.eventType !== "ANSWER_SAVED") continue;
    const delta = after.responseLengthDelta ?? after.responseLength ?? 0;
    if (delta < LARGE_RESPONSE_DELTA_AFTER_INACTIVITY) continue;

    signals.push({
      signalType: "LONG_INACTIVITY_THEN_LARGE_RESPONSE",
      signalLevel: "LOW",
      explanation: `A period of ${Math.round(gapMs / 60_000)} minutes with no recorded activity was followed by a substantial saved-response increase.`,
      evidence: [`Inactivity: ${Math.round(gapMs / 60_000)} minute(s)`, `Response growth: ~${delta} characters`],
      limitation: "A closed laptop, a network outage, or time spent thinking before writing can all produce an identical pattern. Absence of a heartbeat is not proof of anything.",
      reasonCode: "LONG_INACTIVITY_THEN_LARGE_RESPONSE",
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// 10.5 — Very fast correct response pattern (requires explicit difficulty)
// ---------------------------------------------------------------------------

export type QuestionDifficulty = "easy" | "medium" | "hard";
export const FAST_CORRECT_RESPONSE_MAX_SECONDS = 8;
export const MIN_FAST_CORRECT_HARD_ANSWERS = 2;

export type AnswerTimingForDifficultyCheck = {
  questionId: string;
  elapsedMs: number;
  isCorrect: boolean;
};

/**
 * DELIBERATELY DISABLED unless the caller supplies explicit,
 * lecturer-set (or reliably estimated) per-question difficulty — this
 * repo's Question model has no difficulty field and no cohort-difficulty
 * estimation is implemented in v1, so the runner never calls this with
 * real data today. Never infers difficulty from question text via AI.
 * See docs/time-anomaly-review-v1.md ("Signals deliberately omitted").
 */
export function analyzeVeryFastCorrectResponsePattern(
  answers: AnswerTimingForDifficultyCheck[],
  difficultyByQuestionId: Map<string, QuestionDifficulty> | null,
): TimingSignalRecord | null {
  if (!difficultyByQuestionId || difficultyByQuestionId.size === 0) return null;
  const fastCorrectHard = answers.filter(
    (a) =>
      a.isCorrect &&
      difficultyByQuestionId.get(a.questionId) === "hard" &&
      a.elapsedMs <= FAST_CORRECT_RESPONSE_MAX_SECONDS * 1000,
  );
  if (fastCorrectHard.length < MIN_FAST_CORRECT_HARD_ANSWERS) return null;

  return {
    signalType: "VERY_FAST_CORRECT_RESPONSE_PATTERN",
    signalLevel: "MEDIUM",
    explanation: `${fastCorrectHard.length} questions marked as high-difficulty were answered correctly in under ${FAST_CORRECT_RESPONSE_MAX_SECONDS} seconds each.`,
    evidence: [`Fast correct answers on difficult questions: ${fastCorrectHard.length}`],
    limitation: "Correctness is never shown to the student. A well-prepared student may legitimately answer familiar difficult questions quickly.",
    reasonCode: "VERY_FAST_CORRECT_RESPONSE_PATTERN",
  };
}

// ---------------------------------------------------------------------------
// 10.6 — Similar response timing pattern (cross-submission, cohort)
// ---------------------------------------------------------------------------

export const MIN_SHARED_QUESTIONS_FOR_TIMING_COMPARISON = 5;
export const TIMING_CORRELATION_MEDIUM_THRESHOLD = 0.95;
export const TIMING_CORRELATION_LOW_THRESHOLD = 0.85;

export type RelativeTimingPoint = { questionId: string; relativeElapsedMs: number };

function rank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  indexed.forEach((entry, rankIndex) => {
    ranks[entry.i] = rankIndex + 1;
  });
  return ranks;
}

/** Spearman rank correlation over two equal-length numeric vectors. Returns 0 for degenerate (zero-variance) input. */
export function spearmanCorrelation(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const rankA = rank(a);
  const rankB = rank(b);
  const n = a.length;
  const meanA = rankA.reduce((s, v) => s + v, 0) / n;
  const meanB = rankB.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (rankA[i] - meanA) * (rankB[i] - meanB);
    varA += (rankA[i] - meanA) ** 2;
    varB += (rankB[i] - meanB) ** 2;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Compares two students' RELATIVE (from-attempt-start) completion timing
 * on the actual shared Question.ids only — never by display position,
 * since question pools/randomisation mean position is meaningless across
 * students. Timing similarity alone is capped at MEDIUM — it becomes
 * more meaningful only when combined with other independent signals
 * (same-wrong-MCQ pattern, high answer similarity, concurrent sessions),
 * which is the combined recommendation function's job, not this one's.
 */
export function analyzeSimilarResponseTimingPattern(
  submissionA: RelativeTimingPoint[],
  submissionB: RelativeTimingPoint[],
): TimingSignalRecord | null {
  const mapA = new Map(submissionA.map((p) => [p.questionId, p.relativeElapsedMs]));
  const mapB = new Map(submissionB.map((p) => [p.questionId, p.relativeElapsedMs]));
  const sharedIds = [...mapA.keys()].filter((id) => mapB.has(id));
  if (sharedIds.length < MIN_SHARED_QUESTIONS_FOR_TIMING_COMPARISON) return null;

  const vecA = sharedIds.map((id) => mapA.get(id)!);
  const vecB = sharedIds.map((id) => mapB.get(id)!);
  const correlation = spearmanCorrelation(vecA, vecB);
  if (correlation < TIMING_CORRELATION_LOW_THRESHOLD) return null;

  return {
    signalType: "SIMILAR_RESPONSE_TIMING_PATTERN",
    // Never HIGH on its own — timing similarity alone is not sufficient.
    signalLevel: correlation >= TIMING_CORRELATION_MEDIUM_THRESHOLD ? "MEDIUM" : "LOW",
    explanation: `Two students' relative completion timing across ${sharedIds.length} shared questions is highly correlated (rank correlation ${correlation.toFixed(2)}).`,
    evidence: [`Shared questions compared: ${sharedIds.length}`, `Rank correlation: ${correlation.toFixed(2)}`],
    limitation: "Timing similarity alone is not evidence of collaboration or misconduct — it becomes more meaningful only alongside other independent signals such as answer similarity or same-wrong-MCQ patterns.",
    reasonCode: "SIMILAR_RESPONSE_TIMING_PATTERN",
  };
}

// ---------------------------------------------------------------------------
// Abrupt activity burst
// ---------------------------------------------------------------------------

export const ABRUPT_BURST_WINDOW_MS = 10_000;
export const ABRUPT_BURST_MIN_EVENT_COUNT = 12;

/** General event-density burst detector, independent of question distinctness or correctness. */
export function analyzeAbruptActivityBurst(events: ActivityEventForAnalysis[]): TimingSignalRecord | null {
  const sorted = [...events].sort((a, b) => a.serverReceivedAtMs - b.serverReceivedAtMs);
  let left = 0;
  let bestCount = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right].serverReceivedAtMs - sorted[left].serverReceivedAtMs > ABRUPT_BURST_WINDOW_MS) left++;
    bestCount = Math.max(bestCount, right - left + 1);
  }
  if (bestCount < ABRUPT_BURST_MIN_EVENT_COUNT) return null;

  return {
    signalType: "ABRUPT_ACTIVITY_BURST",
    signalLevel: "LOW",
    explanation: `${bestCount} activity events were recorded within a ${Math.round(ABRUPT_BURST_WINDOW_MS / 1000)}-second window.`,
    evidence: [`Events in window: ${bestCount}`],
    limitation: "A burst of activity can result from catching up after a distraction, or from normal rapid review of already-answered questions.",
    reasonCode: "ABRUPT_ACTIVITY_BURST",
  };
}

// ---------------------------------------------------------------------------
// Orchestration — single-submission signals only. Cross-submission
// SIMILAR_RESPONSE_TIMING_PATTERN is run per cohort pair by the caller
// (src/lib/timingAnalysisRunner.ts), the same way answer similarity pairs
// submissions in similarityAnalysisRunner.ts.
// ---------------------------------------------------------------------------

export type TimeAnomalyAnalysisInput = {
  lifecycle: SubmissionLifecycle;
  answeredQuestionCount: number;
  activityEvents: ActivityEventForAnalysis[];
  /** Never populated by the v1 runner — see analyzeVeryFastCorrectResponsePattern. */
  difficultyByQuestionId?: Map<string, QuestionDifficulty> | null;
  answerTimingsForDifficultyCheck?: AnswerTimingForDifficultyCheck[];
};

/** Runs every single-submission (non-cohort) timing check and returns explainable signal records. */
export function runTimeAnomalyAnalysis(input: TimeAnomalyAnalysisInput): TimingSignalRecord[] {
  const hasUsableData = input.lifecycle.submittedAtMs != null && input.activityEvents.length > 0;
  if (!hasUsableData) {
    return [insufficientTimingDataSignal("Not enough timing data was recorded for this attempt to run timing analysis.")];
  }

  const signals: TimingSignalRecord[] = [];
  const fast = analyzeExtremelyFastAttempt(input.lifecycle, input.answeredQuestionCount);
  if (fast) signals.push(fast);

  const rapidMulti = analyzeRapidMultiQuestionCompletion(input.activityEvents);
  if (rapidMulti) signals.push(rapidMulti);

  signals.push(...analyzeRapidLargeResponseAppearance(input.activityEvents));
  signals.push(...analyzeLongInactivityThenLargeResponse(input.activityEvents));

  const burst = analyzeAbruptActivityBurst(input.activityEvents);
  if (burst) signals.push(burst);

  if (input.difficultyByQuestionId && input.answerTimingsForDifficultyCheck) {
    const fastCorrect = analyzeVeryFastCorrectResponsePattern(input.answerTimingsForDifficultyCheck, input.difficultyByQuestionId);
    if (fastCorrect) signals.push(fastCorrect);
  }

  return signals;
}
