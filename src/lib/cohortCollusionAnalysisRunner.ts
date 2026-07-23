/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — server-only
 * analysis orchestration. See docs/cohort-collusion-graph-v1.md.
 *
 * Touches Prisma, so it must never be imported from a "use client"
 * component — all pure comparison/clustering logic lives in
 * src/lib/cohortCollusionAnalysis.ts and src/lib/cohortCollusion/*.ts
 * instead; this module only wires data in and out of it. Consumes the
 * pre-existing SubmissionSimilarityMatch, AnswerActivityEvent,
 * ExamAttemptSession, and NetworkEvidence data — never replaces or
 * duplicates those features, and never alters a grade, submission, or
 * existing integrity evidence.
 *
 * v1 runs synchronously inside the lecturer-triggered request, exactly
 * like similarityAnalysisRunner.ts and timingAnalysisRunner.ts — the
 * cohort is hard-capped at MAX_COLLUSION_ANALYSIS_SUBMISSIONS. Analysis
 * failure never affects the submissions/answers themselves: it only
 * marks the analysis row FAILED, and the lecturer can retry.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { normalizeAnswerText } from "@/lib/answerSimilarity";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import {
  COHORT_COLLUSION_ALGORITHM_VERSION,
  CROSS_EXAM_LOOKBACK_MAX_ANALYSES,
} from "@/lib/cohortCollusionThresholds";
import { buildQuestionShingleDocFrequency } from "@/lib/cohortCollusion/answerContent";
import { buildQuestionWrongAnswerFrequency, type CohortAnswerForRarity } from "@/lib/cohortCollusion/rareMistake";
import type { TimedEvent, RelativeTimingPoint } from "@/lib/cohortCollusion/timingSync";
import type { HashedNetworkObservation, HashedSessionSnapshot } from "@/lib/cohortCollusion/sessionNetworkDevice";
import type { PriorExamPairRecord } from "@/lib/cohortCollusion/crossExamRecurrence";
import {
  runCohortCollusionEngine,
  CohortCollusionCohortTooLargeError,
  type CohortCollusionEngineInput,
  type QuestionForAnalysis,
} from "@/lib/cohortCollusionAnalysis";

export { CohortCollusionCohortTooLargeError };

function studentPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Runs (or re-runs) cohort collusion analysis for one exam. Reuses a
 * single CohortCollusionAnalysis row per exam. Edges/signals are fully
 * replaced on every run (they carry no lecturer review state of their
 * own). Clusters are matched by their stable clusterKey: a cluster that
 * still qualifies gets its structural fields refreshed while its
 * reviewStatus/reviewedAt/reviewedById/reviewNote are carried forward
 * untouched; a cluster that no longer qualifies is deleted ONLY if no
 * lecturer has reviewed it yet (still NEEDS_REVIEW) — once reviewed, it
 * is always kept, never silently deleted. Returns the analysis id.
 */
