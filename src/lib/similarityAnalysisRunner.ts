/**
 * Answer Similarity Review v1 — server-only analysis orchestration. See
 * docs/answer-similarity-review-v1.md.
 *
 * Touches Prisma, so it must never be imported from a "use client"
 * component — all pure comparison logic lives in
 * src/lib/answerSimilarity.ts instead, and this module only wires data
 * in and out of it.
 *
 * v1 runs synchronously inside the lecturer-triggered request (there is
 * no queue/worker in this repo, and pretending otherwise would be
 * worse). To keep that safe on Vercel, the cohort is hard-capped at
 * MAX_ANALYSIS_SUBMISSIONS — see docs for the documented limit. Analysis
 * failure never affects the submissions themselves: it only marks the
 * analysis row FAILED, and the lecturer can retry.
 */
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import {
  SIMILARITY_ALGORITHM_VERSION,
  buildComparablePairs,
  compareLongAnswers,
  computeSimilarityRecommendation,
  detectIdenticalShortAnswer,
  detectSameWrongMcqPattern,
  overallRiskFromMatches,
  type RecommendationResult,
  type SimilarityRiskLevel,
} from "@/lib/answerSimilarity";

/**
 * Documented v1 cohort cap for the synchronous, lecturer-triggered run.
 * At 100 submissions this is at most 4,950 pairs of short in-memory
 * comparisons — comfortably within a request budget. Larger cohorts are
 * refused with a clear error rather than left to time out.
 */
export const MAX_ANALYSIS_SUBMISSIONS = 100;

export class SimilarityCohortTooLargeError extends Error {
  constructor(count: number) {
    super(
      `This exam has ${count} analysable submissions — above the v1 limit of ${MAX_ANALYSIS_SUBMISSIONS} ` +
        `for a synchronous analysis run. See docs/answer-similarity-review-v1.md.`,
    );
  }
}

type PendingMatch = {
  sourceSubmissionId: string;
  comparedSubmissionId: string;
  questionId: string | null;
  signalType: string;
  score: number;
  risk: SimilarityRiskLevel;
  matchedDetailJson: Record<string, unknown>;
};

export type PairRecommendationSummary = {
  submissionIds: [string, string];
  recommendation: RecommendationResult;
};

/**
 * Runs (or re-runs) similarity analysis for one exam. Reuses a single
 * SubmissionSimilarityAnalysis row per exam — a re-run replaces the
 * previous matches (review statuses on stale matches would otherwise
 * refer to superseded findings). Returns the analysis id.
 */
