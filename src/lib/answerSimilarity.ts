/**
 * Answer Similarity Review v1 — see docs/answer-similarity-review-v1.md.
 *
 * Pure, dependency-free, deterministic similarity engine: no Prisma, no
 * Next.js, no browser APIs, no LLM, no network. Everything here is
 * transparent, threshold-based, and unit-testable; the DB-touching
 * orchestration lives separately in src/lib/similarityAnalysisRunner.ts
 * (server-only) so this module stays importable from tests without any
 * environment at all.
 *
 * Everything produced here is a REVIEW SIGNAL for a human lecturer:
 * "Similarity review recommended", never "cheating detected" — the
 * lecturer/institution makes the final decision. See the neutral-wording
 * convention in docs/answer-similarity-review-v1.md.
 */

export const SIMILARITY_ALGORITHM_VERSION = "v1.0";

// ---------------------------------------------------------------------------
// Validated string values (schema stores plain strings, per the
// IntegrityEvidenceAsset convention — these arrays are the validators).
// ---------------------------------------------------------------------------

export const SIMILARITY_ANALYSIS_STATUSES = ["PENDING", "PROCESSING", "COMPLETE", "FAILED"] as const;
export type SimilarityAnalysisStatus = (typeof SIMILARITY_ANALYSIS_STATUSES)[number];

export const SIMILARITY_RISK_LEVELS = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export type SimilarityRiskLevel = (typeof SIMILARITY_RISK_LEVELS)[number];

/**
 * v1 implements exactly three signals. SIMILAR_ANSWER_SEQUENCE and
 * SIMILAR_RESPONSE_TIMING are deliberately OMITTED: the Answer model has
 * no createdAt/updatedAt, no autosave history, and timeSpentSeconds is
 * never written by any route — there is no real persisted timing or
 * sequence data to analyse, and fabricating it is out of the question.
 * See docs/answer-similarity-review-v1.md ("Signals deliberately
 * omitted in v1").
 */
export const SIMILARITY_SIGNAL_TYPES = [
  "IDENTICAL_SHORT_ANSWER",
  "HIGH_TEXT_SIMILARITY",
  "SAME_WRONG_MCQ_PATTERN",
] as const;
export type SimilaritySignalType = (typeof SIMILARITY_SIGNAL_TYPES)[number];

export const SIMILARITY_REVIEW_STATUSES = [
  "NEEDS_REVIEW",
  "REVIEWED_NO_CONCERN",
  "REVIEWED_CONCERN_REMAINS",
  "ESCALATED",
  "RESOLVED",
] as const;
export type SimilarityReviewStatus = (typeof SIMILARITY_REVIEW_STATUSES)[number];

/** Required neutral wording — see docs/answer-similarity-review-v1.md. Never "cheating"/"plagiarism confirmed"/"guilty". */
export const SIMILARITY_REVIEW_STATUS_LABELS: Record<SimilarityReviewStatus, string> = {
  NEEDS_REVIEW: "Similarity review recommended",
  REVIEWED_NO_CONCERN: "Reviewed — no concern",
  REVIEWED_CONCERN_REMAINS: "Concern remains",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
};