export async function runCohortCollusionAnalysisForExam(examId: string, requestedById: string): Promise<string> {
  const existing = await prisma.cohortCollusionAnalysis.findFirst({ where: { examId }, orderBy: { createdAt: "asc" } });
  const analysis = existing
    ? await prisma.cohortCollusionAnalysis.update({
        where: { id: existing.id },
        data: { status: "PROCESSING", algorithmVersion: COHORT_COLLUSION_ALGORITHM_VERSION, requestedById },
      })
    : await prisma.cohortCollusionAnalysis.create({
        data: { examId, status: "PROCESSING", algorithmVersion: COHORT_COLLUSION_ALGORITHM_VERSION, requestedById },
      });

  try {
    const exam = await prisma.exam.findUniqueOrThrow({
      where: { id: examId },
      select: {
        institutionId: true,
        secureSettings: true,
        questions: { select: { id: true, type: true, text: true, correctAnswer: true }, orderBy: { order: "asc" } },
      },
    });

    const submissions = await prisma.submission.findMany({
      where: { examId, status: { in: ["SUBMITTED", "GRADED"] } },
      select: {
        id: true,
        studentId: true,
        startedAt: true,
        questionOrderJson: true,
        answers: { select: { questionId: true, response: true, isCorrect: true } },
      },
    });

    const settings = parseSecureSettings(exam.secureSettings);
    const poolsActive = questionPoolsActive(settings);
    const allQuestionIds = exam.questions.map((q) => q.id);
    const questionsById = new Map<string, QuestionForAnalysis>(
      exam.questions.map((q) => [q.id, { id: q.id, type: q.type, text: q.text, correctAnswer: q.correctAnswer }]),
    );

    const effectiveQuestionIdsBySubmission = new Map<string, Set<string>>();
    const answersBySubmission = new Map<string, Map<string, { response: string | null; isCorrect: boolean | null }>>();
    for (const s of submissions) {
      effectiveQuestionIdsBySubmission.set(
        s.id,
        new Set(
          resolveEffectiveQuestionIds({
            examQuestionIds: allQuestionIds,
            stored: s.questionOrderJson,
            questionPoolsActive: poolsActive,
          }),
        ),
      );
      answersBySubmission.set(s.id, new Map(s.answers.map((a) => [a.questionId, { response: a.response, isCorrect: a.isCorrect }])));
    }

    // --- Cohort-wide per-question statistics (Part 5 / Part 2.2).
    const answerContentStatsByQuestion = new Map(
      exam.questions
        .filter((q) => q.type !== "MULTIPLE_CHOICE")
        .map((q) => {
          const responses = submissions.map((s) => answersBySubmission.get(s.id)?.get(q.id)?.response ?? null);
          return [q.id, buildQuestionShingleDocFrequency(responses)] as const;
        }),
    );
    const wrongAnswerStatsByQuestion = new Map(
      exam.questions.map((q) => {
        const correct = normalizeAnswerText(q.correctAnswer);
        const answers: CohortAnswerForRarity[] = submissions.map((s) => {
          const a = answersBySubmission.get(s.id)?.get(q.id);
          const normalized = normalizeAnswerText(a?.response);
          const isWrong = a?.isCorrect != null ? a.isCorrect === false : correct.length > 0 ? normalized !== correct : false;
          return { normalizedResponse: normalized, isWrong };
        });
        return [q.id, buildQuestionWrongAnswerFrequency(answers)] as const;
      }),
    );

    // --- Answer activity events (Part 2.4 / Part 4 step 4).
    const activityEvents = await prisma.answerActivityEvent.findMany({
      where: { submissionId: { in: submissions.map((s) => s.id) } },
      select: { submissionId: true, questionId: true, eventType: true, serverReceivedAt: true, responseLengthDelta: true, responseHash: true },
    });
    const activityEventsBySubmission = new Map<string, TimedEvent[]>();
    const mcqEventsBySubmissionQuestion = new Map<string, Map<string, Array<{ serverReceivedAtMs: number; responseHash: string | null }>>>();
    const firstTouchBySubmissionQuestion = new Map<string, Map<string, number>>();

    for (const e of activityEvents) {
      const atMs = e.serverReceivedAt.getTime();
      const list = activityEventsBySubmission.get(e.submissionId) ?? [];
      list.push({ questionId: e.questionId, serverReceivedAtMs: atMs, responseLengthDelta: e.responseLengthDelta });
      activityEventsBySubmission.set(e.submissionId, list);

      if (e.questionId) {
        const question = questionsById.get(e.questionId);
        if (question?.type === "MULTIPLE_CHOICE" && e.eventType === "ANSWER_SAVED") {
          const byQuestion = mcqEventsBySubmissionQuestion.get(e.submissionId) ?? new Map();
          const events = byQuestion.get(e.questionId) ?? [];
          events.push({ serverReceivedAtMs: atMs, responseHash: e.responseHash });
          byQuestion.set(e.questionId, events);
          mcqEventsBySubmissionQuestion.set(e.submissionId, byQuestion);
        }

        const touchMap = firstTouchBySubmissionQuestion.get(e.submissionId) ?? new Map();
        const existingTouch = touchMap.get(e.questionId);
        if (existingTouch == null || atMs < existingTouch) touchMap.set(e.questionId, atMs);
        firstTouchBySubmissionQuestion.set(e.submissionId, touchMap);
      }
    }

    const progressionPointsBySubmission = new Map<string, RelativeTimingPoint[]>();
    for (const s of submissions) {
      const startedAtMs = s.startedAt.getTime();
      const touchMap = firstTouchBySubmissionQuestion.get(s.id) ?? new Map();
      const points: RelativeTimingPoint[] = [...touchMap.entries()].map(([questionId, atMs]) => ({
        questionId,
        relativeElapsedMs: Math.max(0, atMs - startedAtMs),
      }));
      progressionPointsBySubmission.set(s.id, points);
    }

    // --- Session-binding + network evidence (Part 2.5 / Part 4 steps 6-7).
    const sessions = await prisma.examAttemptSession.findMany({
      where: { submissionId: { in: submissions.map((s) => s.id) } },
      select: { submissionId: true, deviceTokenHash: true, firstSeenAt: true, lastSeenAt: true, status: true },
    });
    const sessionsBySubmission = new Map<string, HashedSessionSnapshot[]>();
    for (const s of sessions) {
      const list = sessionsBySubmission.get(s.submissionId) ?? [];
      list.push({ deviceTokenHash: s.deviceTokenHash, firstSeenAtMs: s.firstSeenAt.getTime(), lastSeenAtMs: s.lastSeenAt.getTime(), status: s.status });
      sessionsBySubmission.set(s.submissionId, list);
    }

    const networkEvidence = await prisma.networkEvidence.findMany({
      where: { submissionId: { in: submissions.map((s) => s.id) } },
      select: { submissionId: true, ipHash: true, createdAt: true },
    });
    const networkObservationsBySubmission = new Map<string, HashedNetworkObservation[]>();
    for (const n of networkEvidence) {
      const list = networkObservationsBySubmission.get(n.submissionId) ?? [];
      list.push({ ipPrefixHash: n.ipHash, atMs: n.createdAt.getTime() });
      networkObservationsBySubmission.set(n.submissionId, list);
    }

    // --- Cross-exam recurrence (Part 2.6 / Part 4 step — institution-scoped).
    const priorRecordsByStudentPair = await loadPriorCrossExamRecords(examId, exam.institutionId);

    const engineInput: CohortCollusionEngineInput = {
      submissions: submissions.map((s) => ({ id: s.id, studentId: s.studentId })),
      effectiveQuestionIdsBySubmission,
      questionsById,
      answersBySubmission,
      answerContentStatsByQuestion,
      wrongAnswerStatsByQuestion,
      activityEventsBySubmission,
      progressionPointsBySubmission,
      mcqEventsBySubmissionQuestion,
      networkObservationsBySubmission,
      sessionsBySubmission,
      priorRecordsByStudentPair,
    };

    const result = runCohortCollusionEngine(engineInput);

    await persistAnalysisResult(analysis.id, result);
    return analysis.id;
  } catch (err) {
    // Analysis failure only ever marks the analysis row — it can never
    // affect the submissions/answers themselves. Lecturer can retry.
    await prisma.cohortCollusionAnalysis
      .update({
        where: { id: analysis.id },
        data: {
          status: "FAILED",
          failureCode: err instanceof CohortCollusionCohortTooLargeError ? "COHORT_TOO_LARGE" : "ANALYSIS_ERROR",
          summaryJson: { error: err instanceof Error ? err.message : "Analysis failed" },
        },
      })
      .catch(() => {});
    throw err;
  }
}

