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
  isSubstantiallyIdenticalResponse,
  buildFallbackGuidance,
  describeInteractionOutcome,
  boundedHiddenReference,
  isStaleReservation,
  AI_ASSISTANCE_UNAVAILABLE_MESSAGE,
  type AiAssistancePolicy,
  type AiAssistanceInteractionStatus,
} from "@/lib/aiAssistancePolicy";
import {
  classifyStudentRequest,
  blockedRequestStudentMessage,
  type RequestBlockReasonCode,
} from "@/lib/aiAssistanceClassifier";
import { classifyBrainstormRequestMode, type BrainstormRequestMode } from "@/lib/aiAssistanceRequestMode";
import {
  generateBrainstormResponse,
  isAnthropicConfigured,
  getAnthropicBrainstormModel,
  AiAssistanceGenerationError,
  type BrainstormGeneratorInput,
  type BrainstormQuestionType,
} from "@/lib/aiAssistanceGenerator";
import {
  verifyBrainstormResponse,
  getAnthropicBrainstormVerifierModel,
  AiAssistanceVerificationError,
  type RiskCode,
} from "@/lib/aiAssistanceVerifier";
import type { AiProviderErrorCategory, ProviderCallAttemptLog } from "@/lib/aiAssistanceProviderError";
import { isSubmissionContentAccessible, EXAM_NOT_ACTIVATED_MESSAGE } from "@/lib/secureClientActivation";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import {
  checkTetherContentAccessLease,
  readContentAccessLeaseCookieFromRequest,
  TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE,
} from "@/lib/secureClient/requireTetherContentAccess";
import { isServerTimingHeaderEnabled } from "@/lib/serverTiming";

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