export function isValidSimilarityReviewStatus(value: string): value is SimilarityReviewStatus {
  return (SIMILARITY_REVIEW_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 3.1 Text normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises an answer for comparison: Unicode NFKC, lowercase, trim,
 * punctuation stripped to spaces, repeated whitespace collapsed. Numbers
 * and alphanumeric technical tokens (x2, 3.14, sha-256, snake_case) are
 * preserved — the character class keeps letters, digits, and the
 * intra-token joiners . _ - so code-ish/technical answers aren't
 * destructively mangled. No stemming in v1 (deliberate — see docs).
 */
export function normalizeAnswerText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]+/gu, " ")
    // A joiner counts as part of a token only between alphanumerics —
    // strip stray leading/trailing joiners left behind by punctuation
    // removal (e.g. a sentence-ending "word." -> "word").
    .replace(/(^|\s)[._-]+|[._-]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whitespace tokenisation of already-normalised text. */
export function tokenizeNormalized(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

// ---------------------------------------------------------------------------
// 3.2 Identical short-answer detection
// ---------------------------------------------------------------------------

/** Common trivial responses that must never be flagged even when identical. */
export const TRIVIAL_ANSWERS = new Set([
  "yes",
  "no",
  "true",
  "false",
  "none",
  "n-a",
  "na",
  "nil",
  "unknown",
  "i don t know",
  "idk",
  "not sure",
  "agree",
  "disagree",
]);

export const IDENTICAL_ANSWER_MIN_CHARS = 40;
export const IDENTICAL_ANSWER_MIN_WORDS = 8;

export type IdenticalShortAnswerResult = {
  matched: boolean;
  normalizedLength: number;
  reasonCode:
    | "IDENTICAL_MEANINGFUL_ANSWER"
    | "NOT_IDENTICAL"
    | "TOO_SHORT"
    | "TRIVIAL_ANSWER"
    | "EMPTY_ANSWER";
  summary: string;
};

/**
 * Flags two answers to the SAME question as an exact match only when the
 * normalised text is identical AND long enough to be meaningful (>= 40
 * chars or >= 8 words) AND not a common trivial response. Callers must
 * only ever pass answers that belong to the same Question.id — this
 * function has no way to check that itself.
 */
export function detectIdenticalShortAnswer(
  answerA: string | null | undefined,
  answerB: string | null | undefined,
): IdenticalShortAnswerResult {
  const a = normalizeAnswerText(answerA);
  const b = normalizeAnswerText(answerB);
  if (a.length === 0 || b.length === 0) {
    return { matched: false, normalizedLength: 0, reasonCode: "EMPTY_ANSWER", summary: "One or both answers are empty." };
  }
  if (a !== b) {
    return { matched: false, normalizedLength: a.length, reasonCode: "NOT_IDENTICAL", summary: "Answers differ after normalisation." };
  }
  if (TRIVIAL_ANSWERS.has(a)) {
    return { matched: false, normalizedLength: a.length, reasonCode: "TRIVIAL_ANSWER", summary: "Identical, but a common trivial response — not a review signal." };
  }
  const words = tokenizeNormalized(a).length;
  if (a.length < IDENTICAL_ANSWER_MIN_CHARS && words < IDENTICAL_ANSWER_MIN_WORDS) {
    return { matched: false, normalizedLength: a.length, reasonCode: "TOO_SHORT", summary: "Identical, but too short to be a meaningful similarity signal." };
  }
  return {
    matched: true,
    normalizedLength: a.length,
    reasonCode: "IDENTICAL_MEANINGFUL_ANSWER",
    summary: `Two responses to the same question are identical after normalisation (${a.length} characters, ${words} words).`,
  };
}

// ---------------------------------------------------------------------------
// 3.3 Long-answer similarity (transparent, non-LLM)
// ---------------------------------------------------------------------------

export const LONG_ANSWER_MIN_CHARS = 80;
export const LONG_ANSWER_MIN_WORDS = 15;
/** HIGH requires ALL of: cosine, n-gram Jaccard, and a distinctive shared phrase. Never a single percentage. */
export const HIGH_SIMILARITY_COSINE = 0.85;
export const HIGH_SIMILARITY_NGRAM_JACCARD = 0.5;
export const MEDIUM_SIMILARITY_COSINE = 0.7;
export const MEDIUM_SIMILARITY_NGRAM_JACCARD = 0.3;
export const SIMILARITY_NGRAM_SIZE = 3;
/** A shared contiguous phrase must be at least this many tokens to count as "distinctive". */
export const DISTINCTIVE_PHRASE_MIN_TOKENS = 6;
/** Longest excerpt of matched text ever stored/returned — the relevant passage only, never the whole submission. */
export const MATCHED_EXCERPT_MAX_CHARS = 240;

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** Cosine similarity of local term-frequency vectors — no external corpus, no embeddings. */
export function cosineSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const tfA = termFrequency(tokensA);
  const tfB = termFrequency(tokensB);
  let dot = 0;
  for (const [term, countA] of tfA) {
    const countB = tfB.get(term);
    if (countB) dot += countA * countB;
  }
  const magA = Math.sqrt([...tfA.values()].reduce((s, c) => s + c * c, 0));
  const magB = Math.sqrt([...tfB.values()].reduce((s, c) => s + c * c, 0));
  return magA === 0 || magB === 0 ? 0 : dot / (magA * magB);
}

export function wordNgrams(tokens: string[], n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) {
    grams.add(tokens.slice(i, i + n).join(" "));
  }
  return grams;
}

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Longest common contiguous token run (classic DP — answers are short enough that O(n*m) is fine). */
export function longestSharedPhrase(tokensA: string[], tokensB: string[]): string[] {
  let best: { end: number; len: number } = { end: 0, len: 0 };
  let prev = new Array<number>(tokensB.length + 1).fill(0);
  for (let i = 1; i <= tokensA.length; i++) {
    const row = new Array<number>(tokensB.length + 1).fill(0);
    for (let j = 1; j <= tokensB.length; j++) {
      if (tokensA[i - 1] === tokensB[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > best.len) best = { end: i, len: row[j] };
      }
    }
    prev = row;
  }
  return tokensA.slice(best.end - best.len, best.end);
}