export async function runSimilarityAnalysisForExam(examId: string): Promise<string> {
  // One reusable analysis row per exam.
  const existing = await prisma.submissionSimilarityAnalysis.findFirst({
    where: { examId },
    orderBy: { createdAt: "asc" },
  });
  const analysis = existing
    ? await prisma.submissionSimilarityAnalysis.update({
        where: { id: existing.id },
        data: { status: "PROCESSING", algorithmVersion: SIMILARITY_ALGORITHM_VERSION },
      })
    : await prisma.submissionSimilarityAnalysis.create({
        data: { examId, status: "PROCESSING", algorithmVersion: SIMILARITY_ALGORITHM_VERSION },
      });

  try {
    // --- Load the analysable cohort: SUBMITTED/GRADED only, this exam only.
    const submissions = await prisma.submission.findMany({
      where: { examId, status: { in: ["SUBMITTED", "GRADED"] } },
      select: {
        id: true,
        studentId: true,
        attemptNumber: true,
        questionOrderJson: true,
        answers: { select: { questionId: true, response: true } },
      },
    });
    if (submissions.length > MAX_ANALYSIS_SUBMISSIONS) {
      throw new SimilarityCohortTooLargeError(submissions.length);
    }

    const exam = await prisma.exam.findUniqueOrThrow({
      where: { id: examId },
      select: {
        secureSettings: true,
        questions: { select: { id: true, type: true, correctAnswer: true }, orderBy: { order: "asc" } },
      },
    });
    const settings = parseSecureSettings(exam.secureSettings);
    const poolsActive = questionPoolsActive(settings);
    const allQuestionIds = exam.questions.map((q) => q.id);
    const questionById = new Map(exam.questions.map((q) => [q.id, q]));

    // Per-submission: the question ids that submission was actually given
    // (respects question pools), and its answers keyed by question id.
    const perSubmission = submissions.map((s) => ({
      id: s.id,
      studentId: s.studentId,
      attemptNumber: s.attemptNumber,
      effectiveQuestionIds: new Set(
        resolveEffectiveQuestionIds({
          examQuestionIds: allQuestionIds,
          stored: s.questionOrderJson,
          questionPoolsActive: poolsActive,
        }),
      ),
      answersByQuestion: new Map(s.answers.map((a) => [a.questionId, a.response])),
    }));
    const submissionById = new Map(perSubmission.map((s) => [s.id, s]));

    // Camera-signal corroboration inputs for the recommendation function
    // (counts only — never image data, and the recommendation only ever
    // recommends, it never creates anything).
    const cameraEvents = await prisma.integrityEvent.groupBy({
      by: ["submissionId"],
      where: {
        submissionId: { in: submissions.map((s) => s.id) },
        eventType: { in: ["POSSIBLE_PHONE_VISIBLE", "POSSIBLE_SECOND_PERSON_VISIBLE"] },
      },
      _count: { _all: true },
    });
    const cameraEventCountBySubmission = new Map(cameraEvents.map((e) => [e.submissionId, e._count._all]));
    const evidenceAssets = await prisma.integrityEvidenceAsset.findMany({
      where: { submissionId: { in: submissions.map((s) => s.id) } },
      select: { submissionId: true },
    });
    const hasEvidenceFrame = new Set(evidenceAssets.map((e) => e.submissionId));

    // --- Compare every unique cross-student pair on their SHARED questions.
    const pairs = buildComparablePairs(perSubmission);
    const pendingMatches: PendingMatch[] = [];
    const pairRecommendations: PairRecommendationSummary[] = [];

    for (const [sourceId, comparedId] of pairs) {
      const source = submissionById.get(sourceId)!;
      const compared = submissionById.get(comparedId)!;
      const sharedQuestionIds = [...source.effectiveQuestionIds].filter((qid) =>
        compared.effectiveQuestionIds.has(qid),
      );

      let identicalCount = 0;
      let highTextCount = 0;
      let mediumTextCount = 0;
      const sharedMcqs: Array<{ questionId: string; responseA: string | null; responseB: string | null; correctAnswer: string | null }> = [];

      for (const questionId of sharedQuestionIds) {
        const question = questionById.get(questionId);
        if (!question) continue;
        const responseA = source.answersByQuestion.get(questionId) ?? null;
        const responseB = compared.answersByQuestion.get(questionId) ?? null;

        if (question.type === "MULTIPLE_CHOICE") {
          sharedMcqs.push({ questionId, responseA, responseB, correctAnswer: question.correctAnswer });
          continue;
        }

        // Text questions (SHORT_ANSWER / ESSAY): identical first, then
        // graded similarity — an identical match supersedes a similarity
        // match for the same question (it IS 100% similarity).
        const identical = detectIdenticalShortAnswer(responseA, responseB);
        if (identical.matched) {
          identicalCount++;
          pendingMatches.push({
            sourceSubmissionId: sourceId,
            comparedSubmissionId: comparedId,
            questionId,
            signalType: "IDENTICAL_SHORT_ANSWER",
            score: 1,
            risk: "HIGH",
            matchedDetailJson: {
              reasonCode: identical.reasonCode,
              summary: identical.summary,
              normalizedLength: identical.normalizedLength,
            },
          });
          continue;
        }

        const similarity = compareLongAnswers(responseA, responseB);
        if (similarity.level !== "none") {
          if (similarity.level === "high") highTextCount++;
          else mediumTextCount++;
          pendingMatches.push({
            sourceSubmissionId: sourceId,
            comparedSubmissionId: comparedId,
            questionId,
            signalType: "HIGH_TEXT_SIMILARITY",
            score: similarity.metrics.cosine,
            risk: similarity.level === "high" ? "HIGH" : "MEDIUM",
            matchedDetailJson: {
              reasonCode: similarity.reasonCode,
              summary: similarity.summary,
              metrics: similarity.metrics,
              sharedPhraseExcerpt: similarity.sharedPhraseExcerpt,
            },
          });
        }
      }

      const mcqPattern = detectSameWrongMcqPattern(sharedMcqs);
      if (mcqPattern.riskLevel !== "NONE") {
        pendingMatches.push({
          sourceSubmissionId: sourceId,
          comparedSubmissionId: comparedId,
          questionId: null,
          signalType: "SAME_WRONG_MCQ_PATTERN",
          score: mcqPattern.ratio,
          risk: mcqPattern.riskLevel,
          matchedDetailJson: {
            reasonCode: mcqPattern.reasonCode,
            summary: mcqPattern.summary,
            sharedQuestionCount: mcqPattern.sharedQuestionCount,
            sameWrongAnswerCount: mcqPattern.sameWrongAnswerCount,
            ratio: mcqPattern.ratio,
            questionIdsInvolved: mcqPattern.questionIdsInvolved,
          },
        });
      }

      if (identicalCount > 0 || highTextCount > 0 || mediumTextCount > 0 || mcqPattern.riskLevel !== "NONE") {
        const cameraIntegrityEventCount =
          (cameraEventCountBySubmission.get(sourceId) ?? 0) + (cameraEventCountBySubmission.get(comparedId) ?? 0);
        pairRecommendations.push({
          submissionIds: [sourceId, comparedId],
          recommendation: computeSimilarityRecommendation({
            identicalShortAnswerCount: identicalCount,
            highTextSimilarityCount: highTextCount,
            mediumTextSimilarityCount: mediumTextCount,
            sameWrongMcqRisk: mcqPattern.riskLevel,
            cameraIntegrityEventCount,
            hasEvidenceFrame: hasEvidenceFrame.has(sourceId) || hasEvidenceFrame.has(comparedId),
          }),
        });
      }
    }

    // --- Persist: replace previous matches with this run's findings.
    await prisma.$transaction([
      prisma.submissionSimilarityMatch.deleteMany({ where: { analysisId: analysis.id } }),
      ...pendingMatches.map((m) =>
        prisma.submissionSimilarityMatch.create({
          data: {
            analysisId: analysis.id,
            sourceSubmissionId: m.sourceSubmissionId,
            comparedSubmissionId: m.comparedSubmissionId,
            questionId: m.questionId,
            signalType: m.signalType,
            score: m.score,
            matchedDetailJson: { ...m.matchedDetailJson, risk: m.risk },
          },
        }),
      ),
      prisma.submissionSimilarityAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "COMPLETE",
          overallRisk: overallRiskFromMatches(pendingMatches.map((m) => m.risk)),
          analysedAt: new Date(),
          algorithmVersion: SIMILARITY_ALGORITHM_VERSION,
          summaryJson: {
            submissionsAnalysed: submissions.length,
            pairsCompared: pairs.length,
            matchCount: pendingMatches.length,
            pairRecommendations: pairRecommendations.map((p) => ({
              submissionIds: p.submissionIds,
              recommendation: p.recommendation.recommendation,
              reasonCodes: p.recommendation.reasonCodes,
              summary: p.recommendation.summary,
            })),
          },
        },
      }),
    ]);

    return analysis.id;
  } catch (err) {
    // Analysis failure only ever marks the analysis row — it can never
    // affect the submissions themselves (which were finalized long
    // before this ran). Lecturer can retry from the UI.
    await prisma.submissionSimilarityAnalysis
      .update({
        where: { id: analysis.id },
        data: {
          status: "FAILED",
          summaryJson: { error: err instanceof Error ? err.message : "Analysis failed" },
        },
      })
      .catch(() => {});
    throw err;
  }
}