async function loadValidatedContext(submissionId: string, studentId: string, questionId: string, req: Request) {
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

  // Release-blocking server content-boundary audit — see
  // tetherContentAccessLease.ts. This route was found to have NO
  // activation gate at all: a TETHER_CLIENT_REQUIRED/SEB_REQUIRED
  // submission that has never been server-activated (native lockdown
  // never confirmed) could still receive AI brainstorming assistance
  // tied to real question content. Same two-layer gate as every other
  // content-bearing route: isSubmissionContentAccessible (submission-
  // bound) plus the request-bound lease (proves THIS request actually
  // comes from the Tether/SEB instance, not a separately-authenticated
  // ordinary browser).
  if (!isSubmissionContentAccessible(submission)) {
    throw new AiAssistanceError(403, EXAM_NOT_ACTIVATED_MESSAGE);
  }
  const aiAssistanceClientPolicy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  if (aiAssistanceClientPolicy.deliveryMode === "TETHER_CLIENT_REQUIRED") {
    const leaseDecision = await checkTetherContentAccessLease(readContentAccessLeaseCookieFromRequest(req), {
      submissionId: submission.id,
      studentId,
    });
    if (!leaseDecision.ok) {
      throw new AiAssistanceError(403, TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE);
    }
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
  // Question-scoped brainstorm sidebar v1 — the client previously only
  // ever saw ever-decreasing "remaining" counts with no allowance to
  // compare them against. Both values come straight from the same
  // immutable per-attempt policy snapshot already used to compute
  // `promptsRemainingFor*` above, so they can never disagree.
  maxPromptsPerQuestion: number;
  maxPromptsPerAttempt: number;
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

/** Human-readable, model-facing reasons for each risk code — see rejectionRegenerationHint below. Deliberately not exhaustive prose (a short clause per code); codes with no entry are simply skipped rather than producing an empty/garbled sentence. */
const RISK_CODE_REGENERATION_REASONS: Partial<Record<RiskCode, string>> = {
  DIRECT_ANSWER: "it stated or clearly implied the final answer",
  NEAR_COMPLETE_ANSWER: "it got too close to the final answer",
  CORRECT_OPTION_DISCLOSED: "it identified or implied which option is correct",
  OPTION_ELIMINATION: "it ruled options in or out",
  FINAL_NUMERIC_RESULT: "it gave the final numeric result",
  SUBMISSION_READY_PROSE: "it was specific enough to submit directly as the answer",
  COMPLETE_CODE: "it included complete working code",
  HIDDEN_RUBRIC_DISCLOSURE: "it referenced the marking rubric or a model answer",
  CUMULATIVE_HINT_LEAKAGE: "combined with earlier approved hints it revealed too much",
  EXCESSIVE_SPECIFICITY: "it was more specific than appropriate at this stage",
  // Cumulative answer-assembly follow-up.
  SUBMISSION_READY_COMPLETION: "it supplied enough content to substantially complete the assessed response on its own",
  CUMULATIVE_RESPONSE_COMPLETION: "combined with earlier approved guidance for this question it substantially completed the assessed response",
};

/**
 * Concept-explanation quality follow-up — builds a TARGETED regeneration
 * instruction from WHY the previous candidate was rejected (the
 * verifier's own risk codes, or a length-specific note when the verifier
 * allowed it but it was too long), instead of only a generic "be more
 * conservative" instruction. A specific reason lets the generator avoid
 * the actual problem while still substantively answering the student's
 * real request. Returns null when there's nothing specific to say (a
 * provider/verifier ERROR, not a real content rejection, or an unmapped
 * risk code) — the caller falls back to the old generic stricter wording
 * in aiAssistanceGenerator.ts in that case. Exported for direct unit
 * testing (no Prisma/Anthropic involved — pure).
 *
 * `requestMode` is optional (existing call sites/tests are unaffected)
 * — when it is ANSWER_CONFIRMATION (minor Brainstorm response-quality
 * fix: an explicit answer-seeking request, not only a student
 * confirming their own stated answer — see aiAssistanceRequestMode.ts),
 * this returns a short, concise-hint-only instruction instead of the
 * risk-code-reasons instruction below, which explicitly invites "as
 * much substantive detail as helps" — exactly the wrong direction for a
 * request that should get a brief refusal + one hint, never a longer
 * explanation.
 */
export function rejectionRegenerationHint(outcome: GenerateVerifyOutcome, requestMode?: BrainstormRequestMode): string | null {
  if (outcome.kind !== "rejected") return null;
  if (requestMode === "ANSWER_CONFIRMATION") {
    return (
      "Do not provide the exact assessed answer, option, result, or code. Respond in 1-3 short sentences: briefly " +
      "say you can't give the exact answer, then give ONE concise, question-specific hint or recall cue that helps " +
      "the student continue. Never use a generic template like \"let's break this down\" or \"identify the main concept\"."
    );
  }
  if (outcome.riskCodes.length === 0) {
    return (
      "Your previous response was too long. Say the same kind of thing more concisely, while still directly and " +
      "specifically addressing the student's actual request."
    );
  }
  const reasons = outcome.riskCodes
    .map((code) => RISK_CODE_REGENERATION_REASONS[code])
    .filter((reason): reason is string => Boolean(reason));
  if (reasons.length === 0) return null;
  return (
    `Your previous response crossed too close to the final assessed answer — specifically, ${reasons.join("; ")}. ` +
    "Keep the useful teaching content — you may still explain relevant concepts, syntax, or terminology in as " +
    `much substantive detail as helps the student — but stop before resolving the final graded result this time.`
  );
}

/** Architectural simplification follow-up (unified retry) — the two, and only two, reasons a candidate is not acceptable on the first attempt. Either way: exactly one targeted retry, never a loop. */
type RetryReason = "REJECTED" | "REPETITIVE";

/** Fixed instruction for the REPETITIVE retry reason — unlike a rejection, there is no risk-code-specific detail to report, so this is the one reusable string (see RetryReason/the unified retry block in runAiAssistanceRequest). */
const REPETITION_REGENERATION_GUIDANCE =
  "The previous guidance already covered that. Respond specifically to the student's new request with a different useful explanation, reasoning direction, or targeted question.";

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
    maxPromptsPerQuestion: policy.maxPromptsPerQuestion,
    maxPromptsPerAttempt: policy.maxPromptsPerAttempt,
  };
}