export type LongAnswerSimilarityResult = {
  level: "none" | "medium" | "high";
  metrics: {
    cosine: number;
    ngramJaccard: number;
    longestSharedPhraseTokens: number;
  };
  /** The relevant matched passage only (capped at MATCHED_EXCERPT_MAX_CHARS) — never the full answer. */
  sharedPhraseExcerpt: string | null;
  reasonCode: "HIGH_MULTI_METRIC_SIMILARITY" | "MEDIUM_MULTI_METRIC_SIMILARITY" | "BELOW_THRESHOLDS" | "TOO_SHORT";
  summary: string;
};

/**
 * Transparent long-answer similarity: HIGH requires high cosine AND high
 * word-n-gram Jaccard AND at least one distinctive shared phrase — never
 * a single unexplained percentage. Only meaningful-length answers to the
 * same question are ever compared (the caller guarantees same
 * Question.id; this function enforces length).
 */
export function compareLongAnswers(
  answerA: string | null | undefined,
  answerB: string | null | undefined,
): LongAnswerSimilarityResult {
  const normA = normalizeAnswerText(answerA);
  const normB = normalizeAnswerText(answerB);
  const tokensA = tokenizeNormalized(normA);
  const tokensB = tokenizeNormalized(normB);

  const metricsZero = { cosine: 0, ngramJaccard: 0, longestSharedPhraseTokens: 0 };
  const longEnough = (norm: string, tokens: string[]) =>
    norm.length >= LONG_ANSWER_MIN_CHARS || tokens.length >= LONG_ANSWER_MIN_WORDS;
  if (!longEnough(normA, tokensA) || !longEnough(normB, tokensB)) {
    return {
      level: "none",
      metrics: metricsZero,
      sharedPhraseExcerpt: null,
      reasonCode: "TOO_SHORT",
      summary: "One or both answers are below the minimum meaningful length for long-answer comparison.",
    };
  }

  const cosine = cosineSimilarity(tokensA, tokensB);
  const ngramJaccard = jaccardSimilarity(
    wordNgrams(tokensA, SIMILARITY_NGRAM_SIZE),
    wordNgrams(tokensB, SIMILARITY_NGRAM_SIZE),
  );
  const phrase = longestSharedPhrase(tokensA, tokensB);
  const metrics = { cosine, ngramJaccard, longestSharedPhraseTokens: phrase.length };
  const excerpt =
    phrase.length >= DISTINCTIVE_PHRASE_MIN_TOKENS
      ? phrase.join(" ").slice(0, MATCHED_EXCERPT_MAX_CHARS)
      : null;
  const hasDistinctivePhrase = phrase.length >= DISTINCTIVE_PHRASE_MIN_TOKENS;

  if (cosine >= HIGH_SIMILARITY_COSINE && ngramJaccard >= HIGH_SIMILARITY_NGRAM_JACCARD && hasDistinctivePhrase) {
    return {
      level: "high",
      metrics,
      sharedPhraseExcerpt: excerpt,
      reasonCode: "HIGH_MULTI_METRIC_SIMILARITY",
      summary:
        `Two responses to the same question contain highly similar wording ` +
        `(cosine ${(cosine * 100).toFixed(0)}%, phrase overlap ${(ngramJaccard * 100).toFixed(0)}%) ` +
        `and a distinctive shared phrase of ${phrase.length} words.`,
    };
  }
  if (cosine >= MEDIUM_SIMILARITY_COSINE && ngramJaccard >= MEDIUM_SIMILARITY_NGRAM_JACCARD && hasDistinctivePhrase) {
    return {
      level: "medium",
      metrics,
      sharedPhraseExcerpt: excerpt,
      reasonCode: "MEDIUM_MULTI_METRIC_SIMILARITY",
      summary:
        `Two responses to the same question show notable wording similarity ` +
        `(cosine ${(cosine * 100).toFixed(0)}%, phrase overlap ${(ngramJaccard * 100).toFixed(0)}%).`,
    };
  }
  return {
    level: "none",
    metrics,
    sharedPhraseExcerpt: null,
    reasonCode: "BELOW_THRESHOLDS",
    summary: "Similarity metrics are below review thresholds.",
  };
}

