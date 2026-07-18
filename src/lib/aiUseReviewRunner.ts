/**
 * AI-Use Answer Review v1 — server-only analysis orchestration. See
 * docs/ai-use-answer-review-v1.md.
 *
 * Touches Prisma and the optional Anthropic client, so it must never be
 * imported from a "use client" component — pure comparison logic lives in
 * src/lib/aiUseReview.ts, and this module only wires data in and out of
 * it, mirroring src/lib/similarityAnalysisRunner.ts.
 *
 * v1 runs synchronously inside the lecturer-triggered request (there is
 * no queue/worker in this repo). Layer A (deterministic) always runs and
 * never fails the submission. Layer B (optional AI-assisted) only runs
 * when ANTHROPIC_API_KEY is configured; its failure is recorded but never
 * changes the deterministic results or blocks the analysis from
 * completing.
 */
import { prisma } from "@/lib/prisma";
import {
  AI_USE_REVIEW_ALGORITHM_VERSION,
  calculateAiUseReviewRecommendation,
  overallSignalLevelFromSignals,
  runDeterministicAiUseReviewChecks,
  type AiUseReviewSignalRecord,
  type AnswerForAnalysis,
  type QuestionForAnalysis,
  type RecommendationSignalInput,
} from "@/lib/aiUseReview";
import {
  isAiAssistConfigured,
  runAiUseReviewAssist,
  AI_USE_REVIEW_MODEL_IDENTIFIER,
  type AiUseReviewAssistInputItem,
} from "@/lib/ai/aiUseReviewAssistant";

/** Documented v1 cap for a single synchronous analysis run — see Part 15 (Performance limits). */
export const MAX_ANSWERS_PER_ANALYSIS = 50;

export class AiUseReviewCohortTooLargeError extends Error {
  constructor(count: number) {
    super(
      `This submission has ${count} written answers — above the v1 limit of ${MAX_ANSWERS_PER_ANALYSIS} ` +
        `for a synchronous analysis run. See docs/ai-use-answer-review-v1.md.`,
    );
  }
}

type AiSubStatus = "NOT_CONFIGURED" | "COMPLETE" | "FAILED";

/**
 * Runs (or re-runs) AI-use review analysis for one submission. Reuses a
 * single AiUseReviewAnalysis row per submission (unique constraint) — a
 * re-run replaces the previous signals, mirroring
 * runSimilarityAnalysisForExam's reuse pattern.
 */
