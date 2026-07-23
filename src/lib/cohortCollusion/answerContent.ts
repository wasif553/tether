/**
 * Cohort-Level Collusion Detection v1 — ANSWER_CONTENT signal family. See
 * docs/cohort-collusion-graph-v1.md and Part 5 of the spec.
 *
 * Deterministic analysis only — never sends whole-cohort answers to an
 * external AI provider. Reuses the well-tested normalisation and
 * similarity primitives already proven in src/lib/answerSimilarity.ts
 * (cosine similarity, word n-grams, Jaccard, longest shared phrase)
 * rather than reinventing them, and adds cohort-wide rare-phrase
 * detection (inverse-cohort-frequency weighting) and a lightweight
 * code/calculation-structure comparison on top.
 */
import {
  normalizeAnswerText,
  tokenizeNormalized,
  wordNgrams,
  jaccardSimilarity,
  longestSharedPhrase,
  detectIdenticalShortAnswer,
  compareLongAnswers,
} from "@/lib/answerSimilarity";
import {
  ANSWER_CONTENT_SHINGLE_SIZE,
  RARE_PHRASE_MAX_COHORT_FRACTION,
  ANSWER_CONTENT_MIN_CHARS,
  ANSWER_CONTENT_MIN_WORDS,
  ANSWER_CONTENT_HIGH_WEIGHTED_JACCARD,
  ANSWER_CONTENT_MEDIUM_WEIGHTED_JACCARD,
  ANSWER_CONTENT_EXCERPT_MAX_CHARS,
} from "@/lib/cohortCollusionThresholds";
import type { PairSignal } from "./types";

export const ANSWER_CONTENT_SIGNAL_TYPES = [
  "HIGH_WRITTEN_SIMILARITY",
  "IDENTICAL_NONTRIVIAL_RESPONSE",
  "UNUSUAL_PHRASE_MATCH",
  "CODE_STRUCTURE_SIMILARITY",
  "MATCHING_CALCULATION_STRUCTURE",
] as const;
export type AnswerContentSignalType = (typeof ANSWER_CONTENT_SIGNAL_TYPES)[number];

/** Per-question cohort-wide shingle document frequency: shingle -> number of DISTINCT submissions whose response contains it at least once. */
export type QuestionShingleDocFrequency = {
  cohortSize: number;
  docFrequency: Map<string, number>;
};

/** Builds cohort-wide shingle statistics for one question from every analysable submission's response — used to discount ordinary shared phrasing (question wording, required terminology, starter code) and surface genuinely rare/distinctive shared phrases. */
export function buildQuestionShingleDocFrequency(
  responses: Array<string | null | undefined>,
  shingleSize: number = ANSWER_CONTENT_SHINGLE_SIZE,
): QuestionShingleDocFrequency {
  const docFrequency = new Map<string, number>();
  let cohortSize = 0;
  for (const response of responses) {
    const normalized = normalizeAnswerText(response);
    if (normalized.length === 0) continue;
    cohortSize++;
    const tokens = tokenizeNormalized(normalized);
    const shingles = wordNgrams(tokens, shingleSize);
    for (const shingle of shingles) {
      docFrequency.set(shingle, (docFrequency.get(shingle) ?? 0) + 1);
    }
  }
  return { cohortSize, docFrequency };
}

/** True for a shingle present in at most RARE_PHRASE_MAX_COHORT_FRACTION of the cohort — i.e. NOT ordinary shared question wording, mandatory terminology, or starter-code boilerplate. */
function isRareShingle(shingle: string, stats: QuestionShingleDocFrequency): boolean {
  if (stats.cohortSize === 0) return false;
  const freq = stats.docFrequency.get(shingle) ?? 0;
  return freq / stats.cohortSize <= RARE_PHRASE_MAX_COHORT_FRACTION;
}

