/**
 * Cohort-Level Collusion Detection v1 — TIMING_SYNCHRONISATION signal
 * family. See docs/cohort-collusion-graph-v1.md and Part 2.4 of the spec.
 *
 * Uses existing AnswerActivityEvent server-received timestamps only —
 * never client-supplied elapsed time (server timestamps are always
 * authoritative, exactly like src/lib/timeAnomalyDetection.ts). One
 * timing match is never enough: every function here requires repeated
 * synchronisation across multiple questions/events before producing a
 * signal at all.
 */
import { spearmanCorrelation } from "@/lib/timeAnomalyDetection";
import {
  TIMING_SYNC_SAVE_WINDOW_MS,
  TIMING_SYNC_MIN_SYNCHRONISED_QUESTIONS,
  TIMING_SYNC_SUBSTANTIAL_EDIT_MIN_CHARS,
  TIMING_SYNC_MIN_SUBSTANTIAL_EDIT_EVENTS,
  TIMING_SYNC_PROGRESSION_CORRELATION_THRESHOLD,
  TIMING_SYNC_MIN_SHARED_QUESTIONS_FOR_PROGRESSION,
  TIMING_SYNC_BURST_WINDOW_MS,
  TIMING_SYNC_MIN_REPEATED_BURSTS,
} from "@/lib/cohortCollusionThresholds";
import type { PairSignal } from "./types";

export const TIMING_SYNC_SIGNAL_TYPES = [
  "SYNCHRONISED_ANSWER_TIMES",
  "SYNCHRONISED_SUBSTANTIAL_EDITS",
  "SYNCHRONISED_QUESTION_PROGRESSION",
  "REPEATED_SHARED_ACTIVITY_BURSTS",
] as const;
export type TimingSyncSignalType = (typeof TIMING_SYNC_SIGNAL_TYPES)[number];

export type TimedEvent = {
  questionId: string | null;
  serverReceivedAtMs: number;
  responseLengthDelta: number | null;
};

/** For each question answered by BOTH students, the (last) ANSWER_SAVED server timestamp. */
function lastSaveTimeByQuestion(events: TimedEvent[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of events) {
    if (!e.questionId) continue;
    const existing = map.get(e.questionId);
    if (existing == null || e.serverReceivedAtMs > existing) map.set(e.questionId, e.serverReceivedAtMs);
  }
  return map;
}

/** Flags SYNCHRONISED_ANSWER_TIMES only when at least TIMING_SYNC_MIN_SYNCHRONISED_QUESTIONS distinct shared questions were saved within TIMING_SYNC_SAVE_WINDOW_MS of each other. */
export function computeSynchronisedAnswerTimesSignal(eventsA: TimedEvent[], eventsB: TimedEvent[]): PairSignal[] {
  const timesA = lastSaveTimeByQuestion(eventsA);
  const timesB = lastSaveTimeByQuestion(eventsB);
  const synchronisedQuestionIds: string[] = [];
  for (const [questionId, atA] of timesA) {
    const atB = timesB.get(questionId);
    if (atB != null && Math.abs(atA - atB) <= TIMING_SYNC_SAVE_WINDOW_MS) synchronisedQuestionIds.push(questionId);
  }
  if (synchronisedQuestionIds.length < TIMING_SYNC_MIN_SYNCHRONISED_QUESTIONS) return [];
  return [
    {
      signalFamily: "TIMING_SYNCHRONISATION",
      signalType: "SYNCHRONISED_ANSWER_TIMES",
      score: Math.min(1, synchronisedQuestionIds.length / (TIMING_SYNC_MIN_SYNCHRONISED_QUESTIONS * 2)),
      confidence: 0.6,
      explanation: `Both submissions saved answers to ${synchronisedQuestionIds.length} of the same questions within a narrow time window of each other.`,
      evidence: { synchronisedQuestionCount: synchronisedQuestionIds.length, questionIdsInvolved: synchronisedQuestionIds },
    },
  ];
}

/** Flags SYNCHRONISED_SUBSTANTIAL_EDITS only when repeated (>= TIMING_SYNC_MIN_SUBSTANTIAL_EDIT_EVENTS) large edits from both students land within the save window of each other. */
export function computeSynchronisedSubstantialEditsSignal(eventsA: TimedEvent[], eventsB: TimedEvent[]): PairSignal[] {
  const bigEditsA = eventsA.filter((e) => e.questionId && (e.responseLengthDelta ?? 0) >= TIMING_SYNC_SUBSTANTIAL_EDIT_MIN_CHARS);
  const bigEditsB = eventsB.filter((e) => e.questionId && (e.responseLengthDelta ?? 0) >= TIMING_SYNC_SUBSTANTIAL_EDIT_MIN_CHARS);
  const matches: string[] = [];
  for (const a of bigEditsA) {
    const match = bigEditsB.find(
      (b) => b.questionId === a.questionId && Math.abs(b.serverReceivedAtMs - a.serverReceivedAtMs) <= TIMING_SYNC_SAVE_WINDOW_MS,
    );
    if (match && a.questionId) matches.push(a.questionId);
  }
  const distinctQuestions = [...new Set(matches)];
  if (distinctQuestions.length < TIMING_SYNC_MIN_SUBSTANTIAL_EDIT_EVENTS) return [];
  return [
    {
      signalFamily: "TIMING_SYNCHRONISATION",
      signalType: "SYNCHRONISED_SUBSTANTIAL_EDITS",
      score: Math.min(1, distinctQuestions.length / (TIMING_SYNC_MIN_SUBSTANTIAL_EDIT_EVENTS * 2)),
      confidence: 0.55,
      explanation: `Both submissions made a substantial answer change to the same question within a narrow time window, on ${distinctQuestions.length} separate occasions.`,
      evidence: { synchronisedEditCount: distinctQuestions.length, questionIdsInvolved: distinctQuestions },
    },
  ];
}