async function loadPriorCrossExamRecords(examId: string, institutionId: string | null): Promise<Map<string, PriorExamPairRecord[]>> {
  const priorEdges = await prisma.collusionPairEdge.findMany({
    where: {
      analysis: { examId: { not: examId }, status: "COMPLETE", exam: { institutionId: institutionId ?? undefined } },
    },
    orderBy: { createdAt: "desc" },
    take: CROSS_EXAM_LOOKBACK_MAX_ANALYSES * 10,
    select: {
      analysisId: true,
      sourceSubmissionId: true,
      comparedSubmissionId: true,
      eligibleForClustering: true,
      independentFamilyCount: true,
      analysis: { select: { examId: true } },
      sourceSubmission: { select: { studentId: true } },
      comparedSubmission: { select: { studentId: true } },
    },
  });
  if (priorEdges.length === 0) return new Map();

  const analysisIds = [...new Set(priorEdges.map((e) => e.analysisId))];
  const priorClusterMembers = await prisma.collusionClusterMember.findMany({
    where: { cluster: { analysisId: { in: analysisIds } } },
    select: { clusterId: true, submissionId: true, cluster: { select: { analysisId: true } } },
  });
  const membersByCluster = new Map<string, Set<string>>();
  for (const m of priorClusterMembers) {
    const set = membersByCluster.get(m.clusterId) ?? new Set();
    set.add(m.submissionId);
    membersByCluster.set(m.clusterId, set);
  }
  const clustersByAnalysis = new Map<string, string[]>();
  for (const m of priorClusterMembers) {
    const list = clustersByAnalysis.get(m.cluster.analysisId) ?? [];
    if (!list.includes(m.clusterId)) list.push(m.clusterId);
    clustersByAnalysis.set(m.cluster.analysisId, list);
  }

  const byPair = new Map<string, PriorExamPairRecord[]>();
  for (const edge of priorEdges) {
    const key = studentPairKey(edge.sourceSubmission.studentId, edge.comparedSubmission.studentId);
    const wasInSameCluster = (clustersByAnalysis.get(edge.analysisId) ?? []).some((clusterId) => {
      const members = membersByCluster.get(clusterId);
      return members?.has(edge.sourceSubmissionId) && members?.has(edge.comparedSubmissionId);
    });
    const list = byPair.get(key) ?? [];
    list.push({
      examId: edge.analysis.examId,
      eligibleForClustering: edge.eligibleForClustering,
      independentFamilyCount: edge.independentFamilyCount,
      wasInSameCluster,
    });
    byPair.set(key, list);
  }
  return byPair;
}

