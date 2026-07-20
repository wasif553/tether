/**
 * Controlled AI Brainstorming Assistance v1 — server orchestration. See
 * docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Server-only (Prisma + Anthropic). The ONLY place that composes the
 * classifier (src/lib/aiAssistanceClassifier.ts), generator
 * (src/lib/aiAssistanceGenerator.ts) and verifier
 * (src/lib/aiAssistanceVerifier.ts) — a generator candidate is NEVER
 * returned to a caller of this module without first passing the
 * verifier, and a REJECTED candidate's text is NEVER persisted or
 * returned, on any code path.
 */
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, questionPoolsActive, severityFor } from "@/lib/secureExam";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import {
  parseAiAssistancePolicy,
  isAiAssistanceEnabled,
  hasReachedQuestionPromptLimit,
  hasReachedAttemptPromptLimit,
  isStudentPromptLengthValid,
  isWithinRateLimit,
  hintLadderLevelForApprovedCount,
  nextCumulativeRiskScore,
  isCumulativeHintLeakageRisk,
  AI_ASSISTANCE_FALLBACK_RESPONSE,
  type AiAssistancePolicy,
  type AiAssistanceInteractionStatus,
} from "@/lib/aiAssistancePolicy";
import { classifyStudentRequest, blockedRequestStudentMessage } from "@/lib/aiAssistanceClassifier";
import {
  generateBrainstormResponse,
  type BrainstormGeneratorInput,
  type BrainstormQuestionType,
} from "@/lib/aiAssistanceGenerator";
import { verifyBrainstormResponse, type RiskCode } from "@/lib/aiAssistanceVerifier";

export class AiAssistanceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Load + validate (Part 5)
// ---------------------------------------------------------------------------

async function loadValidatedContext(submissionId: string, studentId: string, questionId: string) {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: { exam: { include: { questions: { orderBy: { order: "asc" } } } } },
  });
  if (!submission || submission.studentId !== studentId) {
    throw new AiAssistanceError(404, "Not found");
  }
  if (submission.status !== "IN_PROGRESS") {
    throw new AiAssistanceError(409, "This submission is no longer active");
  }

  const settings = parseSecureSettings(submission.exam.secureSettings);
  const orderedIds = resolveEffectiveQuestionIds({
    examQuestionIds: submission.exam.questions.map((q) => q.id),
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });
  const questionIndex = orderedIds.indexOf(questionId);
  if (questionIndex === -1) {
    throw new AiAssistanceError(404, "This question is not part of your attempt");
  }
  // "Currently accessible" (Part 5) — under one-question-at-a-time
  // delivery, assistance is only available for a question the student
  // has actually reached, never one still ahead of their current
  // position. Outside one-question mode, every question in the stable
  // set is already accessible (matches the existing full-paper delivery
  // model), so no further restriction applies.
  if (settings.oneQuestionAtATime && questionIndex > submission.currentQuestionIndex) {
    throw new AiAssistanceError(403, "This question is not yet available in your attempt");
  }

  const question = submission.exam.questions.find((q) => q.id === questionId);
  if (!question) throw new AiAssistanceError(404, "Not found");

  const policy = parseAiAssistancePolicy(submission.aiAssistancePolicySnapshotJson);
  if (!isAiAssistanceEnabled(policy)) {
    throw new AiAssistanceError(403, "AI brainstorming assistance is not enabled for this exam");
  }

  return { submission, question, policy, settings };
}

// ---------------------------------------------------------------------------
// Result shape returned to the API route
// ---------------------------------------------------------------------------

export type AiAssistanceRunResult = {
  status: AiAssistanceInteractionStatus;
  response: string | null;
  studentMessage: string | null;
  promptsRemainingForQuestion: number;
  promptsRemainingForAttempt: number;
};

/**
 * The single entry point: validates, rate-limits, classifies, and — only
 * for an allowed request — runs generate -> verify -> (regenerate once ->
 * verify) -> fallback, then persists exactly one AiAssistanceInteraction
 * row and one neutral IntegrityEvent. Throws AiAssistanceError for every
 * validation/limit failure (the API route maps `.status` directly to the
 * HTTP response).
 */
