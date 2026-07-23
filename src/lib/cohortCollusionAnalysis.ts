/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — pure
 * analysis engine. See docs/cohort-collusion-graph-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no LLM, no
 * network — mirrors the split between src/lib/answerSimilarity.ts (pure
 * engine) and src/lib/similarityAnalysisRunner.ts (server orchestration).
 * All Prisma loading, cohort-statistics precomputation, and persistence
 * lives in src/lib/cohortCollusionAnalysisRunner.ts, which calls
 * runCohortCollusionEngine() with plain data and writes the result.
 *
 * THIS PRODUCES REVIEW SIGNALS ONLY: "possible coordinated-answer
 * cluster", "supporting signals", "needs lecturer review" — never
 * "confirmed collusion" or "students cheated". See
 * docs/cohort-collusion-graph-v1.md for the full neutral-wording
 * convention and src/lib/cohortCollusion/graph.ts for the independent-
 * family safety rules this engine enforces.
 */
import { buildComparablePairs } from "@/lib/answerSimilarity";
import { COHORT_COLLUSION_ALGORITHM_VERSION, MAX_COLLUSION_ANALYSIS_SUBMISSIONS } from "@/lib/cohortCollusionThresholds";
import {
  buildPairEdge,
  buildClusters,
  computeClusterMembers,
  clusterKeyForMembers,
  overallReviewLevelFromClusters,
  type PairEdgeResult,
  type ClusterCandidate,
  type ClusterMemberResult,
  type ConcernLevel,
  type AnalysisStatus,
} from "@/lib/cohortCollusion/graph";
import type { PairSignal } from "@/lib/cohortCollusion/types";
import { computeAnswerContentSignals, type QuestionShingleDocFrequency } from "@/lib/cohortCollusion/answerContent";
import { computeRareMistakeSignals, type QuestionWrongAnswerFrequency } from "@/lib/cohortCollusion/rareMistake";
import {
  computeMcqSequenceSignals,
  computeSynchronisedMcqChangeSignal,
  type McqSharedQuestion,
  type McqChangeInput,
} from "@/lib/cohortCollusion/mcqPattern";
import { computeTimingSynchronisationSignals, type TimedEvent, type RelativeTimingPoint } from "@/lib/cohortCollusion/timingSync";
import {
  computeSessionNetworkDeviceSignals,
  type HashedNetworkObservation,
  type HashedSessionSnapshot,
} from "@/lib/cohortCollusion/sessionNetworkDevice";
import { computeCrossExamRecurrenceSignals, type PriorExamPairRecord } from "@/lib/cohortCollusion/crossExamRecurrence";

export {
  ANALYSIS_STATUSES,
  CONCERN_LEVELS,
  CONCERN_LEVEL_LABELS,
  CLUSTER_REVIEW_STATUSES,
  CLUSTER_REVIEW_STATUS_LABELS,
  isValidClusterReviewStatus,
} from "@/lib/cohortCollusion/graph";
export type { AnalysisStatus, ConcernLevel, ClusterReviewStatus } from "@/lib/cohortCollusion/graph";
export { SIGNAL_FAMILIES, isValidSignalFamily } from "@/lib/cohortCollusionThresholds";
export type { SignalFamily } from "@/lib/cohortCollusionThresholds";

export class CohortCollusionCohortTooLargeError extends Error {
  constructor(count: number) {
    super(
      `This exam has ${count} analysable submissions — above the v1 limit of ${MAX_COLLUSION_ANALYSIS_SUBMISSIONS} ` +
        `for a synchronous analysis run. See docs/cohort-collusion-graph-v1.md.`,
    );
  }
}

export type SubmissionForAnalysis = { id: string; studentId: string };

export type QuestionForAnalysis = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  correctAnswer: string | null;
  starterCodeOrTemplate?: string | null;
};

export type AnswerForAnalysis = {
  response: string | null;
  isCorrect: boolean | null;
};