/** Weighted Jaccard over word shingles, weighting each shingle by how rare it is across the cohort (inverse cohort frequency) — ordinary shared phrasing contributes almost nothing; rare shared phrasing dominates the score. */
export function weightedRarePhraseJaccard(
  tokensA: string[],
  tokensB: string[],
  stats: QuestionShingleDocFrequency,
  shingleSize: number = ANSWER_CONTENT_SHINGLE_SIZE,
): { weightedJaccard: number; rareSharedShingles: string[] } {
  const shinglesA = wordNgrams(tokensA, shingleSize);
  const shinglesB = wordNgrams(tokensB, shingleSize);
  const union = new Set<string>([...shinglesA, ...shinglesB]);
  if (union.size === 0) return { weightedJaccard: 0, rareSharedShingles: [] };

  const icf = (shingle: string): number => {
    const freq = stats.docFrequency.get(shingle) ?? 1;
    const fraction = stats.cohortSize > 0 ? freq / stats.cohortSize : 1;
    // Inverse cohort frequency in (0, 1]: a shingle seen by the whole cohort contributes close to 0; a shingle seen by almost no one contributes close to 1.
    return Math.max(0, 1 - fraction);
  };

  let weightedIntersection = 0;
  let weightedUnion = 0;
  const rareSharedShingles: string[] = [];
  for (const shingle of union) {
    const weight = icf(shingle);
    weightedUnion += weight;
    if (shinglesA.has(shingle) && shinglesB.has(shingle)) {
      weightedIntersection += weight;
      if (isRareShingle(shingle, stats)) rareSharedShingles.push(shingle);
    }
  }
  return {
    weightedJaccard: weightedUnion === 0 ? 0 : weightedIntersection / weightedUnion,
    rareSharedShingles,
  };
}

// ---------------------------------------------------------------------------
// Code / calculation structure heuristics — this repo's Question model has
// no distinct "CODE" question type, so code-likeness is detected
// heuristically from the response text itself. Documented v1 limitation:
// see docs/cohort-collusion-graph-v1.md, "Known limitations".
// ---------------------------------------------------------------------------

const CODE_LIKE_PATTERN = /[{};]|=>|\bfunction\b|\bdef \b|\bclass \b|\breturn\b/;
const CALCULATION_LIKE_PATTERN = /^[\s\d.,+\-*/^()=xX]+$/;

export function looksCodeLike(text: string): boolean {
  return CODE_LIKE_PATTERN.test(text);
}

export function looksCalculationLike(normalized: string): boolean {
  return normalized.length > 0 && CALCULATION_LIKE_PATTERN.test(normalized) && /\d/.test(normalized);
}

/**
 * Normalises code-ish text further than normalizeAnswerText: collapses
 * all whitespace/indentation (never meaningful for structural comparison)
 * but leaves punctuation like {}();, intact (structurally significant for
 * code). Does not attempt full identifier-renaming normalisation in v1 —
 * see docs, "Known limitations".
 */