export async function runAiAssistanceRequest(params: {
  submissionId: string;
  studentId: string;
  questionId: string;
  studentPrompt: string;
  studentCurrentReasoning?: string | null;
}): Promise<AiAssistanceRunResult> {
  const { submission, question, policy, settings } = await loadValidatedContext(
    params.submissionId,
    params.studentId,
    params.questionId,
  );

  if (!isStudentPromptLengthValid(params.studentPrompt)) {
    throw new AiAssistanceError(400, "Your message is empty or too long. Please shorten it and try again.");
  }

  const [promptsForQuestion, promptsForAttempt, recentInteractions] = await Promise.all([
    prisma.aiAssistanceInteraction.count({ where: { submissionId: submission.id, questionId: question.id } }),
    prisma.aiAssistanceInteraction.count({ where: { submissionId: submission.id } }),
    prisma.aiAssistanceInteraction.findMany({
      where: { submissionId: submission.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { createdAt: true },
    }),
  ]);

  if (!isWithinRateLimit(recentInteractions.map((r) => r.createdAt.getTime()), Date.now())) {
    throw new AiAssistanceError(429, "You're sending requests too quickly. Please wait a moment and try again.");
  }

  if (hasReachedQuestionPromptLimit(promptsForQuestion, policy) || hasReachedAttemptPromptLimit(promptsForAttempt, policy)) {
    await recordLimitReached(submission.id, submission.examId, submission.studentId, settings);
    return {
      status: "BLOCKED",
      response: null,
      studentMessage: hasReachedAttemptPromptLimit(promptsForAttempt, policy)
        ? "You've used all the assistance prompts available for this attempt."
        : "You've used all the assistance prompts available for this question.",
      promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptsForQuestion),
      promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptsForAttempt),
    };
  }

  const promptNumberForQuestion = promptsForQuestion + 1;
  const promptNumberForAttempt = promptsForAttempt + 1;

  const classification = classifyStudentRequest(params.studentPrompt);
  if (!classification.allowed) {
    await persistInteraction({
      submission,
      question,
      policy,
      promptNumberForQuestion,
      promptNumberForAttempt,
      studentPrompt: params.studentPrompt,
      status: "BLOCKED",
      approvedResponse: null,
      riskCodes: classification.blockReasonCodes,
      riskScore: 0,
      cumulativeRiskScore: await currentCumulativeRiskScore(submission.id, question.id),
      specificityLevel: 0,
      providerModel: null,
      latencyMs: null,
      settings,
      eventType: "AI_ASSISTANCE_REQUEST_BLOCKED",
    });
    return {
      status: "BLOCKED",
      response: null,
      studentMessage: blockedRequestStudentMessage(classification.blockReasonCodes),
      promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptNumberForQuestion),
      promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptNumberForAttempt),
    };
  }

  const approvedCountForQuestion = await prisma.aiAssistanceInteraction.count({
    where: {
      submissionId: submission.id,
      questionId: question.id,
      status: { in: ["APPROVED", "REGENERATED_APPROVED"] },
    },
  });
  const cumulativeSoFar = await currentCumulativeRiskScore(submission.id, question.id);
  const priorApproved = await prisma.aiAssistanceInteraction.findMany({
    where: {
      submissionId: submission.id,
      questionId: question.id,
      status: { in: ["APPROVED", "REGENERATED_APPROVED"] },
    },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { studentPrompt: true, approvedResponse: true },
  });

  const questionType = question.type as BrainstormQuestionType;
  const generatorInput: BrainstormGeneratorInput = {
    questionText: question.text,
    questionType,
    policy: {
      allowConceptExplanations: policy.allowConceptExplanations,
      allowAnswerPlanning: policy.allowAnswerPlanning,
      allowReasoningFeedback: policy.allowReasoningFeedback,
      allowProgrammingConceptHelp: policy.allowProgrammingConceptHelp,
      maxResponseCharacters: policy.maxResponseCharacters,
    },
    studentRequest: params.studentPrompt,
    priorApprovedInteractions: priorApproved.map((p) => ({
      studentPrompt: p.studentPrompt,
      approvedResponse: p.approvedResponse ?? "",
    })),
    studentCurrentReasoning: policy.allowReasoningFeedback ? (params.studentCurrentReasoning ?? null) : null,
    hintLadderLevel: hintLadderLevelForApprovedCount(approvedCountForQuestion),
  };

  const startedAt = Date.now();
  const attempt1 = await attemptGenerateAndVerify({
    generatorInput,
    question,
    studentPrompt: params.studentPrompt,
    approvedCountForQuestion,
    cumulativeSoFar,
  });

  let final = attempt1;
  let regenerated = false;
  if (!final.ok) {
    const attempt2 = await attemptGenerateAndVerify({
      generatorInput: { ...generatorInput, stricter: true },
      question,
      studentPrompt: params.studentPrompt,
      approvedCountForQuestion,
      cumulativeSoFar,
    });
    regenerated = true;
    final = attempt2;
  }
  const latencyMs = Date.now() - startedAt;

  if (final.ok) {
    const newCumulative = nextCumulativeRiskScore(cumulativeSoFar, final.riskScore);
    await persistInteraction({
      submission,
      question,
      policy,
      promptNumberForQuestion,
      promptNumberForAttempt,
      studentPrompt: params.studentPrompt,
      status: regenerated ? "REGENERATED_APPROVED" : "APPROVED",
      approvedResponse: final.response,
      riskCodes: final.riskCodes,
      riskScore: final.riskScore,
      cumulativeRiskScore: newCumulative,
      specificityLevel: generatorInput.hintLadderLevel,
      providerModel: "anthropic:claude-sonnet-4-6",
      latencyMs,
      settings,
      eventType: regenerated ? "AI_ASSISTANCE_RESPONSE_REGENERATED" : "AI_ASSISTANCE_USED",
    });
    return {
      status: regenerated ? "REGENERATED_APPROVED" : "APPROVED",
      response: final.response,
      studentMessage: null,
      promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptNumberForQuestion),
      promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptNumberForAttempt),
    };
  }

  // Both attempts failed verification (Part 9) — deterministic safe
  // fallback. The rejected candidate text (from either attempt) is
  // discarded here and NEVER persisted or returned.
  await persistInteraction({
    submission,
    question,
    policy,
    promptNumberForQuestion,
    promptNumberForAttempt,
    studentPrompt: params.studentPrompt,
    status: "FALLBACK",
    approvedResponse: AI_ASSISTANCE_FALLBACK_RESPONSE,
    riskCodes: final.riskCodes,
    riskScore: final.riskScore,
    cumulativeRiskScore: cumulativeSoFar,
    specificityLevel: generatorInput.hintLadderLevel,
    providerModel: "anthropic:claude-sonnet-4-6",
    latencyMs,
    settings,
    eventType: "AI_ASSISTANCE_USED",
  });
  return {
    status: "FALLBACK",
    response: AI_ASSISTANCE_FALLBACK_RESPONSE,
    studentMessage: null,
    promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptNumberForQuestion),
    promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptNumberForAttempt),
  };
}

