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
 *
 * Hardening v1.1 — see docs/controlled-ai-brainstorming-assistance-v1.md,
 * "Concurrency: atomic prompt-slot reservation" and "Interaction status
 * lifecycle": a prompt slot is now reserved ATOMICALLY (a Postgres
 * transaction-scoped advisory lock keyed on submissionId, guarding a
 * count-check-then-insert sequence) BEFORE any Anthropic call is made,
 * closing the count→generate→create-row race the pre-hardening version
 * had. Every code path that can fail — missing provider config, a
 * transport/parsing failure on either attempt, an over-length verified
 * response — now resolves to an explicit terminal status rather than an
 * uncaught exception, and NEVER shows the student anything that has not
 * itself passed the verifier.
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
  isApprovedResponseLengthValid,
  boundedHiddenReference,
  isStaleReservation,
  AI_ASSISTANCE_FALLBACK_RESPONSE,
  AI_ASSISTANCE_UNAVAILABLE_MESSAGE,
  type AiAssistancePolicy,
  type AiAssistanceInteractionStatus,
} from "@/lib/aiAssistancePolicy";
import {
  classifyStudentRequest,
  blockedRequestStudentMessage,
  type RequestBlockReasonCode,
} from "@/lib/aiAssistanceClassifier";
import {
  generateBrainstormResponse,
  isAnthropicConfigured,
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
// Load + validate
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
    // Deliberately the same 404 (never a distinguishable status/message)
    // whether questionId belongs to a different exam entirely, is a
    // garbage id, or is a real question this exam simply never selected
    // for this submission (question pools) — never reveals which case
    // it was.
    throw new AiAssistanceError(404, "This question is not part of your attempt");
  }
  // Under one-question-at-a-time delivery, assistance is only available
  // for a question the student has actually reached, never one still
  // ahead of their current position. Outside one-question mode, every
  // question in the stable set is already accessible.
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

// ---------------------------------------------------------------------------
// Atomic prompt-slot reservation (Part 2 hardening)
// ---------------------------------------------------------------------------

type ReservationOutcome =
  | { kind: "reserved"; interactionId: string; promptNumberForQuestion: number; promptNumberForAttempt: number }
  | { kind: "replay"; interactionId: string }
  | { kind: "in_progress" }
  | { kind: "rate_limited" }
  | { kind: "question_limit"; promptsForQuestion: number; promptsForAttempt: number }
  | { kind: "attempt_limit"; promptsForQuestion: number; promptsForAttempt: number };

/**
 * Reserves exactly one prompt slot for this request, or determines it
 * cannot be reserved — all inside a single Postgres transaction guarded
 * by a transaction-scoped advisory lock keyed on submissionId
 * (`pg_advisory_xact_lock`, released automatically at commit/rollback,
 * safe under Supabase's PgBouncer transaction-mode pooler since it is
 * never held across statements outside this one transaction). Two
 * concurrent requests for the same submission — two browser tabs, a
 * double-click, a client retry — serialize here: the second one only
 * proceeds once the first's transaction has committed (or rolled back),
 * by which point the count it reads already reflects the first's
 * reservation. No Anthropic call happens anywhere in this function.
 */
