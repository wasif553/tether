/**
 * Cohort-Level Collusion Detection v1 — RARE_MISTAKE signal family. See
 * docs/cohort-collusion-graph-v1.md and Part 2.2 of the spec.
 *
 * Per-question incidents only (a single shared wrong answer) — distinct
 * from MCQ_PATTERN, which looks at the SEQUENCE of matches across many
 * questions. A mistake made by many students in the cohort gets little or
 * no weight; rarity is the entire point (see rarityWeightForFraction in
 * src/lib/cohortCollusionThresholds.ts). Never inputs a correct answer —
 * every function here requires the response to be WRONG first.
 */
import { normalizeAnswerText } from "@/lib/answerSimilarity";
import { rarityWeightForFraction, rarityBandForFraction } from "@/lib/cohortCollusionThresholds";
import { looksCodeLike, looksCalculationLike } from "./answerContent";
import type { PairSignal } from "./types";

export const RARE_MISTAKE_SIGNAL_TYPES = [
  "IDENTICAL_RARE_WRONG_ANSWER",
  "MATCHING_RARE_MCQ_ERROR",
  "MATCHING_UNUSUAL_CALCULATION_ERROR",
  "MATCHING_UNUSUAL_CODE_DEFECT",
] as const;
export type RareMistakeSignalType = (typeof RARE_MISTAKE_SIGNAL_TYPES)[number];

/** Cohort-wide frequency of each normalised WRONG response to one question, plus how many submissions answered it at all (the fraction denominator). */
export type QuestionWrongAnswerFrequency = {
  answeredCount: number;
  wrongResponseCounts: Map<string, number>;
};

export type CohortAnswerForRarity = {
  normalizedResponse: string;
  isWrong: boolean;
};

export function buildQuestionWrongAnswerFrequency(answers: CohortAnswerForRarity[]): QuestionWrongAnswerFrequency {
  const wrongResponseCounts = new Map<string, number>();
  let answeredCount = 0;
  for (const a of answers) {
    if (a.normalizedResponse.length === 0) continue;
    answeredCount++;
    if (a.isWrong) {
      wrongResponseCounts.set(a.normalizedResponse, (wrongResponseCounts.get(a.normalizedResponse) ?? 0) + 1);
    }
  }
  return { answeredCount, wrongResponseCounts };
}

function fractionOfCohort(normalizedResponse: string, stats: QuestionWrongAnswerFrequency): number {
  if (stats.answeredCount === 0) return 1;
  const count = stats.wrongResponseCounts.get(normalizedResponse) ?? 0;
  return count / stats.answeredCount;
}

export type RareMistakePairInput = {
  questionId: string;
  questionType: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  responseA: string | null | undefined;
  responseB: string | null | undefined;
  correctAnswer: string | null | undefined;
  /** Explicit Answer.isCorrect, when known — takes precedence over comparing against correctAnswer. */
  isCorrectA?: boolean | null;
  isCorrectB?: boolean | null;
};

function isResponseWrong(
  normalizedResponse: string,
  normalizedCorrect: string,
  explicitIsCorrect: boolean | null | undefined,
): boolean | null {
  if (normalizedResponse.length === 0) return null;
  if (explicitIsCorrect != null) return explicitIsCorrect === false;
  if (normalizedCorrect.length === 0) return null; // No known correct answer — wrongness is undeterminable (e.g. open-ended essay).
  return normalizedResponse !== normalizedCorrect;
}

/** Computes RARE_MISTAKE signals for one pair on one shared question. Requires BOTH responses to be determinably wrong and identical after normalisation — never flags a shared correct answer. */
export function computeRareMistakeSignals(
  input: RareMistakePairInput,
  stats: QuestionWrongAnswerFrequency,
): PairSignal[] {
  const normA = normalizeAnswerText(input.responseA);
  const normB = normalizeAnswerText(input.responseB);
  const normCorrect = normalizeAnswerText(input.correctAnswer);
  if (normA.length === 0 || normB.length === 0 || normA !== normB) return [];

  const wrongA = isResponseWrong(normA, normCorrect, input.isCorrectA);
  const wrongB = isResponseWrong(normB, normCorrect, input.isCorrectB);
  if (wrongA !== true || wrongB !== true) return []; // Only fires when BOTH are determinably wrong.

  const fraction = fractionOfCohort(normA, stats);
  const weight = rarityWeightForFraction(fraction);
  const band = rarityBandForFraction(fraction);
  if (band === "COMMON") return []; // A common mistake made by many students gets no signal at all.

  const evidence = {
    rarityBand: band,
    fractionOfCohortWithThisWrongAnswer: Number(fraction.toFixed(3)),
    questionId: input.questionId,
  };

  if (input.questionType === "MULTIPLE_CHOICE") {
    return [
      {
        signalFamily: "RARE_MISTAKE",
        signalType: "MATCHING_RARE_MCQ_ERROR",
        score: weight,
        confidence: band === "RARE" ? 0.9 : 0.6,
        explanation: `Both responses chose the same incorrect option on this question, an option ${band === "RARE" ? "almost no one else in the cohort chose" : "relatively few others in the cohort chose"}.`,
        evidence,
      },
    ];
  }

  const rawA = input.responseA ?? "";
  if (looksCodeLike(rawA)) {
    return [
      {
        signalFamily: "RARE_MISTAKE",
        signalType: "MATCHING_UNUSUAL_CODE_DEFECT",
        score: weight,
        confidence: band === "RARE" ? 0.85 : 0.55,
        explanation: "Both responses contain the same uncommon incorrect code pattern.",
        evidence,
      },
    ];
  }
  if (looksCalculationLike(normA)) {
    return [
      {
        signalFamily: "RARE_MISTAKE",
        signalType: "MATCHING_UNUSUAL_CALCULATION_ERROR",
        score: weight,
        confidence: band === "RARE" ? 0.85 : 0.55,
        explanation: "Both responses reach the same uncommon incorrect calculation result.",
        evidence,
      },
    ];
  }
  return [
    {
      signalFamily: "RARE_MISTAKE",
      signalType: "IDENTICAL_RARE_WRONG_ANSWER",
      score: weight,
      confidence: band === "RARE" ? 0.85 : 0.55,
      explanation: `Both responses give the same incorrect answer, one ${band === "RARE" ? "almost no one else in the cohort gave" : "relatively few others in the cohort gave"}.`,
      evidence,
    },
  ];
}