export type GenerateVerifyOutcome =
  | { ok: true; response: string; riskScore: number; riskCodes: RiskCode[] }
  | { ok: false; riskScore: number; riskCodes: RiskCode[] };

/** Exported for direct unit testing (mocked generator/verifier, no Prisma) — see aiAssistanceRunner.test.ts. Never exported for use outside this module in production code. */
export async function attemptGenerateAndVerify(params: {
  generatorInput: BrainstormGeneratorInput;
  question: { text: string; type: string; correctAnswer: string | null };
  studentPrompt: string;
  approvedCountForQuestion: number;
  cumulativeSoFar: number;
}): Promise<GenerateVerifyOutcome> {
  const candidate = await generateBrainstormResponse(params.generatorInput);
  const verifierResult = await verifyBrainstormResponse({
    questionText: params.question.text,
    questionType: params.generatorInput.questionType,
    candidateResponse: candidate,
    studentRequest: params.studentPrompt,
    // Part 8 — the verifier alone may see hidden reference material; the
    // generator (params.generatorInput above) never received it.
    hiddenModelAnswer: params.question.correctAnswer,
    hiddenRubricSummary: null,
    priorApprovedHintCount: params.approvedCountForQuestion,
    cumulativeRiskScoreSoFar: params.cumulativeSoFar,
  });

  const projectedCumulative = nextCumulativeRiskScore(params.cumulativeSoFar, verifierResult.riskScore);
  const cumulativeOverride = isCumulativeHintLeakageRisk(projectedCumulative);
  const riskCodes = cumulativeOverride
    ? [...verifierResult.riskCodes.filter((c) => c !== "CUMULATIVE_HINT_LEAKAGE"), "CUMULATIVE_HINT_LEAKAGE" as RiskCode]
    : verifierResult.riskCodes;

  if (verifierResult.allowed && !cumulativeOverride) {
    return { ok: true, response: candidate, riskScore: verifierResult.riskScore, riskCodes };
  }
  return { ok: false, riskScore: verifierResult.riskScore, riskCodes };
}

