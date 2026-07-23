/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — shared pure
 * types for the six signal-family modules and the graph engine. See
 * docs/cohort-collusion-graph-v1.md. No Prisma, no Next.js.
 */
import type { SignalFamily } from "@/lib/cohortCollusionThresholds";

/**
 * One explainable signal produced by a family module for a single pair.
 * `score` is a raw 0..1 value BEFORE the per-family cap is applied (the
 * graph engine applies FAMILY_SCORE_CAPS) — never a hidden "accusation
 * score". `evidence` holds only minimal explainable data — never a full
 * duplicated student answer.
 */
export type PairSignal = {
  signalFamily: SignalFamily;
  signalType: string;
  /** Raw strength in [0, 1], before any family cap is applied. */
  score: number;
  /** How confident this specific detection is, in [0, 1] — distinct from score (strength of the underlying match). */
  confidence: number;
  explanation: string;
  evidence: Record<string, unknown>;
};

/** A submission identifier pair in canonical (lexicographically sorted) order — mirrors canonicalPairOrder in answerSimilarity.ts. */
export type SubmissionPairKey = readonly [string, string];

export function canonicalSubmissionPair(a: string, b: string): SubmissionPairKey {
  return a < b ? [a, b] : [b, a];
}