async function persistAnalysisResult(analysisId: string, result: ReturnType<typeof runCohortCollusionEngine>): Promise<void> {
  if (result.status === "INSUFFICIENT_DATA") {
    await prisma.$transaction([
      prisma.collusionPairEdge.deleteMany({ where: { analysisId } }),
      prisma.cohortCollusionAnalysis.update({
        where: { id: analysisId },
        data: {
          status: "INSUFFICIENT_DATA",
          analysedAt: new Date(),
          algorithmVersion: result.algorithmVersion,
          submissionCount: result.submissionCount,
          eligibleEdgeCount: 0,
          clusterCount: 0,
          overallReviewLevel: "NONE",
          summaryJson: { note: "Fewer than 3 analysable submissions — insufficient data for cohort-level analysis." },
        },
      }),
    ]);
    return;
  }

  const existingClusters = await prisma.collusionCluster.findMany({ where: { analysisId }, select: { id: true, clusterKey: true, reviewStatus: true } });
  const existingByKey = new Map(existingClusters.map((c) => [c.clusterKey, c]));
  const newKeys = new Set(result.clusters.map((c) => c.clusterKey));

  const clusterKeysToDelete = existingClusters.filter((c) => !newKeys.has(c.clusterKey) && c.reviewStatus === "NEEDS_REVIEW").map((c) => c.id);

  await prisma.$transaction([
    prisma.collusionPairEdge.deleteMany({ where: { analysisId } }),
    ...(clusterKeysToDelete.length > 0 ? [prisma.collusionCluster.deleteMany({ where: { id: { in: clusterKeysToDelete } } })] : []),

    ...result.edges.map((e) =>
      prisma.collusionPairEdge.create({
        data: {
          analysisId,
          sourceSubmissionId: e.sourceSubmissionId,
          comparedSubmissionId: e.comparedSubmissionId,
          combinedScore: e.combinedScore,
          independentFamilyCount: e.independentFamilyCount,
          eligibleForClustering: e.eligibleForClustering,
          familyScoresJson: e.familyScores as Prisma.InputJsonValue,
          summaryJson: { signalCount: e.signals.length } as Prisma.InputJsonValue,
          signals: {
            create: e.signals.map((s) => ({
              signalFamily: s.signalFamily,
              signalType: s.signalType,
              score: s.score,
              confidence: s.confidence,
              explanation: s.explanation,
              evidenceJson: s.evidence as Prisma.InputJsonValue,
            })),
          },
        },
      }),
    ),

    prisma.cohortCollusionAnalysis.update({
      where: { id: analysisId },
      data: {
        status: "COMPLETE",
        analysedAt: new Date(),
        algorithmVersion: result.algorithmVersion,
        submissionCount: result.submissionCount,
        eligibleEdgeCount: result.eligibleEdgeCount,
        clusterCount: result.clusterCount,
        overallReviewLevel: result.overallReviewLevel,
        summaryJson: {
          clusterSummaries: result.clusters.map((c) => ({
            clusterKey: c.clusterKey,
            memberCount: c.memberCount,
            independentFamilyCount: c.independentFamilyCount,
            concernLevel: c.concernLevel,
          })),
        },
      },
    }),
  ]);

  // Clusters are upserted individually (after the transaction above, which
  // needs edges to exist first since CollusionClusterMember.submissionId
  // has no FK dependency on edges, but we still want edges persisted
  // before we reference this run's data in cluster summaries).
  for (const cluster of result.clusters) {
    const existing = existingByKey.get(cluster.clusterKey);
    const summaryJson = {
      topSignalFamilies: [...new Set(cluster.edges.flatMap((e) => Object.keys(e.familyScores)))],
      edgeScores: cluster.edges.map((e) => ({ source: e.sourceSubmissionId, compared: e.comparedSubmissionId, combinedScore: e.combinedScore })),
    } as Prisma.InputJsonValue;

    if (existing) {
      await prisma.$transaction([
        prisma.collusionClusterMember.deleteMany({ where: { clusterId: existing.id } }),
        prisma.collusionCluster.update({
          where: { id: existing.id },
          data: {
            memberCount: cluster.memberCount,
            independentFamilyCount: cluster.independentFamilyCount,
            edgeCount: cluster.edgeCount,
            concernLevel: cluster.concernLevel,
            summaryJson,
            members: { create: cluster.members.map((m) => ({ submissionId: m.submissionId, supportingEdgeCount: m.supportingEdgeCount, independentFamilyCount: m.independentFamilyCount, memberScore: m.memberScore })) },
          },
        }),
      ]);
    } else {
      await prisma.collusionCluster.create({
        data: {
          analysisId,
          clusterKey: cluster.clusterKey,
          memberCount: cluster.memberCount,
          independentFamilyCount: cluster.independentFamilyCount,
          edgeCount: cluster.edgeCount,
          concernLevel: cluster.concernLevel,
          reviewStatus: "NEEDS_REVIEW",
          summaryJson,
          members: { create: cluster.members.map((m) => ({ submissionId: m.submissionId, supportingEdgeCount: m.supportingEdgeCount, independentFamilyCount: m.independentFamilyCount, memberScore: m.memberScore })) },
        },
      });
    }
  }
}
