/**
 * Cohort-Level Collusion Detection v1 — MCQ_PATTERN signal family. See
 * docs/cohort-collusion-graph-v1.md and Part 2.3 of the spec.
 *
 * Sequence-level analysis across MANY shared multiple-choice questions —
 * distinct from RARE_MISTAKE, which looks at one question at a time.
 * Correct answers shared by most of the cohort never create meaningful
 * concern; matching UNCOMMON wrong answers carries more weight than
 * matching correct answers (which carries none).
 */
import { normalizeAnswerText } from "@/lib/answerSimilarity";
import {
  MCQ_PATTERN_MIN_SHARED_QUESTIONS,
  MCQ_PATTERN_HIGH_WEIGHTED_RATIO,
  MCQ_PATTERN_MIN_RARE_WRONG_COUNT,
  MCQ_PATTERN_MIN_SYNCHRONISED_CHANGES,
  TIMING_SYNC_SAVE_WINDOW_MS,
  rarityWeightForFraction,
  rarityBandForFraction,
} from "@/lib/cohortCollusionThresholds";
import type { QuestionWrongAnswerFrequency } from "./rareMistake";
import type { PairSignal } from "./types";

export const MCQ_PATTERN_SIGNAL_TYPES = [
  "HIGH_MCQ_SEQUENCE_SIMILARITY",
  "MATCHING_RARE_WRONG_SEQUENCE",
  "SYNCHRONISED_MCQ_CHANGES",
] as const;
export type McqPatternSignalType = (typeof MCQ_PATTERN_SIGNAL_TYPES)[number];

export type McqSharedQuestion = {
  questionId: string;
  responseA: string | null;
  responseB: string | null;
  correctAnswer: string | null;
  wrongAnswerStats: QuestionWrongAnswerFrequency;
};

/** Computes HIGH_MCQ_SEQUENCE_SIMILARITY / MATCHING_RARE_WRONG_SEQUENCE across every MCQ question the pair actually shares (by Question.id). */
export function computeMcqSequenceSignals(shared: McqSharedQuestion[]): PairSignal[] {
  if (shared.length < MCQ_PATTERN_MIN_SHARED_QUESTIONS) return [];

  let weightedWrongSum = 0;
  let rareWrongMatchCount = 0;
  const rareWrongQuestionIds: string[] = [];

  for (const q of shared) {
    const a = normalizeAnswerText(q.responseA);
    const b = normalizeAnswerText(q.responseB);
    const correct = normalizeAnswerText(q.correctAnswer);
    if (a.length === 0 || b.length === 0 || a !== b) continue;
    if (correct.length > 0 && a === correct) continue; // Shared correct answer — expected, no weight at all.

    const fraction =
      q.wrongAnswerStats.answeredCount > 0 ? (q.wrongAnswerStats.wrongResponseCounts.get(a) ?? 0) / q.wrongAnswerStats.answeredCount : 1;
    const weight = rarityWeightForFraction(fraction);
    weightedWrongSum += weight;
    if (rarityBandForFraction(fraction) !== "COMMON") {
      rareWrongMatchCount++;
      rareWrongQuestionIds.push(q.questionId);
    }
  }

  const ratio = weightedWrongSum / shared.length;
  const signals: PairSignal[] = [];

  if (ratio >= MCQ_PATTERN_HIGH_WEIGHTED_RATIO) {
    signals.push({
      signalFamily: "MCQ_PATTERN",
      signalType: "HIGH_MCQ_SEQUENCE_SIMILARITY",
      score: Math.min(1, ratio),
      confidence: 0.7,
      explanation: `Across ${shared.length} shared multiple-choice questions, the two responses match on an unusually large rarity-weighted share of uncommon incorrect choices.`,
      evidence: { sharedQuestionCount: shared.length, rarityWeightedRatio: Number(ratio.toFixed(3)) },
    });
  } else if (rareWrongMatchCount >= MCQ_PATTERN_MIN_RARE_WRONG_COUNT) {
    signals.push({
      signalFamily: "MCQ_PATTERN",
      signalType: "MATCHING_RARE_WRONG_SEQUENCE",
      score: Math.min(1, weightedWrongSum / Math.max(rareWrongMatchCount, 1)),
      confidence: 0.6,
      explanation: `${rareWrongMatchCount} of ${shared.length} shared multiple-choice questions have the same uncommon incorrect choice.`,
      evidence: { sharedQuestionCount: shared.length, rareWrongMatchCount, questionIdsInvolved: rareWrongQuestionIds },
    });
  }

  return signals;
}