export type CohortCollusionEngineInput = {
  submissions: SubmissionForAnalysis[];
  /** The set of Question.id each submission was actually given (respects question pools) — mirrors similarityAnalysisRunner.ts. */
  effectiveQuestionIdsBySubmission: Map<string, Set<string>>;
  questionsById: Map<string, QuestionForAnalysis>;
  answersBySubmission: Map<string, Map<string, AnswerForAnalysis>>;

  answerContentStatsByQuestion: Map<string, QuestionShingleDocFrequency>;
  wrongAnswerStatsByQuestion: Map<string, QuestionWrongAnswerFrequency>;

  activityEventsBySubmission: Map<string, TimedEvent[]>;
  progressionPointsBySubmission: Map<string, RelativeTimingPoint[]>;
  mcqEventsBySubmissionQuestion: Map<string, Map<string, McqChangeInput["eventsA"]>>;

  networkObservationsBySubmission: Map<string, HashedNetworkObservation[]>;
  sessionsBySubmission: Map<string, HashedSessionSnapshot[]>;

  /** Keyed by canonical `${studentIdA}|${studentIdB}` (sorted) pair. */
  priorRecordsByStudentPair: Map<string, PriorExamPairRecord[]>;
};

export type CohortCollusionEngineResult = {
  status: AnalysisStatus;
  algorithmVersion: string;
  submissionCount: number;
  eligibleEdgeCount: number;
  clusterCount: number;
  overallReviewLevel: ConcernLevel;
  edges: PairEdgeResult[];
  clusters: Array<{
    clusterKey: string;
    memberCount: number;
    independentFamilyCount: number;
    edgeCount: number;
    concernLevel: ConcernLevel;
    members: ClusterMemberResult[];
    edges: PairEdgeResult[];
  }>;
};

function studentPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Collects every ANSWER_CONTENT + RARE_MISTAKE signal across all shared questions between one pair. */
function collectPerQuestionSignals(
  sourceId: string,
  comparedId: string,
  sharedQuestionIds: string[],
  input: CohortCollusionEngineInput,
): PairSignal[] {
  const signals: PairSignal[] = [];
  const answersA = input.answersBySubmission.get(sourceId);
  const answersB = input.answersBySubmission.get(comparedId);

  for (const questionId of sharedQuestionIds) {
    const question = input.questionsById.get(questionId);
    if (!question) continue;
    const a = answersA?.get(questionId);
    const b = answersB?.get(questionId);

    if (question.type !== "MULTIPLE_CHOICE") {
      const stats = input.answerContentStatsByQuestion.get(questionId);
      if (stats) {
        signals.push(
          ...computeAnswerContentSignals(
            {
              responseA: a?.response,
              responseB: b?.response,
              questionText: question.text,
              starterCodeOrTemplate: question.starterCodeOrTemplate,
            },
            stats,
          ),
        );
      }
    }

    const wrongStats = input.wrongAnswerStatsByQuestion.get(questionId);
    if (wrongStats) {
      signals.push(
        ...computeRareMistakeSignals(
          {
            questionId,
            questionType: question.type,
            responseA: a?.response,
            responseB: b?.response,
            correctAnswer: question.correctAnswer,
            isCorrectA: a?.isCorrect,
            isCorrectB: b?.isCorrect,
          },
          wrongStats,
        ),
      );
    }
  }
  return signals;
}

function collectMcqPatternSignals(
  sourceId: string,
  comparedId: string,
  sharedMcqQuestionIds: string[],
  input: CohortCollusionEngineInput,
): PairSignal[] {
  const answersA = input.answersBySubmission.get(sourceId);
  const answersB = input.answersBySubmission.get(comparedId);
  const shared: McqSharedQuestion[] = [];
  const changeInputs: McqChangeInput[] = [];

  for (const questionId of sharedMcqQuestionIds) {
    const question = input.questionsById.get(questionId);
    const wrongStats = input.wrongAnswerStatsByQuestion.get(questionId);
    if (!question || !wrongStats) continue;
    const a = answersA?.get(questionId);
    const b = answersB?.get(questionId);
    shared.push({ questionId, responseA: a?.response ?? null, responseB: b?.response ?? null, correctAnswer: question.correctAnswer, wrongAnswerStats: wrongStats });

    const eventsA = input.mcqEventsBySubmissionQuestion.get(sourceId)?.get(questionId) ?? [];
    const eventsB = input.mcqEventsBySubmissionQuestion.get(comparedId)?.get(questionId) ?? [];
    changeInputs.push({
      questionId,
      eventsA,
      eventsB,
      finalResponseA: a?.response ?? null,
      finalResponseB: b?.response ?? null,
      correctAnswer: question.correctAnswer,
      wrongAnswerStats: wrongStats,
    });
  }

  return [...computeMcqSequenceSignals(shared), ...computeSynchronisedMcqChangeSignal(changeInputs)];
}