// ---------------------------------------------------------------------------
// 3.4 Same wrong MCQ pattern
// ---------------------------------------------------------------------------

export const MCQ_MIN_SHARED_QUESTIONS = 5;
export const MCQ_MIN_SAME_WRONG_COUNT = 3;
export const MCQ_MEDIUM_SAME_WRONG_RATIO = 0.4;
export const MCQ_HIGH_SAME_WRONG_COUNT = 5;
export const MCQ_HIGH_SAME_WRONG_RATIO = 0.5;

export type SharedMcqAnswerPair = {
  questionId: string;
  responseA: string | null;
  responseB: string | null;
  correctAnswer: string | null;
};

export type WrongMcqPatternResult = {
  sharedQuestionCount: number;
  sameWrongAnswerCount: number;
  /** sameWrongAnswerCount / sharedQuestionCount (0 when no shared questions). */
  ratio: number;
  questionIdsInvolved: string[];
  riskLevel: SimilarityRiskLevel;
  reasonCode: "STRONG_SAME_WRONG_PATTERN" | "NOTABLE_SAME_WRONG_PATTERN" | "NO_PATTERN" | "INSUFFICIENT_SHARED_QUESTIONS";
  summary: string;
};

/**
 * Flags an unusually strong pattern of IDENTICAL WRONG answers across
 * the MCQ questions two submissions actually share (by Question.id —
 * question pools mean different students may have received different
 * questions, and display position is never used). Identical CORRECT
 * answers are expected and never counted. correctAnswer never leaves
 * this function's output — only counts, a ratio, and question ids.
 */