export type McqActivityEvent = { serverReceivedAtMs: number; responseHash: string | null };

export type McqChangeInput = {
  questionId: string;
  eventsA: McqActivityEvent[];
  eventsB: McqActivityEvent[];
  finalResponseA: string | null;
  finalResponseB: string | null;
  correctAnswer: string | null;
  wrongAnswerStats: QuestionWrongAnswerFrequency;
};

/** True when a student's answer for this question actually changed at least once (two consecutive saves with different response hashes). */
function changedAnswer(events: McqActivityEvent[]): { changed: boolean; lastAtMs: number | null } {
  const sorted = [...events].sort((a, b) => a.serverReceivedAtMs - b.serverReceivedAtMs);
  let changed = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].responseHash !== sorted[i - 1].responseHash) changed = true;
  }
  return { changed, lastAtMs: sorted.length > 0 ? sorted[sorted.length - 1].serverReceivedAtMs : null };
}

/**
 * Flags SYNCHRONISED_MCQ_CHANGES only when the pair changed their answer
 * on the SAME question, landed on the same rare wrong final choice, and
 * their last saves were within TIMING_SYNC_SAVE_WINDOW_MS of each other —
 * repeated across at least MCQ_PATTERN_MIN_SYNCHRONISED_CHANGES distinct
 * questions. A single synchronised change is never enough.
 */
export function computeSynchronisedMcqChangeSignal(inputs: McqChangeInput[]): PairSignal[] {
  const matchingQuestionIds: string[] = [];
  let weightedSum = 0;

  for (const input of inputs) {
    const a = changedAnswer(input.eventsA);
    const b = changedAnswer(input.eventsB);
    if (!a.changed || !b.changed || a.lastAtMs == null || b.lastAtMs == null) continue;
    if (Math.abs(a.lastAtMs - b.lastAtMs) > TIMING_SYNC_SAVE_WINDOW_MS) continue;

    const finalA = normalizeAnswerText(input.finalResponseA);
    const finalB = normalizeAnswerText(input.finalResponseB);
    const correct = normalizeAnswerText(input.correctAnswer);
    if (finalA.length === 0 || finalA !== finalB) continue;
    if (correct.length > 0 && finalA === correct) continue; // Synchronised change to the CORRECT answer is not a signal.

    const fraction =
      input.wrongAnswerStats.answeredCount > 0
        ? (input.wrongAnswerStats.wrongResponseCounts.get(finalA) ?? 0) / input.wrongAnswerStats.answeredCount
        : 1;
    if (rarityBandForFraction(fraction) === "COMMON") continue;

    matchingQuestionIds.push(input.questionId);
    weightedSum += rarityWeightForFraction(fraction);
  }

  if (matchingQuestionIds.length < MCQ_PATTERN_MIN_SYNCHRONISED_CHANGES) return [];

  return [
    {
      signalFamily: "MCQ_PATTERN",
      signalType: "SYNCHRONISED_MCQ_CHANGES",
      score: Math.min(1, weightedSum / matchingQuestionIds.length),
      confidence: 0.65,
      explanation: `Both students changed their answer and landed on the same uncommon incorrect choice, within a narrow time window, across ${matchingQuestionIds.length} separate questions.`,
      evidence: { matchingQuestionCount: matchingQuestionIds.length, questionIdsInvolved: matchingQuestionIds },
    },
  ];
}