export function normalizeCodeStructure(text: string): string {
  return text
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type AnswerContentPairInput = {
  responseA: string | null | undefined;
  responseB: string | null | undefined;
  /** The question's own text and any lecturer-provided starter/template text — discounted so shared boilerplate is never itself the signal. */
  questionText?: string | null;
  starterCodeOrTemplate?: string | null;
};

function discountBoilerplate(normalized: string, boilerplateNormalized: Set<string>): string {
  if (boilerplateNormalized.size === 0) return normalized;
  const tokens = tokenizeNormalized(normalized);
  return tokens.filter((t) => !boilerplateNormalized.has(t)).join(" ");
}

/** Computes every ANSWER_CONTENT signal for one pair on one shared question. Returns an empty array when nothing rises above threshold. */
export function computeAnswerContentSignals(
  input: AnswerContentPairInput,
  stats: QuestionShingleDocFrequency,
): PairSignal[] {
  const signals: PairSignal[] = [];
  const boilerplate = new Set(
    tokenizeNormalized(normalizeAnswerText(`${input.questionText ?? ""} ${input.starterCodeOrTemplate ?? ""}`)),
  );

  const normA = discountBoilerplate(normalizeAnswerText(input.responseA), boilerplate);
  const normB = discountBoilerplate(normalizeAnswerText(input.responseB), boilerplate);
  if (normA.length === 0 || normB.length === 0) return signals;

  const tokensA = tokenizeNormalized(normA);
  const tokensB = tokenizeNormalized(normB);
  const longEnough =
    (normA.length >= ANSWER_CONTENT_MIN_CHARS || tokensA.length >= ANSWER_CONTENT_MIN_WORDS) &&
    (normB.length >= ANSWER_CONTENT_MIN_CHARS || tokensB.length >= ANSWER_CONTENT_MIN_WORDS);
  if (!longEnough) return signals;

  // Identical non-trivial response — reuses the proven trivial/length gate.
  const identical = detectIdenticalShortAnswer(normA, normB);
  if (identical.matched) {
    signals.push({
      signalFamily: "ANSWER_CONTENT",
      signalType: "IDENTICAL_NONTRIVIAL_RESPONSE",
      score: 1,
      confidence: 0.95,
      explanation: identical.summary,
      evidence: { normalizedLength: identical.normalizedLength },
    });
  }

  // High written similarity — reuses the proven multi-metric comparison.
  const similarity = compareLongAnswers(normA, normB);
  if (similarity.level !== "none") {
    signals.push({
      signalFamily: "ANSWER_CONTENT",
      signalType: "HIGH_WRITTEN_SIMILARITY",
      score: similarity.level === "high" ? similarity.metrics.cosine : similarity.metrics.cosine * 0.7,
      confidence: similarity.level === "high" ? 0.9 : 0.6,
      explanation: similarity.summary,
      evidence: { metrics: similarity.metrics, excerpt: similarity.sharedPhraseExcerpt },
    });
  }

  // Unusual/rare shared phrasing — new cohort-aware signal, distinct from
  // the pairwise-only metrics above (uses inverse cohort frequency).
  const { weightedJaccard, rareSharedShingles } = weightedRarePhraseJaccard(tokensA, tokensB, stats);
  if (weightedJaccard >= ANSWER_CONTENT_MEDIUM_WEIGHTED_JACCARD && rareSharedShingles.length > 0) {
    const level = weightedJaccard >= ANSWER_CONTENT_HIGH_WEIGHTED_JACCARD ? "high" : "medium";
    signals.push({
      signalFamily: "ANSWER_CONTENT",
      signalType: "UNUSUAL_PHRASE_MATCH",
      score: weightedJaccard,
      confidence: level === "high" ? 0.85 : 0.55,
      explanation: `The two responses share ${rareSharedShingles.length} distinctive phrase(s) that are uncommon across the rest of the cohort's answers to this question.`,
      evidence: {
        weightedJaccard: Number(weightedJaccard.toFixed(3)),
        rareSharedPhraseCount: rareSharedShingles.length,
        exampleExcerpt: rareSharedShingles[0]?.slice(0, ANSWER_CONTENT_EXCERPT_MAX_CHARS) ?? null,
      },
    });
  }

  // Code / calculation structure — heuristic; see docs "Known limitations".
  const rawA = input.responseA ?? "";
  const rawB = input.responseB ?? "";
  if (looksCodeLike(rawA) && looksCodeLike(rawB)) {
    const codeA = normalizeCodeStructure(rawA);
    const codeB = normalizeCodeStructure(rawB);
    const codeTokensA = codeA.split(/\s+/).filter(Boolean);
    const codeTokensB = codeB.split(/\s+/).filter(Boolean);
    const codeJaccard = jaccardSimilarity(new Set(codeTokensA), new Set(codeTokensB));
    const sharedStructure = longestSharedPhrase(codeTokensA, codeTokensB);
    if (codeJaccard >= ANSWER_CONTENT_MEDIUM_WEIGHTED_JACCARD && sharedStructure.length >= 6) {
      signals.push({
        signalFamily: "ANSWER_CONTENT",
        signalType: "CODE_STRUCTURE_SIMILARITY",
        score: codeJaccard,
        confidence: 0.6,
        explanation: "Two code-like responses share unusually similar token structure, comments, or formatting after normalisation.",
        evidence: { codeJaccard: Number(codeJaccard.toFixed(3)), sharedStructureTokens: sharedStructure.length },
      });
    }
  } else if (looksCalculationLike(normA) && looksCalculationLike(normB)) {
    const calcJaccard = jaccardSimilarity(new Set(tokensA), new Set(tokensB));
    if (calcJaccard >= ANSWER_CONTENT_HIGH_WEIGHTED_JACCARD) {
      signals.push({
        signalFamily: "ANSWER_CONTENT",
        signalType: "MATCHING_CALCULATION_STRUCTURE",
        score: calcJaccard,
        confidence: 0.55,
        explanation: "Two numeric/calculation-style responses show unusually similar working steps after normalisation.",
        evidence: { calcJaccard: Number(calcJaccard.toFixed(3)) },
      });
    }
  }

  return signals;
}