export function detectSameWrongMcqPattern(shared: SharedMcqAnswerPair[]): WrongMcqPatternResult {
  const sharedQuestionCount = shared.length;
  const base = { sharedQuestionCount, questionIdsInvolved: [] as string[] };
  if (sharedQuestionCount < MCQ_MIN_SHARED_QUESTIONS) {
    return {
      ...base,
      sameWrongAnswerCount: 0,
      ratio: 0,
      riskLevel: "NONE",
      reasonCode: "INSUFFICIENT_SHARED_QUESTIONS",
      summary: `Only ${sharedQuestionCount} shared multiple-choice question(s) — too few for a meaningful pattern.`,
    };
  }

  const sameWrongIds: string[] = [];
  for (const q of shared) {
    const a = normalizeAnswerText(q.responseA);
    const b = normalizeAnswerText(q.responseB);
    const correct = normalizeAnswerText(q.correctAnswer);
    if (a.length === 0 || b.length === 0 || correct.length === 0) continue;
    const bothWrongSame = a === b && a !== correct;
    if (bothWrongSame) sameWrongIds.push(q.questionId);
  }
  const sameWrongAnswerCount = sameWrongIds.length;
  const ratio = sameWrongAnswerCount / sharedQuestionCount;

  if (sameWrongAnswerCount >= MCQ_HIGH_SAME_WRONG_COUNT && ratio >= MCQ_HIGH_SAME_WRONG_RATIO) {
    return {
      ...base,
      sameWrongAnswerCount,
      ratio,
      questionIdsInvolved: sameWrongIds,
      riskLevel: "HIGH",
      reasonCode: "STRONG_SAME_WRONG_PATTERN",
      summary: `${sameWrongAnswerCount} of ${sharedQuestionCount} shared multiple-choice questions have the same incorrect choice.`,
    };
  }
  if (sameWrongAnswerCount >= MCQ_MIN_SAME_WRONG_COUNT && ratio >= MCQ_MEDIUM_SAME_WRONG_RATIO) {
    return {
      ...base,
      sameWrongAnswerCount,
      ratio,
      questionIdsInvolved: sameWrongIds,
      riskLevel: "MEDIUM",
      reasonCode: "NOTABLE_SAME_WRONG_PATTERN",
      summary: `${sameWrongAnswerCount} of ${sharedQuestionCount} shared multiple-choice questions have the same incorrect choice.`,
    };
  }
  return {
    ...base,
    sameWrongAnswerCount,
    ratio,
    questionIdsInvolved: sameWrongIds,
    riskLevel: "NONE",
    reasonCode: "NO_PATTERN",
    summary: "No unusual pattern of identical incorrect choices.",
  };
}

// ---------------------------------------------------------------------------
// Part 4 — Cohort pairing helpers
// ---------------------------------------------------------------------------

/** Canonical (order-independent) pair key so A-vs-B and B-vs-A can never both be recorded. */
export function canonicalPairKey(submissionIdA: string, submissionIdB: string): string {
  return submissionIdA < submissionIdB ? `${submissionIdA}|${submissionIdB}` : `${submissionIdB}|${submissionIdA}`;
}

/** Canonical [source, compared] ordering for persistence — lexicographically smaller id is always the source. */
export function canonicalPairOrder(submissionIdA: string, submissionIdB: string): [string, string] {
  return submissionIdA < submissionIdB ? [submissionIdA, submissionIdB] : [submissionIdB, submissionIdA];
}

/**
 * All unique cross-student pairs from a list of analysable submissions:
 * no self-comparison (also excludes two attempts by the same student —
 * a student matching their own resubmission is expected, not a signal),
 * no duplicate A/B-vs-B/A. Callers must pass only SUBMITTED/GRADED
 * submissions of one exam.
 */
export function buildComparablePairs(
  submissions: Array<{ id: string; studentId: string }>,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (let i = 0; i < submissions.length; i++) {
    for (let j = i + 1; j < submissions.length; j++) {
      const a = submissions[i];
      const b = submissions[j];
      if (a.id === b.id || a.studentId === b.studentId) continue;
      const key = canonicalPairKey(a.id, b.id);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(canonicalPairOrder(a.id, b.id));
    }
  }
  return pairs;
}

/** Overall analysis risk = highest risk of any match found. */
export function overallRiskFromMatches(matchRisks: SimilarityRiskLevel[]): SimilarityRiskLevel {
  if (matchRisks.includes("HIGH")) return "HIGH";
  if (matchRisks.includes("MEDIUM")) return "MEDIUM";
  if (matchRisks.includes("LOW")) return "LOW";
  return "NONE";
}

// ---------------------------------------------------------------------------
// Part 10 — Combined, explainable recommendation
// ---------------------------------------------------------------------------

export const SIMILARITY_RECOMMENDATIONS = [
  "NO_IMMEDIATE_ACTION",
  "LECTURER_REVIEW_RECOMMENDED",
  "ORAL_VERIFICATION_RECOMMENDED",
  "ESCALATION_RECOMMENDED",
] as const;
export type SimilarityRecommendation = (typeof SIMILARITY_RECOMMENDATIONS)[number];