async function currentCumulativeRiskScore(submissionId: string, questionId: string): Promise<number> {
  const last = await prisma.aiAssistanceInteraction.findFirst({
    where: { submissionId, questionId, status: { in: ["APPROVED", "REGENERATED_APPROVED"] } },
    orderBy: { createdAt: "desc" },
    select: { cumulativeRiskScore: true },
  });
  return last?.cumulativeRiskScore ?? 0;
}

async function recordLimitReached(
  submissionId: string,
  examId: string,
  studentId: string,
  settings: ReturnType<typeof parseSecureSettings>,
) {
  await prisma.integrityEvent
    .create({
      data: {
        submissionId,
        examId,
        studentId,
        eventType: "AI_ASSISTANCE_LIMIT_REACHED",
        severity: severityFor("AI_ASSISTANCE_LIMIT_REACHED", settings),
        message: "AI brainstorming assistance prompt limit reached.",
        occurredAt: new Date(),
      },
    })
    .catch(() => {
      // Audit logging is best-effort — never blocks the student.
    });
}

async function persistInteraction(params: {
  submission: { id: string; examId: string; studentId: string };
  question: { id: string };
  policy: AiAssistancePolicy;
  promptNumberForQuestion: number;
  promptNumberForAttempt: number;
  studentPrompt: string;
  status: AiAssistanceInteractionStatus;
  approvedResponse: string | null;
  riskCodes: string[];
  riskScore: number;
  cumulativeRiskScore: number;
  specificityLevel: number;
  providerModel: string | null;
  latencyMs: number | null;
  settings: ReturnType<typeof parseSecureSettings>;
  eventType: "AI_ASSISTANCE_USED" | "AI_ASSISTANCE_REQUEST_BLOCKED" | "AI_ASSISTANCE_RESPONSE_REGENERATED";
}) {
  await prisma.aiAssistanceInteraction.create({
    data: {
      submissionId: params.submission.id,
      questionId: params.question.id,
      examId: params.submission.examId,
      studentId: params.submission.studentId,
      studentPrompt: params.studentPrompt,
      approvedResponse: params.approvedResponse,
      status: params.status,
      promptNumberForQuestion: params.promptNumberForQuestion,
      promptNumberForAttempt: params.promptNumberForAttempt,
      policyVersion: params.policy.policyVersion,
      riskCodesJson: params.riskCodes,
      riskScore: params.riskScore,
      cumulativeRiskScore: params.cumulativeRiskScore,
      specificityLevel: params.specificityLevel,
      providerModel: params.providerModel,
      latencyMs: params.latencyMs,
    },
  });

  await prisma.integrityEvent
    .create({
      data: {
        submissionId: params.submission.id,
        examId: params.submission.examId,
        studentId: params.submission.studentId,
        eventType: params.eventType,
        severity: severityFor(params.eventType, params.settings),
        message:
          params.eventType === "AI_ASSISTANCE_REQUEST_BLOCKED"
            ? "An AI brainstorming assistance request was declined (outside the allowed brainstorming scope)."
            : params.eventType === "AI_ASSISTANCE_RESPONSE_REGENERATED"
              ? "An AI brainstorming assistance response was regenerated under stricter guidance before being shown."
              : "AI brainstorming assistance was used.",
        occurredAt: new Date(),
      },
    })
    .catch(() => {
      // Audit logging is best-effort — never blocks the student.
    });
}