// ---------------------------------------------------------------------------
// Question-scoped history (read-only) — Question-scoped brainstorm sidebar v1
// ---------------------------------------------------------------------------

export type AiAssistanceHistoryEntry = {
  id: string;
  studentPrompt: string;
  response: string | null;
  studentMessage: string | null;
  status: "APPROVED" | "BLOCKED" | "FALLBACK" | "FAILED";
  createdAt: string;
};

export type AiAssistanceHistoryResult = {
  interactions: AiAssistanceHistoryEntry[];
  promptsRemainingForQuestion: number;
  promptsRemainingForAttempt: number;
  maxPromptsPerQuestion: number;
  maxPromptsPerAttempt: number;
};

/**
 * Read-only counterpart to runAiAssistanceRequest — lets the student's own
 * panel restore its transcript for a submission+question from the
 * authoritative stored AiAssistanceInteraction rows (see
 * @@index([submissionId, questionId]) on that model) instead of relying on
 * client-only state that resets on remount/navigation/reload. Reuses
 * loadValidatedContext unchanged, so this exposes nothing a POST to the
 * same submission+question couldn't already reveal: same ownership,
 * activation, and AI-mode-enabled gates. Never calls Anthropic.
 *
 * A still-in-flight RESERVED row (another tab's request mid-flight) is
 * excluded — its own tab already reflects it via the POST response. A
 * STALE RESERVED row (Part 4: an interaction whose original request
 * crashed/timed out before finalizing) is normalized to FAILED for
 * display here, matching the lecturer review's own normalization — but,
 * being a read path, this never writes that self-heal to the row itself;
 * the next real POST to this submission does that.
 */
