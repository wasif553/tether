/**
 * Time Anomaly Review v1 — server-only analysis orchestration. See
 * docs/time-anomaly-review-v1.md.
 *
 * Touches Prisma, so it must never be imported from a "use client"
 * component — pure timing logic lives in src/lib/timeAnomalyDetection.ts,
 * and this module only wires data in and out of it (mirrors
 * src/lib/similarityAnalysisRunner.ts / src/lib/aiUseReviewRunner.ts).
 *
 * Also computes the Part 12 COMBINED recommendation (session + timing +
 * existing similarity + existing AI-use-review signals) and stores it on
 * the same TimingAnalysis row, since this is the only lecturer-triggered
 * analysis route in this feature — session-review has no POST trigger of
 * its own (session signals accumulate continuously from heartbeats).
 */
import { prisma } from "@/lib/prisma";
import {
  TIME_ANOMALY_ALGORITHM_VERSION,
  runTimeAnomalyAnalysis,
  analyzeSimilarResponseTimingPattern,
  type ActivityEventForAnalysis,
  type TimingSignalRecord,
  type RelativeTimingPoint,
} from "@/lib/timeAnomalyDetection";
import { calculateCombinedReviewRecommendation, type CombinedSignalInput } from "@/lib/combinedReviewRecommendation";
import type { SignalLevel as SessionSignalLevel } from "@/lib/sessionIntegrity";

/** Documented v1 cohort cap for the cross-submission timing-similarity comparison — mirrors MAX_ANALYSIS_SUBMISSIONS in similarityAnalysisRunner.ts. */
export const MAX_TIMING_COHORT_SUBMISSIONS = 100;

export class TimingCohortTooLargeError extends Error {
  constructor(count: number) {
    super(
      `This exam has ${count} analysable submissions — above the v1 limit of ${MAX_TIMING_COHORT_SUBMISSIONS} ` +
        `for a synchronous cohort timing comparison. See docs/time-anomaly-review-v1.md.`,
    );
  }
}

function overallLevelFromSignals(signals: Array<{ signalLevel: SessionSignalLevel }>): "NONE" | "LOW" | "MEDIUM" | "HIGH" {
  if (signals.some((s) => s.signalLevel === "HIGH")) return "HIGH";
  if (signals.some((s) => s.signalLevel === "MEDIUM")) return "MEDIUM";
  if (signals.some((s) => s.signalLevel === "LOW")) return "LOW";
  return "NONE";
}

/** Builds relative-from-attempt-start timing points, keyed by actual Question.id — never by display position. Uses the LAST saved timestamp per question as its "committed" time. */
function buildRelativeTimingPoints(startedAtMs: number, events: Array<{ questionId: string | null; serverReceivedAt: Date }>): RelativeTimingPoint[] {
  const lastByQuestion = new Map<string, number>();
  for (const e of events) {
    if (!e.questionId) continue;
    const relativeMs = e.serverReceivedAt.getTime() - startedAtMs;
    const existing = lastByQuestion.get(e.questionId);
    if (existing === undefined || relativeMs > existing) lastByQuestion.set(e.questionId, relativeMs);
  }
  return [...lastByQuestion.entries()].map(([questionId, relativeElapsedMs]) => ({ questionId, relativeElapsedMs }));
}

/**
 * Runs (or re-runs) timing analysis for one submission. Reuses a single
 * TimingAnalysis row per submission (unique constraint) — a re-run
 * replaces the previous signals.
 */