export async function runAiUseReviewForSubmission(submissionId: string, requestedById: string): Promise<string> {
  const existing = await prisma.aiUseReviewAnalysis.findUnique({ where: { submissionId } });
  const analysis = existing
    ? await prisma.aiUseReviewAnalysis.update({
        where: { id: existing.id },
        data: { status: "PROCESSING", algorithmVersion: AI_USE_REVIEW_ALGORITHM_VERSION, requestedById },
      })
    : await prisma.aiUseReviewAnalysis.create({
        data: {
          submissionId,
          examId: (await prisma.submission.findUniqueOrThrow({ where: { id: submissionId }, select: { examId: true } })).examId,
          status: "PROCESSING",
          provider: "deterministic",
          algorithmVersion: AI_USE_REVIEW_ALGORITHM_VERSION,
          requestedById,
        },
      });

  try {
    const submission = await prisma.submission.findUniqueOrThrow({
      where: { id: submissionId },
      select: {
        id: true,
        examId: true,
        answers: { select: { id: true, questionId: true, response: true } },
        exam: {
          select: {
            questions: { select: { id: true, type: true, text: true }, orderBy: { order: "asc" } },
          },
        },
      },
    });

    const questions: QuestionForAnalysis[] = submission.exam.questions;
    const answers: AnswerForAnalysis[] = submission.answers;
    const writtenAnswerCount = answers.filter((a) => {
      const q = questions.find((qq) => qq.id === a.questionId);
      return q && q.type !== "MULTIPLE_CHOICE" && (a.response ?? "").trim().length > 0;
    }).length;
    if (writtenAnswerCount > MAX_ANSWERS_PER_ANALYSIS) {
      throw new AiUseReviewCohortTooLargeError(writtenAnswerCount);
    }

    // --- Layer A: deterministic, always runs, never fails the submission.
    const deterministicSignals = runDeterministicAiUseReviewChecks(questions, answers);

    // --- Layer B: optional AI-assisted, only when configured. Failure is
    // recorded but never discards the deterministic results above.
    let aiSubStatus: AiSubStatus = "NOT_CONFIGURED";
    let aiFailureMessage: string | null = null;
    let aiSignals: AiUseReviewSignalRecord[] = [];
    let provider = "deterministic";
    let modelIdentifier: string | null = null;

    if (isAiAssistConfigured()) {
      const questionById = new Map(questions.map((q) => [q.id, q]));
      const items: AiUseReviewAssistInputItem[] = answers
        .filter((a) => {
          const q = questionById.get(a.questionId);
          return q && q.type !== "MULTIPLE_CHOICE" && (a.response ?? "").trim().length > 0;
        })
        .map((a) => ({
          questionId: a.questionId,
          questionText: questionById.get(a.questionId)!.text,
          answerText: a.response ?? "",
        }));

      if (items.length > 0) {
        try {
          const assistResult = await runAiUseReviewAssist({
            anonymousSubmissionRef: submission.id,
            items,
          });
          aiSubStatus = "COMPLETE";
          provider = "deterministic+anthropic";
          modelIdentifier = AI_USE_REVIEW_MODEL_IDENTIFIER;
          aiSignals = assistResult.signals.map((s) => ({
            questionId: s.questionId,
            answerId: answers.find((a) => a.questionId === s.questionId)?.id ?? null,
            signalType: s.type,
            signalLevel: s.level,
            explanation: s.reason,
            evidence: s.evidence,
            limitation: s.limitation,
            reasonCode: "AI_ASSISTED_OBSERVATION",
          }));
        } catch (err) {
          aiSubStatus = "FAILED";
          aiFailureMessage = err instanceof Error ? err.message : "AI-assisted review failed";
        }
      } else {
        aiSubStatus = "COMPLETE";
      }
    }

    const allSignals = [...deterministicSignals, ...aiSignals];

    // --- Corroboration from existing, independent evidence categories —
    // displayed, never merged into a hidden score (Part 9).
    const [highSimilarityMatches, activeOralVerification] = await Promise.all([
      prisma.submissionSimilarityMatch.findMany({
        where: { OR: [{ sourceSubmissionId: submissionId }, { comparedSubmissionId: submissionId }] },
        select: { matchedDetailJson: true },
      }),
      prisma.oralVerification.findFirst({
        where: { submissionId, status: { in: ["REQUIRED", "SCHEDULED"] } },
        select: { id: true },
      }),
    ]);
    const hasHighSimilarity = highSimilarityMatches.some(
      (m) => (m.matchedDetailJson as Record<string, unknown> | null)?.risk === "HIGH",
    );
    const existingHighSimilarityOrIntegritySignal = hasHighSimilarity || Boolean(activeOralVerification);

    const recommendationInput: RecommendationSignalInput[] = allSignals.map((s) => ({
      signalType: s.signalType,
      signalLevel: s.signalLevel,
    }));
    const recommendation = calculateAiUseReviewRecommendation(recommendationInput, {
      existingHighSimilarityOrIntegritySignal,
    });

    await prisma.$transaction([
      prisma.aiUseReviewSignal.deleteMany({ where: { analysisId: analysis.id } }),
      ...allSignals.map((s) =>
        prisma.aiUseReviewSignal.create({
          data: {
            analysisId: analysis.id,
            questionId: s.questionId,
            answerId: s.answerId,
            signalType: s.signalType,
            signalLevel: s.signalLevel,
            explanation: s.explanation,
            evidenceJson: s.evidence,
          },
        }),
      ),
      prisma.aiUseReviewAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "COMPLETE",
          overallSignalLevel: overallSignalLevelFromSignals(allSignals),
          provider,
          modelIdentifier,
          analysedAt: new Date(),
          algorithmVersion: AI_USE_REVIEW_ALGORITHM_VERSION,
          failureCode: aiSubStatus === "FAILED" ? "AI_ASSISTED_STEP_FAILED" : null,
          recommendation: recommendation.recommendation,
          reasonCodesJson: recommendation.reasonCodes,
          summaryJson: {
            writtenAnswersAnalysed: writtenAnswerCount,
            deterministicSignalCount: deterministicSignals.length,
            aiAssistedSignalCount: aiSignals.length,
            aiAssisted: {
              status: aiSubStatus,
              message:
                aiSubStatus === "NOT_CONFIGURED"
                  ? "AI-assisted review is not configured."
                  : aiSubStatus === "FAILED"
                    ? aiFailureMessage
                    : null,
            },
            recommendationSummary: recommendation.summary,
          },
        },
      }),
    ]);

    return analysis.id;
  } catch (err) {
    // Analysis failure only ever marks the analysis row — it can never
    // affect the submission or its grade. Lecturer can retry.
    await prisma.aiUseReviewAnalysis
      .update({
        where: { id: analysis.id },
        data: {
          status: "FAILED",
          failureCode: "ANALYSIS_FAILED",
          summaryJson: { error: err instanceof Error ? err.message : "Analysis failed" },
        },
      })
      .catch(() => {});
    throw err;
  }
}
