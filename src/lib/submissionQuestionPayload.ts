/**
 * One-Question-At-A-Time Exam Delivery v1 — server-only helpers shared by
 * GET /api/submissions/[id]/question and
 * POST /api/submissions/[id]/question-progress. See
 * docs/one-question-delivery-v1.md.
 *
 * Deliberately NOT in src/lib/questionDelivery.ts (which stays pure/
 * client-safe, no Prisma) — this module touches the database and must
 * never be imported from a "use client" component.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { parseSecureSettings, questionPoolsActive, type SecureExamSettings } from "@/lib/secureExam";
import {
  canNavigateNext,
  canNavigatePrevious,
  clampQuestionIndex,
  isBlockedBackNavigation,
  nextAllowedIndex,
  resolveEffectiveQuestionIds,
  resolveOptionOrder,
} from "@/lib/questionDelivery";
import { isSubmissionContentAccessible, EXAM_NOT_ACTIVATED_CODE, EXAM_NOT_ACTIVATED_MESSAGE } from "@/lib/secureClientActivation";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import {
  checkTetherContentAccessLease,
  readContentAccessLeaseCookieFromRequest,
  TETHER_CONTENT_ACCESS_REQUIRED_CODE,
  TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE,
  type ContentAccessDecision,
} from "@/lib/secureClient/requireTetherContentAccess";

export class OneQuestionModeError extends Error {
  status: number;
  /** v1.7.4 pre-exam readiness — optional machine-readable code (e.g. EXAM_NOT_ACTIVATED) so a caller can distinguish this from an ordinary "not found"/"disabled" error without string-matching the message. */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type SubmissionWithQuestions = NonNullable<Awaited<ReturnType<typeof loadOneQuestionSubmission>>>["submission"];

/**
 * Loads the submission (with exam questions + answers) for the
 * one-question-mode routes, and validates: exists, owned by this
 * student, still IN_PROGRESS, and the exam actually has
 * oneQuestionAtATime enabled. Throws OneQuestionModeError with the
 * correct HTTP status for the caller to return directly.
 *
 * `req` is required so this can also enforce the release-blocking
 * server content-boundary lease (see tetherContentAccessLease.ts) for a
 * TETHER_CLIENT_REQUIRED/SEB_REQUIRED submission — isSubmissionContentAccessible
 * above only proves the submission itself is activated, never that THIS
 * request originates from the Tether/SEB instance that activated it.
 */
export async function loadOneQuestionSubmission(submissionId: string, studentId: string, req: Request) {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      exam: { include: { questions: { orderBy: { order: "asc" } } } },
      answers: true,
    },
  });
  if (!submission || submission.studentId !== studentId) {
    throw new OneQuestionModeError(404, "Not found");
  }
  if (submission.status !== "IN_PROGRESS") {
    throw new OneQuestionModeError(409, "This submission is no longer active");
  }
  // v1.7.4 pre-exam readiness — same server-authoritative content gate as
  // GET /api/submissions/[id]; see src/lib/secureClientActivation.ts.
  // A gated attempt that has not yet been server-activated must never
  // leak a question's text/options through this one-question-at-a-time
  // path, even though the main submission GET already blocks it too.
  if (!isSubmissionContentAccessible(submission)) {
    throw new OneQuestionModeError(403, EXAM_NOT_ACTIVATED_MESSAGE, EXAM_NOT_ACTIVATED_CODE);
  }
  // Release-blocking server content-boundary audit — see
  // tetherContentAccessLease.ts. Additive to isSubmissionContentAccessible
  // above, never a replacement: closes the gap where an ordinary,
  // separately-authenticated Chrome/Edge request could otherwise receive
  // question text/options merely because a verified, activated
  // TETHER_CLIENT_REQUIRED submission exists somewhere. Scoped to
  // TETHER_CLIENT_REQUIRED only — a lease is only ever mintable via
  // native Tether installation-key proof, which SAFE_EXAM_BROWSER has no
  // equivalent of; see requireTetherContentAccess.ts's own doc comment.
  // Performance follow-up (physical acceptance review) — surfaced to the
  // caller so its success response can renew straight from THIS decision
  // (see renewContentAccessLeaseFromValidatedDecision's own doc comment)
  // instead of re-running the whole check a second time. This backs every
  // one-question-mode navigation, so avoiding a redundant Ed25519 verify +
  // DB read here matters for click-to-next-question latency.
  let leaseDecision: ContentAccessDecision | null = null;
  const clientPolicy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  if (clientPolicy.deliveryMode === "TETHER_CLIENT_REQUIRED") {
    leaseDecision = await checkTetherContentAccessLease(readContentAccessLeaseCookieFromRequest(req), {
      submissionId: submission.id,
      studentId,
    });
    if (!leaseDecision.ok) {
      throw new OneQuestionModeError(403, TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE, TETHER_CONTENT_ACCESS_REQUIRED_CODE);
    }
  }
  const settings = parseSecureSettings(submission.exam.secureSettings);
  if (!settings.oneQuestionAtATime) {
    throw new OneQuestionModeError(
      400,
      "One-question-at-a-time delivery is not enabled for this exam",
    );
  }
  return { submission, settings, leaseDecision };
}

type DbClient = Prisma.TransactionClient | typeof prisma;

