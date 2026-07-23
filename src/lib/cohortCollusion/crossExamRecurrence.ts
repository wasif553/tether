/**
 * Cohort-Level Collusion Detection v1 — CROSS_EXAM_RECURRENCE signal
 * family. See docs/cohort-collusion-graph-v1.md and Part 2.6 of the
 * spec.
 *
 * Supporting evidence only — never independently sufficient to create a
 * cluster (enforced by the low FAMILY_SCORE_CAPS.CROSS_EXAM_RECURRENCE
 * cap). Institution-scoped: the runner only ever passes in prior
 * analyses from the SAME institution (see
 * src/lib/cohortCollusionAnalysisRunner.ts).
 */
import { CROSS_EXAM_MIN_RECURRING_EXAMS } from "@/lib/cohortCollusionThresholds";
import type { PairSignal } from "./types";

export const CROSS_EXAM_RECURRENCE_SIGNAL_TYPES = [
  "REPEATED_PAIR_SIMILARITY",
  "REPEATED_GROUP_RECURRENCE",
  "REPEATED_MULTI_EXAM_SIGNAL_PATTERN",
] as const;
export type CrossExamRecurrenceSignalType = (typeof CROSS_EXAM_RECURRENCE_SIGNAL_TYPES)[number];

/** One prior exam's outcome for this exact student pair, within the same institution. */
export type PriorExamPairRecord = {
  examId: string;
  eligibleForClustering: boolean;
  independentFamilyCount: number;
  wasInSameCluster: boolean;
};

/**
 * Flags recurrence only when this exact student pair had an eligible
 * (>= 2 family) relationship in at least CROSS_EXAM_MIN_RECURRING_EXAMS
 * DIFFERENT prior exams. A single prior exam is never enough — see
 * "Cross-exam recurrence is supporting evidence only" in the spec.
 */
export function computeCrossExamRecurrenceSignals(priorRecords: PriorExamPairRecord[]): PairSignal[] {
  const recurringExams = priorRecords.filter((r) => r.eligibleForClustering);
  if (recurringExams.length < CROSS_EXAM_MIN_RECURRING_EXAMS) return [];

  const signals: PairSignal[] = [];
  const groupRecurrences = recurringExams.filter((r) => r.wasInSameCluster);
  const multiFamilyRecurrences = recurringExams.filter((r) => r.independentFamilyCount >= 3);

  if (groupRecurrences.length >= CROSS_EXAM_MIN_RECURRING_EXAMS) {
    signals.push({
      signalFamily: "CROSS_EXAM_RECURRENCE",
      signalType: "REPEATED_GROUP_RECURRENCE",
      score: Math.min(1, groupRecurrences.length / (CROSS_EXAM_MIN_RECURRING_EXAMS * 2)),
      confidence: 0.5,
      explanation: `This group of students has repeatedly appeared together in a possible coordinated-answer cluster across ${groupRecurrences.length} prior examinations at this institution.`,
      evidence: { recurringExamCount: groupRecurrences.length, examIds: groupRecurrences.map((r) => r.examId) },
    });
  } else if (multiFamilyRecurrences.length >= CROSS_EXAM_MIN_RECURRING_EXAMS) {
    signals.push({
      signalFamily: "CROSS_EXAM_RECURRENCE",
      signalType: "REPEATED_MULTI_EXAM_SIGNAL_PATTERN",
      score: Math.min(1, multiFamilyRecurrences.length / (CROSS_EXAM_MIN_RECURRING_EXAMS * 2)),
      confidence: 0.45,
      explanation: `This pair of students has repeatedly shown multiple independent supporting signals together across ${multiFamilyRecurrences.length} prior examinations at this institution.`,
      evidence: { recurringExamCount: multiFamilyRecurrences.length, examIds: multiFamilyRecurrences.map((r) => r.examId) },
    });
  } else {
    signals.push({
      signalFamily: "CROSS_EXAM_RECURRENCE",
      signalType: "REPEATED_PAIR_SIMILARITY",
      score: Math.min(1, recurringExams.length / (CROSS_EXAM_MIN_RECURRING_EXAMS * 2)),
      confidence: 0.4,
      explanation: `This pair of students has repeatedly shown a possible relationship across ${recurringExams.length} prior examinations at this institution.`,
      evidence: { recurringExamCount: recurringExams.length, examIds: recurringExams.map((r) => r.examId) },
    });
  }
  return signals;
}