export async function loadInteractionHistory(params: {
  submissionId: string;
  studentId: string;
  questionId: string;
  req: Request;
}): Promise<AiAssistanceHistoryResult> {
  const { policy } = await loadValidatedContext(params.submissionId, params.studentId, params.questionId, params.req);

  const [rows, promptsForQuestion, promptsForAttempt] = await Promise.all([
    prisma.aiAssistanceInteraction.findMany({
      where: { submissionId: params.submissionId, questionId: params.questionId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.aiAssistanceInteraction.count({ where: { submissionId: params.submissionId, questionId: params.questionId } }),
    prisma.aiAssistanceInteraction.count({ where: { submissionId: params.submissionId } }),
  ]);

  const interactions: AiAssistanceHistoryEntry[] = rows.flatMap((row) => {
    const rawStatus = row.status as AiAssistanceInteractionStatus;
    if (rawStatus === "RESERVED" && !isStaleReservation(row.createdAt)) return [];
    const status: AiAssistanceHistoryEntry["status"] = rawStatus === "RESERVED" ? "FAILED" : rawStatus;
    const studentMessage =
      status === "BLOCKED"
        ? blockedRequestStudentMessage(((row.riskCodesJson as string[] | null) ?? []) as RequestBlockReasonCode[])
        : status === "FAILED"
          ? AI_ASSISTANCE_UNAVAILABLE_MESSAGE
          : null;
    return [
      {
        id: row.id,
        studentPrompt: row.studentPrompt,
        response: row.approvedResponse,
        studentMessage,
        status,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });

  return {
    interactions,
    promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptsForQuestion),
    promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptsForAttempt),
    maxPromptsPerQuestion: policy.maxPromptsPerQuestion,
    maxPromptsPerAttempt: policy.maxPromptsPerAttempt,
  };
}

/**
 * Intermittent-failure follow-up — one structured, single-line JSON
 * diagnostic record per interaction (never the student prompt, the
 * candidate/verified response text, or any raw provider error message —
 * only bounded stage/attempt/timing/classification data, all of which
 * already comes from GenerateVerifyDiagnostics' own bounded shape). Gated
 * behind the SAME TETHER_TIMING_HEADERS_ENABLED flag serverTiming.ts's
 * navigation-timing diagnostics already use (see that module's own doc
 * comment: off by default in every environment including Production,
 * deliberately set for a bounded controlled-test window) rather than a
 * second flag — one switch now covers both the exam-open and the
 * Brainstorm critical paths for a physical test session.
 */
function summarizeOutcome(outcome: GenerateVerifyOutcome): Record<string, unknown> {
  const base = {
    generatorMs: Math.round(outcome.diagnostics.generator.ranMs),
    generatorAttempts: outcome.diagnostics.generator.attempts,
    verifierMs: Math.round(outcome.diagnostics.verifier.ranMs),
    verifierAttempts: outcome.diagnostics.verifier.attempts,
  };
  if (outcome.kind === "error") {
    return { ...base, outcome: "error", errorStage: outcome.stage, errorCategory: outcome.category };
  }
  if (outcome.kind === "rejected") {
    // Concept-explanation quality follow-up — riskCodes and the
    // verifier's own reason are safe to log (see the verifier's own doc
    // comment: its `reason` field never quotes hidden reference material
    // or student-facing text) and let a future over-rejection report be
    // traced to its actual cause via this log line, rather than only
    // reconstructed after the fact from the prompts. Bounded defensively
    // in case a future verifier change ever lengthens `reason`.
    return { ...base, outcome: outcome.kind, riskCodes: outcome.riskCodes, reason: outcome.reason.slice(0, 400) };
  }
  return { ...base, outcome: outcome.kind };
}

function logAiAssistanceDiagnostics(params: {
  interactionId: string;
  initialOutcome: GenerateVerifyOutcome;
  finalOutcome: GenerateVerifyOutcome;
  wasRegenerated: boolean;
  totalAiMs: number;
  // Grounded-cumulative-safety follow-up (section 14, observability) —
  // repeated Preview investigations found the log line alone couldn't
  // distinguish "which request mode / question type / how much prior
  // history / was there grounding data" without cross-referencing the
  // database. All bounded, non-content fields — never the student
  // prompt, the candidate/verified response text, or the hidden model
  // answer's actual contents (hasHiddenModelAnswer is a boolean only).
  requestMode: string;
  questionType: string;
  priorApprovedResponseCount: number;
  hasHiddenModelAnswer: boolean;
}): void {
  if (!isServerTimingHeaderEnabled(process.env.TETHER_TIMING_HEADERS_ENABLED)) return;
  const passes = [summarizeOutcome(params.initialOutcome)];
  if (params.wasRegenerated) passes.push(summarizeOutcome(params.finalOutcome));
  // Architectural simplification follow-up (observability) — the same
  // MODEL_APPROVED / MODEL_APPROVED_AFTER_RETRY / DETERMINISTIC_FALLBACK
  // distinction the interaction row itself represents via status +
  // wasRegenerated (see describeInteractionOutcome), surfaced here too so
  // a future Preview investigation can read it straight off this log
  // line instead of cross-referencing the database.
  const finalStatus: AiAssistanceInteractionStatus =
    params.finalOutcome.kind === "approved" ? "APPROVED" : params.finalOutcome.kind === "error" && params.finalOutcome.stage === "generator" ? "FAILED" : "FALLBACK";
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: "AI_ASSISTANCE_DIAGNOSTICS",
      interactionId: params.interactionId,
      wasRegenerated: params.wasRegenerated,
      outcomeLabel: describeInteractionOutcome({ status: finalStatus, wasRegenerated: params.wasRegenerated }),
      totalAiMs: Math.round(params.totalAiMs),
      generatorModel: `anthropic:${getAnthropicBrainstormModel()}`,
      verifierModel: `anthropic:${getAnthropicBrainstormVerifierModel()}`,
      requestMode: params.requestMode,
      questionType: params.questionType,
      priorApprovedResponseCount: params.priorApprovedResponseCount,
      hasHiddenModelAnswer: params.hasHiddenModelAnswer,
      passes,
    }),
  );
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
  req: Request;
}): Promise<AiAssistanceRunResult> {
  const { submission, question, policy, settings } = await loadValidatedContext(
    params.submissionId,
    params.studentId,
    params.questionId,
    params.req,
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
      maxPromptsPerQuestion: policy.maxPromptsPerQuestion,
      maxPromptsPerAttempt: policy.maxPromptsPerAttempt,
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
      maxPromptsPerQuestion: policy.maxPromptsPerQuestion,
      maxPromptsPerAttempt: policy.maxPromptsPerAttempt,
    };
  }

  // Independent reads: run concurrently to reduce pre-generation DB latency.
  const [approvedCountForQuestion, cumulativeSoFar, priorApproved] = await Promise.all([
    prisma.aiAssistanceInteraction.count({
      where: { submissionId: submission.id, questionId: question.id, status: "APPROVED" },
    }),
    currentCumulativeRiskScore(submission.id, question.id),
    // Grounded-cumulative-safety follow-up (MUST HAVE) — ALL approved
    // responses for this submission+question, never an arbitrary
    // recency window. A fixed `take: 5` here meant a student could burn
    // a handful of throwaway turns and have every subsequent turn become
    // permanently invisible to cumulative-completion judgment — an
    // adversarially exploitable gap, not just a UX limit. The count is
    // already bounded by the lecturer-configured
    // aiAssistanceMaxPromptsPerQuestion (reserveInteractionSlot enforces
    // this before any interaction row can even be created — see
    // hasReachedQuestionPromptLimit above), so no second arbitrary cap is
    // introduced here. Isolation to this exact submissionId+questionId
    // (never another student, attempt/retake, or question) is unchanged.
    prisma.aiAssistanceInteraction.findMany({
      where: { submissionId: submission.id, questionId: question.id, status: "APPROVED" },
      orderBy: { createdAt: "asc" },
      select: { studentPrompt: true, approvedResponse: true },
    }),
  ]);

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
    // Architectural simplification follow-up — non-blocking: this only
    // selects which short generator instruction template to use (see
    // aiAssistanceRequestMode.ts). The hard classifyStudentRequest check
    // above already decided this request is allowed; this never re-gates it.
    requestMode: classifyBrainstormRequestMode(params.studentPrompt),
    priorApprovedInteractions: priorApproved.map((p) => ({
      studentPrompt: p.studentPrompt,
      approvedResponse: p.approvedResponse ?? "",
    })),
    studentCurrentReasoning: policy.allowReasoningFeedback ? (params.studentCurrentReasoning ?? null) : null,
    hintLadderLevel: hintLadderLevelForApprovedCount(approvedCountForQuestion),
  };

  const startedAt = Date.now();
  const initialOutcome = await attemptGenerateAndVerify({
    generatorInput,
    question,
    policy,
    studentPrompt: params.studentPrompt,
    approvedCountForQuestion,
    cumulativeSoFar,
  });
  let outcome = initialOutcome;
  let regenerated = false;
  // Architectural simplification follow-up (unified retry) — a single
  // bounded decision instead of two separate branches for "verifier
  // rejected" and "response repeats prior guidance": not-acceptable is
  // not-acceptable, whichever of those two reasons caused it, and either
  // way the response is exactly ONE targeted retry, never a loop. Total
  // generation attempts per student interaction stays bounded at 2.
  const immediatelyPriorApproved = priorApproved[priorApproved.length - 1];
  const retryReason: RetryReason | null =
    outcome.kind !== "approved"
      ? "REJECTED"
      : immediatelyPriorApproved && isSubstantiallyIdenticalResponse(outcome.response, immediatelyPriorApproved.approvedResponse ?? "")
        ? "REPETITIVE"
        : null;

  if (retryReason !== null) {
    outcome = await attemptGenerateAndVerify({
      generatorInput: {
        ...generatorInput,
        // Only the REJECTED path tightens temperature — a repetition
        // retry wants MORE variety in phrasing, not less, so it stays at
        // the normal (non-stricter) temperature.
        stricter: retryReason === "REJECTED",
        regenerationGuidance:
          retryReason === "REJECTED" ? rejectionRegenerationHint(outcome, generatorInput.requestMode) : REPETITION_REGENERATION_GUIDANCE,
      },
      question,
      policy,
      studentPrompt: params.studentPrompt,
      approvedCountForQuestion,
      cumulativeSoFar,
    });
    regenerated = true;
  }
  const latencyMs = Date.now() - startedAt;

  logAiAssistanceDiagnostics({
    interactionId,
    initialOutcome,
    finalOutcome: outcome,
    wasRegenerated: regenerated,
    totalAiMs: latencyMs,
    requestMode: generatorInput.requestMode,
    questionType,
    priorApprovedResponseCount: priorApproved.length,
    hasHiddenModelAnswer: Boolean(question.correctAnswer),
  });

  if (outcome.kind === "approved") {
    const newCumulative = nextCumulativeRiskScore(cumulativeSoFar, outcome.riskScore);
    await finalizeInteraction(interactionId, submission, settings, {
      status: "APPROVED",
      approvedResponse: outcome.response,
      riskCodes: outcome.riskCodes,
      riskScore: outcome.riskScore,
      cumulativeRiskScore: newCumulative,
      specificityLevel: generatorInput.hintLadderLevel,
      providerModel: `anthropic:${getAnthropicBrainstormModel()}`,
      latencyMs,
      wasRegenerated: regenerated,
    });
    return {
      status: "APPROVED",
      response: outcome.response,
      studentMessage: null,
      promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptNumberForQuestion),
      promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptNumberForAttempt),
      maxPromptsPerQuestion: policy.maxPromptsPerQuestion,
      maxPromptsPerAttempt: policy.maxPromptsPerAttempt,
    };
  }

  // Intermittent-failure follow-up — a genuine GENERATOR failure on the
  // (stricter) final attempt is still shown as FAILED, never the
  // fallback text: no candidate was ever produced at all, so showing
  // fallback guidance would misleadingly imply the pipeline worked and
  // simply had nothing safe to say. A VERIFIER failure is different: the
  // generator DID produce a candidate (proving the provider is generally
  // reachable) and only the independent safety check itself could not be
  // completed — the safest useful thing to do is exactly what an
  // ordinary content REJECTION already does: show the deterministic,
  // pre-approved, always-safe fallback guidance rather than an
  // unnecessarily alarming "unavailable" message. The verifier is never
  // bypassed here — the unverified candidate is still discarded either
  // way, on every path.
  if (outcome.kind === "error" && outcome.stage === "generator") {
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
      maxPromptsPerQuestion: policy.maxPromptsPerQuestion,
      maxPromptsPerAttempt: policy.maxPromptsPerAttempt,
    };
  }

  // outcome.kind === "rejected", OR outcome.kind === "error" with
  // stage === "verifier" — both attempts either completed cleanly with no
  // candidate ever passing verification (or one did but failed the
  // length/cumulative gate), or the verifier itself could not complete
  // its check on the final attempt. Either way: deterministic safe
  // fallback. The (rejected or never-verified) candidate text itself is
  // discarded here and NEVER persisted or returned, on any path.
  const riskCodes = outcome.kind === "rejected" ? outcome.riskCodes : [];
  const riskScore = outcome.kind === "rejected" ? outcome.riskScore : 0;
  // Concept-explanation quality follow-up — question-aware fallback
  // instead of one universal paragraph: the student's own request and the
  // (already-visible-to-them) question text are safe to quote back, and
  // vary the guidance by what kind of request this was (concept
  // explanation, approach, guiding question) rather than repeating the
  // same generic sentence regardless of what was actually asked.
  const fallbackResponse = buildFallbackGuidance({
    questionText: question.text,
    studentRequest: params.studentPrompt,
    requestMode: generatorInput.requestMode,
  });
  await finalizeInteraction(interactionId, submission, settings, {
    status: "FALLBACK",
    approvedResponse: fallbackResponse,
    riskCodes,
    riskScore,
    cumulativeRiskScore: cumulativeSoFar,
    specificityLevel: generatorInput.hintLadderLevel,
    providerModel: `anthropic:${getAnthropicBrainstormModel()}`,
    latencyMs,
    wasRegenerated: regenerated,
  });
  return {
    status: "FALLBACK",
    response: fallbackResponse,
    studentMessage: null,
    promptsRemainingForQuestion: Math.max(0, policy.maxPromptsPerQuestion - promptNumberForQuestion),
    promptsRemainingForAttempt: Math.max(0, policy.maxPromptsPerAttempt - promptNumberForAttempt),
    maxPromptsPerQuestion: policy.maxPromptsPerQuestion,
    maxPromptsPerAttempt: policy.maxPromptsPerAttempt,
  };
}