export type RecommendationInput = {
  identicalShortAnswerCount: number;
  highTextSimilarityCount: number;
  mediumTextSimilarityCount: number;
  sameWrongMcqRisk: SimilarityRiskLevel;
  /** Count of existing camera-related integrity events on either submission (phone/second-person). */
  cameraIntegrityEventCount: number;
  /** Whether either submission has a saved evidence frame. */
  hasEvidenceFrame: boolean;
};

export type RecommendationResult = {
  recommendation: SimilarityRecommendation;
  /** Machine-readable reason codes — every recommendation is explainable, never an opaque score. */
  reasonCodes: string[];
  summary: string;
};

/**
 * Explainable, rule-based recommendation — deliberately NOT a hidden
 * numeric "accusation score". One weak signal never recommends oral
 * verification; multiple strong INDEPENDENT signals do. This function
 * only ever recommends — it never creates an OralVerification record
 * (that requires an explicit lecturer action).
 */
export function computeSimilarityRecommendation(input: RecommendationInput): RecommendationResult {
  const reasonCodes: string[] = [];
  if (input.identicalShortAnswerCount > 0) {
    reasonCodes.push(`IDENTICAL_SHORT_ANSWERS:${input.identicalShortAnswerCount}`);
  }
  if (input.highTextSimilarityCount > 0) {
    reasonCodes.push(`HIGH_TEXT_SIMILARITY:${input.highTextSimilarityCount}`);
  }
  if (input.mediumTextSimilarityCount > 0) {
    reasonCodes.push(`MEDIUM_TEXT_SIMILARITY:${input.mediumTextSimilarityCount}`);
  }
  if (input.sameWrongMcqRisk !== "NONE") {
    reasonCodes.push(`SAME_WRONG_MCQ_PATTERN:${input.sameWrongMcqRisk}`);
  }
  if (input.cameraIntegrityEventCount > 0) {
    reasonCodes.push(`CAMERA_INTEGRITY_EVENTS:${input.cameraIntegrityEventCount}`);
  }
  if (input.hasEvidenceFrame) reasonCodes.push("EVIDENCE_FRAME_PRESENT");

  // Count strong, INDEPENDENT similarity signals (camera events alone
  // are corroboration, never a similarity signal in themselves).
  const strongSignals =
    (input.identicalShortAnswerCount > 0 ? 1 : 0) +
    (input.highTextSimilarityCount > 0 ? 1 : 0) +
    (input.sameWrongMcqRisk === "HIGH" ? 1 : 0);
  const weakSignals =
    (input.mediumTextSimilarityCount > 0 ? 1 : 0) + (input.sameWrongMcqRisk === "MEDIUM" ? 1 : 0);
  const corroboration = input.cameraIntegrityEventCount > 0 || input.hasEvidenceFrame;

  if (strongSignals >= 2 || (strongSignals >= 1 && weakSignals >= 1 && corroboration)) {
    const recommendation: SimilarityRecommendation =
      strongSignals >= 2 && corroboration ? "ESCALATION_RECOMMENDED" : "ORAL_VERIFICATION_RECOMMENDED";
    return {
      recommendation,
      reasonCodes,
      summary:
        recommendation === "ESCALATION_RECOMMENDED"
          ? "Multiple strong independent similarity signals plus a corroborating camera integrity signal. This is a review recommendation only."
          : "Multiple independent similarity signals. Oral verification recommended. This is a review recommendation only.",
    };
  }
  if (strongSignals >= 1 || weakSignals >= 1) {
    return {
      recommendation: "LECTURER_REVIEW_RECOMMENDED",
      reasonCodes,
      summary: "A similarity signal was found. Lecturer review recommended. This is a review recommendation only.",
    };
  }
  return {
    recommendation: "NO_IMMEDIATE_ACTION",
    reasonCodes,
    summary: "No similarity signals above review thresholds.",
  };
}