async function reserveInteractionSlot(params: {
  submission: { id: string; examId: string; studentId: string };
  question: { id: string };
  policy: AiAssistancePolicy;
  studentPrompt: string;
  clientRequestId: string | null;
}): Promise<ReservationOutcome> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.submission.id}))`;

    if (params.clientRequestId) {
      const existing = await tx.aiAssistanceInteraction.findUnique({
        where: { clientRequestId: params.clientRequestId },
        select: { id: true, status: true, createdAt: true },
      });
      if (existing) {
        if (existing.status === "RESERVED") {
          if (!isStaleReservation(existing.createdAt)) {
            return { kind: "in_progress" };
          }
          // The original request's invocation almost certainly crashed
          // or timed out before finalizing — self-heal it to FAILED here
          // (Part 4: "RESERVED records cannot remain permanently
          // misleading") rather than leaving it stuck, then replay that
          // now-terminal outcome for this resubmission.
          await tx.aiAssistanceInteraction.update({ where: { id: existing.id }, data: { status: "FAILED" } });
        }
        return { kind: "replay", interactionId: existing.id };
      }
    }

    const promptsForQuestion = await tx.aiAssistanceInteraction.count({
      where: { submissionId: params.submission.id, questionId: params.question.id },
    });
    const promptsForAttempt = await tx.aiAssistanceInteraction.count({
      where: { submissionId: params.submission.id },
    });

    if (hasReachedQuestionPromptLimit(promptsForQuestion, params.policy)) {
      return { kind: "question_limit", promptsForQuestion, promptsForAttempt };
    }
    if (hasReachedAttemptPromptLimit(promptsForAttempt, params.policy)) {
      return { kind: "attempt_limit", promptsForQuestion, promptsForAttempt };
    }

    const recent = await tx.aiAssistanceInteraction.findMany({
      where: { submissionId: params.submission.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { createdAt: true },
    });
    if (!isWithinRateLimit(recent.map((r) => r.createdAt.getTime()), Date.now())) {
      return { kind: "rate_limited" };
    }

    const row = await tx.aiAssistanceInteraction.create({
      data: {
        submissionId: params.submission.id,
        questionId: params.question.id,
        examId: params.submission.examId,
        studentId: params.submission.studentId,
        studentPrompt: params.studentPrompt,
        approvedResponse: null,
        status: "RESERVED",
        promptNumberForQuestion: promptsForQuestion + 1,
        promptNumberForAttempt: promptsForAttempt + 1,
        policyVersion: params.policy.policyVersion,
        clientRequestId: params.clientRequestId,
      },
      select: { id: true, promptNumberForQuestion: true, promptNumberForAttempt: true },
    });
    return {
      kind: "reserved",
      interactionId: row.id,
      promptNumberForQuestion: row.promptNumberForQuestion,
      promptNumberForAttempt: row.promptNumberForAttempt,
    };
  });
}

type FinalizePayload = {
  status: "APPROVED" | "BLOCKED" | "FALLBACK" | "FAILED";
  approvedResponse: string | null;
  riskCodes: string[];
  riskScore: number;
  cumulativeRiskScore: number;
  specificityLevel: number;
  providerModel: string | null;
  latencyMs: number | null;
  wasRegenerated: boolean;
};

function messageForEventType(eventType: string): string {
  switch (eventType) {
    case "AI_ASSISTANCE_REQUEST_BLOCKED":
      return "An AI brainstorming assistance request was declined (outside the allowed brainstorming scope).";
    case "AI_ASSISTANCE_RESPONSE_REGENERATED":
      return "An AI brainstorming assistance response was regenerated under stricter guidance before being shown.";
    case "AI_ASSISTANCE_REQUEST_FAILED":
      return "An AI brainstorming assistance request could not be completed due to a provider error.";
    default:
      return "AI brainstorming assistance was used.";
  }
}

async function finalizeInteraction(
  interactionId: string,
  submission: { id: string; examId: string; studentId: string },
  settings: ReturnType<typeof parseSecureSettings>,
  payload: FinalizePayload,
): Promise<void> {
  await prisma.aiAssistanceInteraction.update({
    where: { id: interactionId },
    data: {
      status: payload.status,
      approvedResponse: payload.approvedResponse,
      riskCodesJson: payload.riskCodes,
      riskScore: payload.riskScore,
      cumulativeRiskScore: payload.cumulativeRiskScore,
      specificityLevel: payload.specificityLevel,
      providerModel: payload.providerModel,
      latencyMs: payload.latencyMs,
      wasRegenerated: payload.wasRegenerated,
    },
  });

  const eventType =
    payload.status === "BLOCKED"
      ? ("AI_ASSISTANCE_REQUEST_BLOCKED" as const)
      : payload.status === "FAILED"
        ? ("AI_ASSISTANCE_REQUEST_FAILED" as const)
        : payload.wasRegenerated
          ? ("AI_ASSISTANCE_RESPONSE_REGENERATED" as const)
          : ("AI_ASSISTANCE_USED" as const);

  await prisma.integrityEvent
    .create({
      data: {
        submissionId: submission.id,
        examId: submission.examId,
        studentId: submission.studentId,
        eventType,
        severity: severityFor(eventType, settings),
        message: messageForEventType(eventType),
        occurredAt: new Date(),
      },
    })
    .catch(() => {
      // Audit logging is best-effort — never blocks the student.
    });
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

async function currentCumulativeRiskScore(submissionId: string, questionId: string): Promise<number> {
  const last = await prisma.aiAssistanceInteraction.findFirst({
    where: { submissionId, questionId, status: "APPROVED" },
    orderBy: { createdAt: "desc" },
    select: { cumulativeRiskScore: true },
  });
  return last?.cumulativeRiskScore ?? 0;
}

/** Replays the stored outcome of an already-reserved (and, by the time this runs, always terminal) interaction — used when a client resubmits the same clientRequestId. Never calls Anthropic. */
async function resultFromExistingInteraction(
  interactionId: string,
  policy: AiAssistancePolicy,
): Promise<AiAssistanceRunResult> {
  const row = await prisma.aiAssistanceInteraction.findUnique({ where: { id: interactionId } });
  if (!row) throw new AiAssistanceError(500, "Could not retrieve your previous request. Please try again.");

  const [promptsForQuestion, promptsForAttempt] = await Promise.all([
    prisma.aiAssistanceInteraction.count({ where: { submissionId: row.submissionId, questionId: row.questionId } }),
    prisma.aiAssistanceInteraction.count({ where: { submissionId: row.submissionId } }),
  ]);

  const status = row.status as AiAssistanceInteractionStatus;
  const studentMessage =
    status === "BLOCKED"
      ? blockedRequestStudentMessage(((row.riskCodesJson as string[] | null) ?? []) as RequestBlockReasonCode[])
      : status === "FAILED"
        ? AI_ASSISTANCE_UNAVAILABLE_MESSAGE
        : null;

  return {
    status,
    response: row.approvedResponse,
    studentMessage,
    promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptsForQuestion),
    promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptsForAttempt),
  };
}

/**
 * The single entry point: validates, checks provider configuration,
 * atomically reserves a prompt slot, classifies, and — only for an
 * allowed request — runs generate -> verify -> (regenerate once ->
 * verify) -> fallback/failure, finalizing exactly the one reserved
 * AiAssistanceInteraction row. Throws AiAssistanceError for every
 * validation/limit/concurrency failure (the API route maps `.status`
 * directly to the HTTP response); every OTHER failure (provider/parsing)
 * resolves to a normal FAILED-status return value, never an exception.
 */
export async function runAiAssistanceRequest(params: {
  submissionId: string;
  studentId: string;
  questionId: string;
  studentPrompt: string;
  studentCurrentReasoning?: string | null;
  clientRequestId?: string | null;
}): Promise<AiAssistanceRunResult> {
  const { submission, question, policy, settings } = await loadValidatedContext(
    params.submissionId,
    params.studentId,
    params.questionId,
  );

  if (!isStudentPromptLengthValid(params.studentPrompt)) {
    throw new AiAssistanceError(400, "Your message is empty or too long. Please shorten it and try again.");
  }

  // Provider-configuration check BEFORE reservation — a missing API key
  // must never consume a student's prompt allowance (Part 3: "provider
  // configuration missing before processing begins" does not consume).
  if (!isAnthropicConfigured()) {
    throw new AiAssistanceError(503, "AI brainstorming assistance is not configured. Please contact your instructor.");
  }

  const reservation = await reserveInteractionSlot({
    submission,
    question,
    policy,
    studentPrompt: params.studentPrompt,
    clientRequestId: params.clientRequestId?.trim() || null,
  });

  if (reservation.kind === "in_progress") {
    throw new AiAssistanceError(
      409,
      "Your previous request for this question is still being processed. Please wait a moment and try again.",
    );
  }
  if (reservation.kind === "rate_limited") {
    throw new AiAssistanceError(429, "You're sending requests too quickly. Please wait a moment and try again.");
  }
  if (reservation.kind === "question_limit" || reservation.kind === "attempt_limit") {
    recordLimitReached(submission.id, submission.examId, submission.studentId, settings).catch(() => {});
    return {
      status: "BLOCKED",
      response: null,
      studentMessage:
        reservation.kind === "attempt_limit"
          ? "You've used all the assistance prompts available for this attempt."
          : "You've used all the assistance prompts available for this question.",
      promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - reservation.promptsForQuestion),
      promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - reservation.promptsForAttempt),
    };
  }
  if (reservation.kind === "replay") {
    return resultFromExistingInteraction(reservation.interactionId, policy);
  }

  const { interactionId, promptNumberForQuestion, promptNumberForAttempt } = reservation;

  const classification = classifyStudentRequest(params.studentPrompt);
  if (!classification.allowed) {
    await finalizeInteraction(interactionId, submission, settings, {
      status: "BLOCKED",
      approvedResponse: null,
      riskCodes: classification.blockReasonCodes,
      riskScore: 0,
      cumulativeRiskScore: await currentCumulativeRiskScore(submission.id, question.id),
      specificityLevel: 0,
      providerModel: null,
      latencyMs: null,
      wasRegenerated: false,
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
    where: { submissionId: submission.id, questionId: question.id, status: "APPROVED" },
  });
  const cumulativeSoFar = await currentCumulativeRiskScore(submission.id, question.id);
  const priorApproved = await prisma.aiAssistanceInteraction.findMany({
    where: { submissionId: submission.id, questionId: question.id, status: "APPROVED" },
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
  let outcome = await attemptGenerateAndVerify({
    generatorInput,
    question,
    policy,
    studentPrompt: params.studentPrompt,
    approvedCountForQuestion,
    cumulativeSoFar,
  });
  let regenerated = false;
  if (outcome.kind !== "approved") {
    outcome = await attemptGenerateAndVerify({
      generatorInput: { ...generatorInput, stricter: true },
      question,
      policy,
      studentPrompt: params.studentPrompt,
      approvedCountForQuestion,
      cumulativeSoFar,
    });
    regenerated = true;
  }
  const latencyMs = Date.now() - startedAt;

  if (outcome.kind === "approved") {
    const newCumulative = nextCumulativeRiskScore(cumulativeSoFar, outcome.riskScore);
    await finalizeInteraction(interactionId, submission, settings, {
      status: "APPROVED",
      approvedResponse: outcome.response,
      riskCodes: outcome.riskCodes,
      riskScore: outcome.riskScore,
      cumulativeRiskScore: newCumulative,
      specificityLevel: generatorInput.hintLadderLevel,
      providerModel: "anthropic:claude-sonnet-4-6",
      latencyMs,
      wasRegenerated: regenerated,
    });
    return {
      status: "APPROVED",
      response: outcome.response,
      studentMessage: null,
      promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptNumberForQuestion),
      promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptNumberForAttempt),
    };
  }

  if (outcome.kind === "error") {
    // A genuine provider/parsing failure on the (stricter) final attempt
    // — never shown the fallback text, since that would misleadingly
    // imply the pipeline worked and simply had nothing safe to say.
    await finalizeInteraction(interactionId, submission, settings, {
      status: "FAILED",
      approvedResponse: null,
      riskCodes: [],
      riskScore: 0,
      cumulativeRiskScore: cumulativeSoFar,
      specificityLevel: generatorInput.hintLadderLevel,
      providerModel: null,
      latencyMs,
      wasRegenerated: regenerated,
    });
    return {
      status: "FAILED",
      response: null,
      studentMessage: AI_ASSISTANCE_UNAVAILABLE_MESSAGE,
      promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptNumberForQuestion),
      promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptNumberForAttempt),
    };
  }

  // outcome.kind === "rejected" — both attempts completed cleanly (no
  // provider error) but no candidate ever passed verification (or one
  // did but failed the length/cumulative gate). Deterministic safe
  // fallback — the rejected candidate text itself is discarded here and
  // NEVER persisted or returned, on either attempt.
  await finalizeInteraction(interactionId, submission, settings, {
    status: "FALLBACK",
    approvedResponse: AI_ASSISTANCE_FALLBACK_RESPONSE,
    riskCodes: outcome.riskCodes,
    riskScore: outcome.riskScore,
    cumulativeRiskScore: cumulativeSoFar,
    specificityLevel: generatorInput.hintLadderLevel,
    providerModel: "anthropic:claude-sonnet-4-6",
    latencyMs,
    wasRegenerated: regenerated,
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
  | { kind: "approved"; response: string; riskScore: number; riskCodes: RiskCode[] }
  | { kind: "rejected"; riskScore: number; riskCodes: RiskCode[] }
  | { kind: "error" };

/**
 * Exported for direct unit testing (mocked generator/verifier, no
 * Prisma) — see aiAssistanceRunner.test.ts. Never exported for use
 * outside this module in production code.
 *
 * Every failure mode collapses to `{ kind: "error" }` — a thrown
 * generator/verifier error (missing config, timeout, malformed JSON,
 * unknown risk code, empty output) is caught HERE, not left to escape to
 * the caller, so the caller never needs its own try/catch around a
 * provider call. A verified-but-too-long response is treated as
 * `"rejected"` (Part 9 — never truncated, always re-attempted or
 * replaced by the fallback instead).
 */
export async function attemptGenerateAndVerify(params: {
  generatorInput: BrainstormGeneratorInput;
  question: { text: string; type: string; correctAnswer: string | null };
  policy: Pick<AiAssistancePolicy, "maxResponseCharacters">;
  studentPrompt: string;
  approvedCountForQuestion: number;
  cumulativeSoFar: number;
}): Promise<GenerateVerifyOutcome> {
  let candidate: string;
  try {
    candidate = await generateBrainstormResponse(params.generatorInput);
  } catch {
    return { kind: "error" };
  }

  let verifierResult;
  try {
    verifierResult = await verifyBrainstormResponse({
      questionText: params.question.text,
      questionType: params.generatorInput.questionType,
      candidateResponse: candidate,
      studentRequest: params.studentPrompt,
      // The verifier alone may see hidden reference material; the
      // generator (params.generatorInput above) never received it.
      hiddenModelAnswer: boundedHiddenReference(params.question.correctAnswer),
      hiddenRubricSummary: null,
      priorApprovedHintCount: params.approvedCountForQuestion,
      cumulativeRiskScoreSoFar: params.cumulativeSoFar,
    });
  } catch {
    return { kind: "error" };
  }

  const projectedCumulative = nextCumulativeRiskScore(params.cumulativeSoFar, verifierResult.riskScore);
  const cumulativeOverride = isCumulativeHintLeakageRisk(projectedCumulative);
  const lengthValid = isApprovedResponseLengthValid(candidate, params.policy);
  const riskCodes = cumulativeOverride
    ? [...verifierResult.riskCodes.filter((c) => c !== "CUMULATIVE_HINT_LEAKAGE"), "CUMULATIVE_HINT_LEAKAGE" as RiskCode]
    : verifierResult.riskCodes;

  if (verifierResult.allowed && !cumulativeOverride && lengthValid) {
    return { kind: "approved", response: candidate, riskScore: verifierResult.riskScore, riskCodes };
  }
  return { kind: "rejected", riskScore: verifierResult.riskScore, riskCodes };
}