/** Runs the full deterministic engine over a fully-loaded, plain-data input. Never touches Prisma, never mutates anything — the runner owns persistence. */
export function runCohortCollusionEngine(input: CohortCollusionEngineInput): CohortCollusionEngineResult {
  if (input.submissions.length > MAX_COLLUSION_ANALYSIS_SUBMISSIONS) {
    throw new CohortCollusionCohortTooLargeError(input.submissions.length);
  }

  if (input.submissions.length < 3) {
    return {
      status: "INSUFFICIENT_DATA",
      algorithmVersion: COHORT_COLLUSION_ALGORITHM_VERSION,
      submissionCount: input.submissions.length,
      eligibleEdgeCount: 0,
      clusterCount: 0,
      overallReviewLevel: "NONE",
      edges: [],
      clusters: [],
    };
  }

  const pairs = buildComparablePairs(input.submissions);
  const edges: PairEdgeResult[] = [];

  for (const [sourceId, comparedId] of pairs) {
    const sourceQuestionIds = input.effectiveQuestionIdsBySubmission.get(sourceId) ?? new Set<string>();
    const comparedQuestionIds = input.effectiveQuestionIdsBySubmission.get(comparedId) ?? new Set<string>();
    const sharedQuestionIds = [...sourceQuestionIds].filter((qid) => comparedQuestionIds.has(qid));
    const sharedMcqQuestionIds = sharedQuestionIds.filter((qid) => input.questionsById.get(qid)?.type === "MULTIPLE_CHOICE");

    const source = input.submissions.find((s) => s.id === sourceId)!;
    const compared = input.submissions.find((s) => s.id === comparedId)!;

    const signals: PairSignal[] = [
      ...collectPerQuestionSignals(sourceId, comparedId, sharedQuestionIds, input),
      ...collectMcqPatternSignals(sourceId, comparedId, sharedMcqQuestionIds, input),
      ...computeTimingSynchronisationSignals(
        input.activityEventsBySubmission.get(sourceId) ?? [],
        input.activityEventsBySubmission.get(comparedId) ?? [],
        input.progressionPointsBySubmission.get(sourceId) ?? [],
        input.progressionPointsBySubmission.get(comparedId) ?? [],
      ),
      ...computeSessionNetworkDeviceSignals(
        input.networkObservationsBySubmission.get(sourceId) ?? [],
        input.networkObservationsBySubmission.get(comparedId) ?? [],
        input.sessionsBySubmission.get(sourceId) ?? [],
        input.sessionsBySubmission.get(comparedId) ?? [],
      ),
      ...computeCrossExamRecurrenceSignals(input.priorRecordsByStudentPair.get(studentPairKey(source.studentId, compared.studentId)) ?? []),
    ];

    const edge = buildPairEdge(sourceId, comparedId, signals);
    if (edge) edges.push(edge);
  }

  const clusterCandidates = buildClusters(edges);
  const clusters = clusterCandidates.map((c: ClusterCandidate) => ({
    clusterKey: clusterKeyForMembers(c.memberSubmissionIds),
    memberCount: c.memberSubmissionIds.length,
    independentFamilyCount: c.independentFamilyCount,
    edgeCount: c.edges.length,
    concernLevel: c.concernLevel,
    members: computeClusterMembers(c),
    edges: c.edges,
  }));

  return {
    status: "COMPLETE",
    algorithmVersion: COHORT_COLLUSION_ALGORITHM_VERSION,
    submissionCount: input.submissions.length,
    eligibleEdgeCount: edges.filter((e) => e.eligibleForClustering).length,
    clusterCount: clusters.length,
    overallReviewLevel: overallReviewLevelFromClusters(clusterCandidates),
    edges,
    clusters,
  };
}
