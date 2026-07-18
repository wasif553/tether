/**
 * Answer Similarity Review v1 — see docs/answer-similarity-review-v1.md
 * and src/lib/answerSimilarity.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeAnswerText,
  tokenizeNormalized,
  detectIdenticalShortAnswer,
  compareLongAnswers,
  cosineSimilarity,
  wordNgrams,
  jaccardSimilarity,
  longestSharedPhrase,
  detectSameWrongMcqPattern,
  buildComparablePairs,
  canonicalPairKey,
  canonicalPairOrder,
  overallRiskFromMatches,
  computeSimilarityRecommendation,
  isValidSimilarityReviewStatus,
  SIMILARITY_REVIEW_STATUS_LABELS,
} from "./answerSimilarity";

describe("normalizeAnswerText", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeAnswerText("  Hello   World  ")).toBe("hello world");
  });

  it("removes punctuation but preserves numbers and technical tokens", () => {
    expect(normalizeAnswerText("The answer is 3.14, definitely!")).toBe("the answer is 3.14 definitely");
    expect(normalizeAnswerText("snake_case and kebab-case tokens")).toBe("snake_case and kebab-case tokens");
  });

  it("normalises case differences and minor punctuation the same way", () => {
    const a = normalizeAnswerText("It Depends, on the Context.");
    const b = normalizeAnswerText("it depends on the context");
    expect(a).toBe(b);
  });

  it("handles empty/null/undefined answers safely", () => {
    expect(normalizeAnswerText("")).toBe("");
    expect(normalizeAnswerText(null)).toBe("");
    expect(normalizeAnswerText(undefined)).toBe("");
  });

  it("does not destructively mangle code-like answers", () => {
    expect(normalizeAnswerText("return x + 1;")).toContain("x");
    expect(normalizeAnswerText("O(n^2)").length).toBeGreaterThan(0);
  });
});

describe("detectIdenticalShortAnswer", () => {
  it("flags identical meaningful answers", () => {
    const longAnswer = "Photosynthesis converts light energy into chemical energy stored in glucose molecules.";
    const result = detectIdenticalShortAnswer(longAnswer, longAnswer);
    expect(result.matched).toBe(true);
    expect(result.reasonCode).toBe("IDENTICAL_MEANINGFUL_ANSWER");
  });

  it("ignores trivial short answers even when identical", () => {
    expect(detectIdenticalShortAnswer("yes", "yes").matched).toBe(false);
    expect(detectIdenticalShortAnswer("No.", "no").matched).toBe(false);
    expect(detectIdenticalShortAnswer("True", "true").matched).toBe(false);
  });

  it("does not flag short (non-trivial but too-short) identical answers", () => {
    expect(detectIdenticalShortAnswer("water", "water").matched).toBe(false);
  });

  it("normalises minor punctuation/case differences before comparing", () => {
    const a = "The mitochondria is the powerhouse of the cell, essentially.";
    const b = "the mitochondria is the powerhouse of the cell essentially";
    expect(detectIdenticalShortAnswer(a, b).matched).toBe(true);
  });

  it("does not flag different (non-identical) answers", () => {
    const a = "Photosynthesis converts light energy into chemical energy in plants.";
    const b = "Cellular respiration breaks down glucose to release energy for cells.";
    expect(detectIdenticalShortAnswer(a, b).matched).toBe(false);
  });

  it("handles empty answers safely", () => {
    expect(detectIdenticalShortAnswer("", "").matched).toBe(false);
    expect(detectIdenticalShortAnswer(null, null).matched).toBe(false);
  });
});

describe("cosineSimilarity / wordNgrams / jaccardSimilarity / longestSharedPhrase", () => {
  it("cosineSimilarity is 1 for identical token sets and 0 for disjoint sets", () => {
    expect(cosineSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBeCloseTo(1, 5);
    expect(cosineSimilarity(["a", "b"], ["x", "y"])).toBe(0);
  });

  it("jaccardSimilarity of identical n-gram sets is 1", () => {
    const tokens = ["the", "quick", "brown", "fox"];
    const grams = wordNgrams(tokens, 2);
    expect(jaccardSimilarity(grams, grams)).toBe(1);
  });

  it("longestSharedPhrase finds the longest contiguous shared run", () => {
    const a = ["the", "mitochondria", "is", "the", "powerhouse", "of", "the", "cell"];
    const b = ["everyone", "knows", "the", "mitochondria", "is", "the", "powerhouse", "of", "life"];
    const shared = longestSharedPhrase(a, b);
    expect(shared.join(" ")).toBe("the mitochondria is the powerhouse of");
  });
});

describe("compareLongAnswers", () => {
  const essayA =
    "The French Revolution began in 1789 due to widespread economic hardship, social inequality between " +
    "the estates, and the crushing weight of royal debt from foreign wars. The storming of the Bastille " +
    "became a symbol of the uprising against absolute monarchy.";
  const essayB =
    "The French Revolution began in 1789 due to widespread economic hardship, social inequality between " +
    "the estates, and the crushing weight of royal debt from foreign wars. The storming of the Bastille " +
    "became a symbol of the uprising against absolute monarchy.";
  const unrelatedEssay =
    "Mitochondria are membrane-bound organelles found in the cytoplasm of eukaryotic cells that generate " +
    "most of the chemical energy needed to power biochemical reactions through cellular respiration.";
  const genericShortEssay = "I think this is an interesting topic and there are many views on it.";

  it("flags highly similar essays as high similarity", () => {
    const result = compareLongAnswers(essayA, essayB);
    expect(result.level).toBe("high");
    expect(result.reasonCode).toBe("HIGH_MULTI_METRIC_SIMILARITY");
    expect(result.sharedPhraseExcerpt).not.toBeNull();
  });

  it("does not flag unrelated essays", () => {
    const result = compareLongAnswers(essayA, unrelatedEssay);
    expect(result.level).toBe("none");
  });

  it("does not flag short generic text (below minimum length)", () => {
    const result = compareLongAnswers(genericShortEssay, genericShortEssay);
    expect(result.level).toBe("none");
    expect(result.reasonCode).toBe("TOO_SHORT");
  });

  it("requires a distinctive shared phrase, not just high cosine, for a HIGH result", () => {
    // Same word bag, shuffled into unrelated short clauses — high cosine
    // possible but no long contiguous shared phrase.
    const a = "energy light chemical convert plant leaf green sun grow water soil root stem";
    const b = "soil root stem water grow sun green leaf plant convert chemical light energy";
    const result = compareLongAnswers(a, b);
    expect(result.metrics.longestSharedPhraseTokens).toBeLessThan(6);
    expect(result.level).not.toBe("high");
  });

  it("is deterministic — repeated calls give identical results", () => {
    const r1 = compareLongAnswers(essayA, unrelatedEssay);
    const r2 = compareLongAnswers(essayA, unrelatedEssay);
    expect(r1).toEqual(r2);
  });
});

describe("detectSameWrongMcqPattern", () => {
  const sharedQuestion = (
    questionId: string,
    responseA: string,
    responseB: string,
    correctAnswer: string,
  ) => ({ questionId, responseA, responseB, correctAnswer });

  it("does not flag identical CORRECT answers alone", () => {
    const shared = Array.from({ length: 6 }, (_, i) =>
      sharedQuestion(`q${i}`, "B", "B", "B"),
    );
    const result = detectSameWrongMcqPattern(shared);
    expect(result.riskLevel).toBe("NONE");
    expect(result.sameWrongAnswerCount).toBe(0);
  });

  it("flags an unusually strong pattern of identical WRONG answers", () => {
    const shared = [
      sharedQuestion("q1", "C", "C", "B"),
      sharedQuestion("q2", "A", "A", "D"),
      sharedQuestion("q3", "C", "C", "A"),
      sharedQuestion("q4", "B", "B", "A"),
      sharedQuestion("q5", "D", "D", "C"),
      sharedQuestion("q6", "B", "A", "B"), // differing — not counted
    ];
    const result = detectSameWrongMcqPattern(shared);
    expect(result.riskLevel).toBe("HIGH");
    expect(result.sameWrongAnswerCount).toBe(5);
    expect(result.sharedQuestionCount).toBe(6);
    expect(result.questionIdsInvolved).toEqual(["q1", "q2", "q3", "q4", "q5"]);
  });

  it("does not flag insufficient shared questions", () => {
    const shared = [
      sharedQuestion("q1", "C", "C", "B"),
      sharedQuestion("q2", "A", "A", "D"),
    ];
    const result = detectSameWrongMcqPattern(shared);
    expect(result.riskLevel).toBe("NONE");
    expect(result.reasonCode).toBe("INSUFFICIENT_SHARED_QUESTIONS");
  });

  it("question position/order never affects comparison — only Question.id matters", () => {
    const sharedInOrderA = [
      sharedQuestion("q5", "C", "C", "B"),
      sharedQuestion("q1", "A", "A", "D"),
      sharedQuestion("q9", "C", "C", "A"),
      sharedQuestion("q2", "B", "B", "A"),
      sharedQuestion("q7", "D", "D", "C"),
    ];
    const shuffledOrder = [...sharedInOrderA].reverse();
    const resultA = detectSameWrongMcqPattern(sharedInOrderA);
    const resultB = detectSameWrongMcqPattern(shuffledOrder);
    expect(resultA.sameWrongAnswerCount).toBe(resultB.sameWrongAnswerCount);
    expect(resultA.riskLevel).toBe(resultB.riskLevel);
  });

  it("only compares shared Question.ids — never assumes matching answer arrays by index", () => {
    // Simulates two submissions with different question-pool selections:
    // only the genuinely shared ids are ever passed in by the caller.
    const shared = [sharedQuestion("shared-q1", "C", "C", "A")];
    const result = detectSameWrongMcqPattern(shared);
    expect(result.sharedQuestionCount).toBe(1);
  });
});

describe("buildComparablePairs / canonicalPairKey / canonicalPairOrder", () => {
  it("never compares a submission against itself", () => {
    const pairs = buildComparablePairs([{ id: "s1", studentId: "u1" }]);
    expect(pairs).toEqual([]);
  });

  it("never creates duplicate A-vs-B and B-vs-A rows", () => {
    const pairs = buildComparablePairs([
      { id: "s1", studentId: "u1" },
      { id: "s2", studentId: "u2" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(canonicalPairKey(pairs[0][0], pairs[0][1])).toBe(canonicalPairKey("s1", "s2"));
  });

  it("excludes a pair where both submissions belong to the same student (e.g. multiple attempts)", () => {
    const pairs = buildComparablePairs([
      { id: "s1", studentId: "u1" },
      { id: "s2", studentId: "u1" },
    ]);
    expect(pairs).toEqual([]);
  });

  it("canonicalPairOrder always puts the lexicographically smaller id first, regardless of input order", () => {
    expect(canonicalPairOrder("b", "a")).toEqual(["a", "b"]);
    expect(canonicalPairOrder("a", "b")).toEqual(["a", "b"]);
  });

  it("produces one pair per unique student pair for a larger cohort, no duplicates", () => {
    const submissions = [
      { id: "s1", studentId: "u1" },
      { id: "s2", studentId: "u2" },
      { id: "s3", studentId: "u3" },
    ];
    const pairs = buildComparablePairs(submissions);
    expect(pairs).toHaveLength(3);
    const keys = new Set(pairs.map(([a, b]) => canonicalPairKey(a, b)));
    expect(keys.size).toBe(3);
  });
});

describe("overallRiskFromMatches", () => {
  it("returns the highest risk level present", () => {
    expect(overallRiskFromMatches(["NONE", "LOW", "HIGH", "MEDIUM"])).toBe("HIGH");
    expect(overallRiskFromMatches(["NONE", "LOW"])).toBe("LOW");
    expect(overallRiskFromMatches([])).toBe("NONE");
  });
});

describe("computeSimilarityRecommendation", () => {
  it("one weak signal alone does not recommend oral verification", () => {
    const result = computeSimilarityRecommendation({
      identicalShortAnswerCount: 0,
      highTextSimilarityCount: 0,
      mediumTextSimilarityCount: 1,
      sameWrongMcqRisk: "NONE",
      cameraIntegrityEventCount: 0,
      hasEvidenceFrame: false,
    });
    expect(result.recommendation).not.toBe("ORAL_VERIFICATION_RECOMMENDED");
    expect(result.recommendation).toBe("LECTURER_REVIEW_RECOMMENDED");
  });

  it("multiple strong independent signals recommend oral verification", () => {
    const result = computeSimilarityRecommendation({
      identicalShortAnswerCount: 1,
      highTextSimilarityCount: 1,
      mediumTextSimilarityCount: 0,
      sameWrongMcqRisk: "NONE",
      cameraIntegrityEventCount: 0,
      hasEvidenceFrame: false,
    });
    expect(result.recommendation).toBe("ORAL_VERIFICATION_RECOMMENDED");
  });

  it("recommendations always include reason codes", () => {
    const result = computeSimilarityRecommendation({
      identicalShortAnswerCount: 1,
      highTextSimilarityCount: 0,
      mediumTextSimilarityCount: 0,
      sameWrongMcqRisk: "NONE",
      cameraIntegrityEventCount: 0,
      hasEvidenceFrame: false,
    });
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.reasonCodes[0]).toContain("IDENTICAL_SHORT_ANSWERS");
  });

  it("multiple strong signals plus a corroborating camera signal recommend escalation", () => {
    const result = computeSimilarityRecommendation({
      identicalShortAnswerCount: 1,
      highTextSimilarityCount: 1,
      mediumTextSimilarityCount: 0,
      sameWrongMcqRisk: "HIGH",
      cameraIntegrityEventCount: 2,
      hasEvidenceFrame: true,
    });
    expect(result.recommendation).toBe("ESCALATION_RECOMMENDED");
  });

  it("no signals at all recommends no immediate action", () => {
    const result = computeSimilarityRecommendation({
      identicalShortAnswerCount: 0,
      highTextSimilarityCount: 0,
      mediumTextSimilarityCount: 0,
      sameWrongMcqRisk: "NONE",
      cameraIntegrityEventCount: 0,
      hasEvidenceFrame: false,
    });
    expect(result.recommendation).toBe("NO_IMMEDIATE_ACTION");
  });

  it("never mentions banned wording in any summary", () => {
    const result = computeSimilarityRecommendation({
      identicalShortAnswerCount: 1,
      highTextSimilarityCount: 1,
      mediumTextSimilarityCount: 0,
      sameWrongMcqRisk: "HIGH",
      cameraIntegrityEventCount: 1,
      hasEvidenceFrame: false,
    });
    const lower = result.summary.toLowerCase();
    expect(lower).not.toContain("cheating");
    expect(lower).not.toContain("plagiarism confirmed");
    expect(lower).not.toContain("guilty");
    expect(lower).not.toContain("proof");
  });
});

describe("isValidSimilarityReviewStatus / SIMILARITY_REVIEW_STATUS_LABELS", () => {
  it("uses only the required neutral wording", () => {
    expect(SIMILARITY_REVIEW_STATUS_LABELS.NEEDS_REVIEW).toBe("Similarity review recommended");
    expect(SIMILARITY_REVIEW_STATUS_LABELS.REVIEWED_NO_CONCERN).toBe("Reviewed — no concern");
    expect(SIMILARITY_REVIEW_STATUS_LABELS.REVIEWED_CONCERN_REMAINS).toBe("Concern remains");
    expect(SIMILARITY_REVIEW_STATUS_LABELS.ESCALATED).toBe("Escalated");
    expect(SIMILARITY_REVIEW_STATUS_LABELS.RESOLVED).toBe("Resolved");
  });

  it("validates only the five known review statuses", () => {
    expect(isValidSimilarityReviewStatus("NEEDS_REVIEW")).toBe(true);
    expect(isValidSimilarityReviewStatus("NOT_A_STATUS")).toBe(false);
  });
});

describe("tokenizeNormalized", () => {
  it("returns an empty array for empty normalized text", () => {
    expect(tokenizeNormalized("")).toEqual([]);
  });
});