/** One stage's diagnostics — every call attempt made for it, and the stage's own total wall time (attempts + backoff, never the request/response content). `attempts` is empty and `ranMs` is 0 for the verifier when the generator itself failed (the verifier never ran at all). */
export type GenerateVerifyStageDiagnostics = { attempts: ProviderCallAttemptLog[]; ranMs: number };

export type GenerateVerifyDiagnostics = {
  generator: GenerateVerifyStageDiagnostics;
  verifier: GenerateVerifyStageDiagnostics;
};

export type GenerateVerifyOutcome =
  | { kind: "approved"; response: string; riskScore: number; riskCodes: RiskCode[]; diagnostics: GenerateVerifyDiagnostics }
  // `reason` (concept-explanation quality follow-up) is the verifier's own
  // short internal audit note — never quotes hidden reference material or
  // student-facing text (see aiAssistanceVerifier.ts's buildSystemPrompt) —
  // carried through ONLY for the diagnostics log below, so a future
  // over-rejection report can be traced to its actual cause instead of
  // reconstructed by re-reading prompts after the fact. Never persisted to
  // the database and never shown to the student.
  | { kind: "rejected"; riskScore: number; riskCodes: RiskCode[]; reason: string; diagnostics: GenerateVerifyDiagnostics }
  | { kind: "error"; stage: "generator" | "verifier"; category: AiProviderErrorCategory; diagnostics: GenerateVerifyDiagnostics };