export type RelativeTimingPoint = { questionId: string; relativeElapsedMs: number };

/** Flags SYNCHRONISED_QUESTION_PROGRESSION using the same rank-correlation approach as timeAnomalyDetection.ts's cross-submission timing check, scoped to pairs that already passed candidate blocking. */
export function computeSynchronisedQuestionProgressionSignal(
  pointsA: RelativeTimingPoint[],
  pointsB: RelativeTimingPoint[],
): PairSignal[] {
  const mapA = new Map(pointsA.map((p) => [p.questionId, p.relativeElapsedMs]));
  const mapB = new Map(pointsB.map((p) => [p.questionId, p.relativeElapsedMs]));
  const sharedIds = [...mapA.keys()].filter((id) => mapB.has(id));
  if (sharedIds.length < TIMING_SYNC_MIN_SHARED_QUESTIONS_FOR_PROGRESSION) return [];

  const correlation = spearmanCorrelation(
    sharedIds.map((id) => mapA.get(id)!),
    sharedIds.map((id) => mapB.get(id)!),
  );
  if (correlation < TIMING_SYNC_PROGRESSION_CORRELATION_THRESHOLD) return [];

  return [
    {
      signalFamily: "TIMING_SYNCHRONISATION",
      signalType: "SYNCHRONISED_QUESTION_PROGRESSION",
      score: correlation,
      confidence: 0.5,
      explanation: `Both submissions progressed through ${sharedIds.length} shared questions in a highly similar relative order and pace (rank correlation ${correlation.toFixed(2)}).`,
      evidence: { sharedQuestionCount: sharedIds.length, correlation: Number(correlation.toFixed(3)) },
    },
  ];
}

/** Flags REPEATED_SHARED_ACTIVITY_BURSTS only when both students had ANY activity within TIMING_SYNC_BURST_WINDOW_MS of each other, repeated across at least TIMING_SYNC_MIN_REPEATED_BURSTS distinct, non-overlapping episodes. */
export function computeRepeatedSharedActivityBurstsSignal(eventsA: TimedEvent[], eventsB: TimedEvent[]): PairSignal[] {
  const sortedA = [...eventsA].sort((a, b) => a.serverReceivedAtMs - b.serverReceivedAtMs);
  const sortedB = [...eventsB].sort((a, b) => a.serverReceivedAtMs - b.serverReceivedAtMs);

  const burstTimes: number[] = [];
  let lastBurstAtMs = -Infinity;
  let i = 0;
  let j = 0;
  while (i < sortedA.length && j < sortedB.length) {
    const diff = sortedA[i].serverReceivedAtMs - sortedB[j].serverReceivedAtMs;
    if (Math.abs(diff) <= TIMING_SYNC_BURST_WINDOW_MS) {
      const atMs = Math.min(sortedA[i].serverReceivedAtMs, sortedB[j].serverReceivedAtMs);
      // Collapse a run of matches into one "episode" so a single burst of
      // rapid saves isn't counted as many separate bursts.
      if (atMs - lastBurstAtMs > TIMING_SYNC_BURST_WINDOW_MS) {
        burstTimes.push(atMs);
        lastBurstAtMs = atMs;
      }
      i++;
      j++;
    } else if (diff < 0) {
      i++;
    } else {
      j++;
    }
  }

  if (burstTimes.length < TIMING_SYNC_MIN_REPEATED_BURSTS) return [];
  return [
    {
      signalFamily: "TIMING_SYNCHRONISATION",
      signalType: "REPEATED_SHARED_ACTIVITY_BURSTS",
      score: Math.min(1, burstTimes.length / (TIMING_SYNC_MIN_REPEATED_BURSTS * 2)),
      confidence: 0.4,
      explanation: `Both submissions repeatedly showed activity within seconds of each other, across ${burstTimes.length} separate episodes.`,
      evidence: { repeatedBurstCount: burstTimes.length },
    },
  ];
}

export function computeTimingSynchronisationSignals(
  eventsA: TimedEvent[],
  eventsB: TimedEvent[],
  progressionPointsA: RelativeTimingPoint[],
  progressionPointsB: RelativeTimingPoint[],
): PairSignal[] {
  return [
    ...computeSynchronisedAnswerTimesSignal(eventsA, eventsB),
    ...computeSynchronisedSubstantialEditsSignal(eventsA, eventsB),
    ...computeSynchronisedQuestionProgressionSignal(progressionPointsA, progressionPointsB),
    ...computeRepeatedSharedActivityBurstsSignal(eventsA, eventsB),
  ];
}