export async function runTimingAnalysisForSubmission(submissionId: string, requestedById: string): Promise<string> {
  const existing = await prisma.timingAnalysis.findUnique({ where: { submissionId } });
  const analysis = existing
    ? await prisma.timingAnalysis.update({
        where: { id: existing.id },
        data: { status: "PROCESSING", algorithmVersion: TIME_ANOMALY_ALGORITHM_VERSION, requestedById },
      })
    : await prisma.timingAnalysis.create({
        data: {
          submissionId,
          examId: (await prisma.submission.findUniqueOrThrow({ where: { id: submissionId }, select: { examId: true } })).examId,
          status: "PROCESSING",
          algorithmVersion: TIME_ANOMALY_ALGORITHM_VERSION,
          requestedById,
        },
      });

  try {
    const submission = await prisma.submission.findUniqueOrThrow({
      where: { id: submissionId },
      select: {
        id: true,
        examId: true,
        startedAt: true,
        submittedAt: true,
        answers: { select: { questionId: true, response: true } },
        answerActivityEvents: {
          select: { eventType: true, questionId: true, serverReceivedAt: true, responseLength: true, responseLengthDelta: true },
        },
      },
    });

    const activityEvents: ActivityEventForAnalysis[] = submission.answerActivityEvents.map((e) => ({
      eventType: e.eventType as ActivityEventForAnalysis["eventType"],
      questionId: e.questionId,
      serverReceivedAtMs: e.serverReceivedAt.getTime(),
      responseLength: e.responseLength,
      responseLengthDelta: e.responseLengthDelta,
    }));
    const answeredQuestionCount = submission.answers.filter((a) => (a.response ?? "").trim().length > 0).length;

    // --- Single-submission signals (Part 10.1-10.4, burst).
    const timingResults: TimingSignalRecord[] = runTimeAnomalyAnalysis({
      lifecycle: { startedAtMs: submission.startedAt.getTime(), submittedAtMs: submission.submittedAt?.getTime() ?? null },
      answeredQuestionCount,
      activityEvents,
      // Never populated in v1 — this repo's Question model has no
      // difficulty field and no cohort-difficulty estimation exists. See
      // docs/time-anomaly-review-v1.md ("Signals deliberately omitted").
    });

    // --- Cross-submission timing-similarity comparison (Part 10.6),
    // bounded exactly like answer similarity's cohort cap.
    const cohort = await prisma.submission.findMany({
      where: { examId: submission.examId, status: { in: ["SUBMITTED", "GRADED"] }, id: { not: submissionId } },
      select: {
        id: true,
        startedAt: true,
        answerActivityEvents: { select: { questionId: true, serverReceivedAt: true, eventType: true } },
      },
    });
    if (cohort.length > MAX_TIMING_COHORT_SUBMISSIONS) {
      throw new TimingCohortTooLargeError(cohort.length);
    }
    const thisTimingPoints = buildRelativeTimingPoints(
      submission.startedAt.getTime(),
      activityEvents
        .filter((e) => e.eventType === "ANSWER_SAVED")
        .map((e) => ({ questionId: e.questionId, serverReceivedAt: new Date(e.serverReceivedAtMs) })),
    );
    let bestSimilarTiming: TimingSignalRecord | null = null;
    for (const other of cohort) {
      const otherEvents = other.answerActivityEvents.filter((e) => e.eventType === "ANSWER_SAVED");
      const otherTimingPoints = buildRelativeTimingPoints(other.startedAt.getTime(), otherEvents);
      const result = analyzeSimilarResponseTimingPattern(thisTimingPoints, otherTimingPoints);
      if (result && (!bestSimilarTiming || result.signalLevel === "MEDIUM")) bestSimilarTiming = result;
    }
    if (bestSimilarTiming) timingResults.push(bestSimilarTiming);

    // --- Existing, independent evidence categories for the combined
    // recommendation (Part 9/12) — displayed/used, never merged into a
    // hidden score.
    const [sessionSignals, similarityAnalysis, aiUseReviewAnalysis, cameraEventCount] = await Promise.all([
      prisma.sessionIntegritySignal.findMany({ where: { submissionId }, select: { signalType: true, signalLevel: true } }),
      prisma.submissionSimilarityMatch.findMany({
        where: { OR: [{ sourceSubmissionId: submissionId }, { comparedSubmissionId: submissionId }] },
        select: { matchedDetailJson: true },
      }),
      prisma.aiUseReviewAnalysis.findUnique({ where: { submissionId }, select: { recommendation: true } }),
      prisma.integrityEvent.count({
        where: { submissionId, eventType: { in: ["POSSIBLE_PHONE_VISIBLE", "POSSIBLE_SECOND_PERSON_VISIBLE"] } },
      }),
    ]);
    const hasHighSimilarity = similarityAnalysis.some((m) => (m.matchedDetailJson as Record<string, unknown> | null)?.risk === "HIGH");

    const combinedInputSignals: CombinedSignalInput[] = [
      ...sessionSignals.map((s) => ({ category: "SESSION" as const, signalType: s.signalType, signalLevel: s.signalLevel as SessionSignalLevel })),
      ...timingResults
        .filter((s) => s.signalType !== "INSUFFICIENT_TIMING_DATA")
        .map((s) => ({ category: "TIMING" as const, signalType: s.signalType, signalLevel: s.signalLevel })),
    ];
    const combined = calculateCombinedReviewRecommendation(combinedInputSignals, {
      similarityRecommendation: hasHighSimilarity ? "ORAL_VERIFICATION_RECOMMENDED" : undefined,
      aiUseReviewRecommendation: aiUseReviewAnalysis?.recommendation as
        | "NO_IMMEDIATE_ACTION"
        | "LECTURER_REVIEW_RECOMMENDED"
        | "ORAL_VERIFICATION_RECOMMENDED"
        | undefined,
      cameraIntegrityEventCount: cameraEventCount,
    });

    await prisma.$transaction([
      prisma.timingIntegritySignal.deleteMany({ where: { analysisId: analysis.id } }),
      ...timingResults.map((s) =>
        prisma.timingIntegritySignal.create({
          data: {
            analysisId: analysis.id,
            signalType: s.signalType,
            signalLevel: s.signalLevel,
            explanation: s.explanation,
            evidenceJson: s.evidence,
          },
        }),
      ),
      prisma.timingAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "COMPLETE",
          overallSignalLevel: overallLevelFromSignals(timingResults.filter((s) => s.signalType !== "INSUFFICIENT_TIMING_DATA")),
          analysedAt: new Date(),
          algorithmVersion: TIME_ANOMALY_ALGORITHM_VERSION,
          recommendation: combined.recommendation,
          reasonCodesJson: combined.reasonCodes,
          summaryJson: {
            answeredQuestionCount,
            activityEventCount: activityEvents.length,
            cohortSubmissionsCompared: cohort.length,
            combinedRecommendationSummary: combined.summary,
          },
        },
      }),
    ]);

    return analysis.id;
  } catch (err) {
    await prisma.timingAnalysis
      .update({
        where: { id: analysis.id },
        data: { status: "FAILED", summaryJson: { error: err instanceof Error ? err.message : "Analysis failed" } },
      })
      .catch(() => {});
    throw err;
  }
}