/**
 * Exported for direct unit testing (mocked generator/verifier, no
 * Prisma) — see aiAssistanceRunner.test.ts. Never exported for use
 * outside this module in production code.
 *
 * Every failure mode collapses to `{ kind: "error" }` — a thrown
 * generator/verifier error (missing config, timeout, malformed JSON,
 * unknown risk code, empty output) is caught HERE, not left to escape to
 * the caller, so the caller never needs its own try/catch around a
 * provider call. `stage` records WHICH service failed (intermittent-
 * failure follow-up) — src/lib/aiAssistanceRunner.ts's runAiAssistanceRequest
 * uses this to distinguish "the generator never even produced a
 * candidate" (stays FAILED) from "a candidate was produced but the
 * safety check itself couldn't complete" (falls back to the deterministic
 * safe guidance instead — see that function's own doc comment). A
 * verified-but-too-long response is treated as `"rejected"` (Part 9 —
 * never truncated, always re-attempted or replaced by the fallback
 * instead).
 */
export async function attemptGenerateAndVerify(params: {
  generatorInput: BrainstormGeneratorInput;
  question: { text: string; type: string; correctAnswer: string | null };
  policy: Pick<AiAssistancePolicy, "maxResponseCharacters">;
  studentPrompt: string;
  approvedCountForQuestion: number;
  cumulativeSoFar: number;
}): Promise<GenerateVerifyOutcome> {
  const generatorAttempts: ProviderCallAttemptLog[] = [];
  const verifierAttempts: ProviderCallAttemptLog[] = [];
  const verifierDiagnostics: GenerateVerifyStageDiagnostics = { attempts: verifierAttempts, ranMs: 0 };

  let candidate: string;
  const generatorStartedAtMs = Date.now();
  try {
    candidate = await generateBrainstormResponse(params.generatorInput, { onAttempt: (log) => generatorAttempts.push(log) });
  } catch (err) {
    const category = err instanceof AiAssistanceGenerationError ? err.category : "UNKNOWN";
    return {
      kind: "error",
      stage: "generator",
      category,
      diagnostics: { generator: { attempts: generatorAttempts, ranMs: Date.now() - generatorStartedAtMs }, verifier: verifierDiagnostics },
    };
  }
  const generatorDiagnostics: GenerateVerifyStageDiagnostics = { attempts: generatorAttempts, ranMs: Date.now() - generatorStartedAtMs };

  let verifierResult;
  const verifierStartedAtMs = Date.now();
  try {
    verifierResult = await verifyBrainstormResponse(
      {
        questionText: params.question.text,
        questionType: params.generatorInput.questionType,
        candidateResponse: candidate,
        studentRequest: params.studentPrompt,
        // The verifier alone may see hidden reference material; the
        // generator (params.generatorInput above) never received it.
        hiddenModelAnswer: boundedHiddenReference(params.question.correctAnswer),
        hiddenRubricSummary: null,
        // Grounded-cumulative-safety follow-up (MUST HAVE) — calibration
        // only, never a safety bypass (see buildSystemPrompt's own
        // per-mode notes in aiAssistanceVerifier.ts). Reuses the SAME
        // mode already computed for the generator — never a second,
        // independent classification.
        requestMode: params.generatorInput.requestMode,
        priorApprovedHintCount: params.approvedCountForQuestion,
        cumulativeRiskScoreSoFar: params.cumulativeSoFar,
        // Cumulative answer-assembly follow-up — derived from the SAME
        // question-scoped list already fetched once for the generator
        // (params.generatorInput.priorApprovedInteractions), never a
        // second query — so the verifier can judge whether this
        // candidate, combined with what was already approved, now
        // assembles the substantive content an open-response question
        // requires.
        priorApprovedResponses: params.generatorInput.priorApprovedInteractions.map((turn) => turn.approvedResponse),
      },
      { onAttempt: (log) => verifierAttempts.push(log) },
    );
  } catch (err) {
    const category = err instanceof AiAssistanceVerificationError ? err.category : "UNKNOWN";
    verifierDiagnostics.ranMs = Date.now() - verifierStartedAtMs;
    return { kind: "error", stage: "verifier", category, diagnostics: { generator: generatorDiagnostics, verifier: verifierDiagnostics } };
  }
  verifierDiagnostics.ranMs = Date.now() - verifierStartedAtMs;
  const diagnostics: GenerateVerifyDiagnostics = { generator: generatorDiagnostics, verifier: verifierDiagnostics };

  const projectedCumulative = nextCumulativeRiskScore(params.cumulativeSoFar, verifierResult.riskScore);
  const cumulativeOverride = isCumulativeHintLeakageRisk(projectedCumulative);
  const lengthValid = isApprovedResponseLengthValid(candidate, params.policy);
  const riskCodes = cumulativeOverride
    ? [...verifierResult.riskCodes.filter((c) => c !== "CUMULATIVE_HINT_LEAKAGE"), "CUMULATIVE_HINT_LEAKAGE" as RiskCode]
    : verifierResult.riskCodes;

  if (verifierResult.allowed && !cumulativeOverride && lengthValid) {
    return { kind: "approved", response: candidate, riskScore: verifierResult.riskScore, riskCodes, diagnostics };
  }
  return { kind: "rejected", riskScore: verifierResult.riskScore, riskCodes, reason: verifierResult.reason, diagnostics };
}