export type SequentialNavigationEventType = "QUESTION_BACK_NAVIGATION_BLOCKED" | "QUESTION_NAVIGATED_NEXT" | "QUESTION_NAVIGATED_PREVIOUS";

export type SequentialNavigationResult = {
  finalIndex: number;
  storedIndex: number;
  blocked: boolean;
  /** null when the resolved index didn't actually move (e.g. already at index 0 requesting Previous) — the caller logs telemetry only when non-null, exactly matching the pre-extraction behaviour. */
  eventType: SequentialNavigationEventType | null;
  /** Unconditional — the question now AT finalIndex, whether or not the position actually changed this call, mirroring the pre-extraction behaviour (Question Navigator "visited" tracking always reflects the resolved position). */
  visitedQuestionId: string | null;
};

/**
 * Question-navigation performance follow-up — single-round-trip
 * save+navigate. Extracted out of the sequential (non-GOTO) branch of
 * POST /api/submissions/[id]/question-progress so that route AND POST
 * /api/submissions/[id]/save-and-navigate share the exact same
 * back-navigation/question-pool clamping semantics — never two
 * independently-drifting implementations.
 *
 * Accepts a Prisma client OR an interactive-transaction client (mirrors
 * saveAnswerWithIdempotency in answerSaveRunner.ts) — question-progress
 * itself calls this with the plain `prisma` singleton (its own
 * currentQuestionIndex update was never transactional, and stays exactly
 * that way here), while save-and-navigate calls this from INSIDE the same
 * transaction as its own answer save, so the two either both commit or
 * both roll back together.
 *
 * Never touches lease/activation/ownership checks — the caller is
 * responsible for having already validated those (every current/future
 * caller does, via loadOneQuestionSubmission).
 */
export async function resolveSequentialQuestionNavigation(
  db: DbClient,
  params: { submission: SubmissionWithQuestions; settings: Pick<SecureExamSettings, "allowBackNavigation" | "enableQuestionPools" | "questionPoolSelectionMode">; requestedIndex: number },
): Promise<SequentialNavigationResult> {
  const { submission, settings, requestedIndex } = params;
  const storedIndex = submission.currentQuestionIndex;
  // Question Pools v1 — total/order is the SELECTED question set for this
  // submission when pools are active, never the full exam/pool question
  // count. See docs/question-pools-v1.md. Computed once and reused for
  // both `total` and the visited-question lookup below (the
  // pre-extraction code computed this twice with identical arguments).
  const orderedIds = resolveEffectiveQuestionIds({
    examQuestionIds: submission.exam.questions.map((q) => q.id),
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });
  const total = orderedIds.length;

  const blocked = isBlockedBackNavigation(requestedIndex, storedIndex, settings.allowBackNavigation);
  const finalIndex = nextAllowedIndex(requestedIndex, storedIndex, settings.allowBackNavigation, total);

  if (finalIndex !== storedIndex) {
    await db.submission.update({ where: { id: submission.id }, data: { currentQuestionIndex: finalIndex } });
  }

  const eventType: SequentialNavigationEventType | null = blocked
    ? "QUESTION_BACK_NAVIGATION_BLOCKED"
    : finalIndex > storedIndex
      ? "QUESTION_NAVIGATED_NEXT"
      : finalIndex < storedIndex
        ? "QUESTION_NAVIGATED_PREVIOUS"
        : null;

  return { finalIndex, storedIndex, blocked, eventType, visitedQuestionId: orderedIds[finalIndex] ?? null };
}

export type OneQuestionPayload = {
  currentIndex: number;
  totalQuestions: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  question: {
    id: string;
    type: string;
    text: string;
    options: string[] | null;
    points: number;
  };
  existingResponse: string | null;
};

/**
 * Builds the safe, client-facing payload for one specific index: never
 * includes correctAnswer, never includes other questions, never includes
 * the raw questionOrderJson/any randomisation internals — only the
 * already-resolved order is ever used to pick which single question to
 * return.
 */
export function buildOneQuestionPayload(
  submission: SubmissionWithQuestions,
  settings: Pick<
    SecureExamSettings,
    "allowBackNavigation" | "enableQuestionPools" | "questionPoolSelectionMode"
  >,
  index: number,
): OneQuestionPayload | null {
  const originalIds = submission.exam.questions.map((q) => q.id);
  const orderedIds = resolveEffectiveQuestionIds({
    examQuestionIds: originalIds,
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });
  const total = orderedIds.length;
  const clampedIndex = clampQuestionIndex(index, total);
  const questionId = orderedIds[clampedIndex];
  const question = submission.exam.questions.find((q) => q.id === questionId);
  if (!question) return null;

  const originalOptions = (question.options as string[] | null) ?? null;
  const options = originalOptions
    ? resolveOptionOrder(question.id, originalOptions, submission.questionOrderJson)
    : null;
  const existingAnswer = submission.answers.find((a) => a.questionId === question.id);

  return {
    currentIndex: clampedIndex,
    totalQuestions: total,
    canGoPrevious: canNavigatePrevious(clampedIndex, settings.allowBackNavigation),
    canGoNext: canNavigateNext(clampedIndex, total),
    question: {
      id: question.id,
      type: question.type,
      text: question.text,
      options,
      points: question.points,
    },
    existingResponse: existingAnswer?.response ?? null,
  };
}
