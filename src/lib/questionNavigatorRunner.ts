/**
 * Question Navigator v1 — server-only orchestration. See
 * docs/question-navigator-v1.md.
 *
 * Touches Prisma, so it must never be imported from a "use client"
 * component — all navigation-authorisation and state-derivation logic
 * lives in src/lib/questionNavigator.ts instead (pure, unit-testable
 * without a database). This module only wires that logic to the DB and
 * enforces access control.
 *
 * SECURITY: every function here returns ONLY the safe metadata described
 * in docs/question-navigator-v1.md — question text, options, correct
 * answers, unselected pool questions, and other students' state are
 * never touched, let alone returned.
 */
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, questionPoolsActive, severityFor, type SecureExamSettings } from "@/lib/secureExam";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import {
  deriveQuestionNavigatorState,
  summariseQuestionProgress,
  canNavigateToQuestion,
  type QuestionStateInput,
  type QuestionType,
} from "@/lib/questionNavigator";

export class QuestionNavigatorError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Loads and validates everything needed to build the navigator DTO or
 * authorise a navigation/flag request: ownership, IN_PROGRESS status,
 * the persisted selected/ordered question set (never unselected pool
 * questions), each question's type, each question's saved response
 * (used only to derive answered/unanswered — never returned as text),
 * and this submission's visit/flag state rows.
 */
async function loadNavigatorContext(submissionId: string, studentId: string) {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      exam: { include: { questions: { orderBy: { order: "asc" } } } },
      answers: { select: { questionId: true, response: true } },
      questionStates: true,
    },
  });
  if (!submission || submission.studentId !== studentId) {
    throw new QuestionNavigatorError(404, "Not found");
  }

  const settings = parseSecureSettings(submission.exam.secureSettings);
  const originalIds = submission.exam.questions.map((q) => q.id);
  const orderedIds = resolveEffectiveQuestionIds({
    examQuestionIds: originalIds,
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });
  const questionById = new Map(submission.exam.questions.map((q) => [q.id, q]));
  const answerByQuestionId = new Map(submission.answers.map((a) => [a.questionId, a.response]));
  const stateByQuestionId = new Map(submission.questionStates.map((s) => [s.questionId, s]));

  return { submission, settings, orderedIds, questionById, answerByQuestionId, stateByQuestionId };
}

type NavigatorContextResult = Awaited<ReturnType<typeof loadNavigatorContext>>;

function buildQuestionStateInputs(ctx: NavigatorContextResult): QuestionStateInput[] {
  return ctx.orderedIds.map((questionId) => {
    const question = ctx.questionById.get(questionId);
    const state = ctx.stateByQuestionId.get(questionId);
    return {
      questionId,
      questionType: (question?.type ?? "SHORT_ANSWER") as QuestionType,
      response: ctx.answerByQuestionId.get(questionId) ?? null,
      visited: state != null && state.firstVisitedAt != null,
      flaggedForReview: state?.flaggedForReview ?? false,
    };
  });
}

export type NavigatorSettingsDto = {
  showQuestionNavigator: boolean;
  allowQuestionJumping: boolean;
  allowBackNavigation: boolean;
  allowFlagForReview: boolean;
};

export type NavigatorQuestionDto = {
  questionId: string;
  index: number;
  number: number;
  state: string;
  flaggedForReview: boolean;
  locked: boolean;
  canNavigate: boolean;
};

export type NavigatorResponseDto = {
  submissionId: string;
  currentQuestionIndex: number;
  totalQuestions: number;
  settings: NavigatorSettingsDto;
  progress: {
    answeredCount: number;
    unansweredCount: number;
    flaggedCount: number;
    visitedCount: number;
  };
  questions: NavigatorQuestionDto[];
};

/** GET /api/submissions/[id]/question-navigator */
export async function buildQuestionNavigatorResponse(submissionId: string, studentId: string): Promise<NavigatorResponseDto> {
  const ctx = await loadNavigatorContext(submissionId, studentId);
  const tiles = deriveQuestionNavigatorState(buildQuestionStateInputs(ctx), {
    currentIndex: ctx.submission.currentQuestionIndex,
    allowQuestionJumping: ctx.settings.allowQuestionJumping,
    allowBackNavigation: ctx.settings.allowBackNavigation,
    submissionInProgress: ctx.submission.status === "IN_PROGRESS",
  });
  const progress = summariseQuestionProgress(tiles);

  return {
    submissionId: ctx.submission.id,
    currentQuestionIndex: ctx.submission.currentQuestionIndex,
    totalQuestions: tiles.length,
    settings: {
      showQuestionNavigator: ctx.settings.showQuestionNavigator,
      allowQuestionJumping: ctx.settings.allowQuestionJumping,
      allowBackNavigation: ctx.settings.allowBackNavigation,
      allowFlagForReview: ctx.settings.allowFlagForReview,
    },
    progress: {
      answeredCount: progress.answeredCount,
      unansweredCount: progress.unansweredCount,
      flaggedCount: progress.flaggedCount,
      visitedCount: progress.visitedCount,
    },
    questions: tiles.map((t) => ({
      questionId: t.questionId,
      index: t.index,
      number: t.number,
      state: t.state,
      flaggedForReview: t.flaggedForReview,
      locked: t.locked,
      canNavigate: t.canNavigate,
    })),
  };
}

/**
 * Idempotent upsert — marks a question visited (firstVisitedAt set only
 * once, lastVisitedAt always refreshed). Called whenever a question
 * actually becomes the delivered current question (first open, Next/
 * Previous, or an authorised direct jump) — never for a question whose
 * content was never actually shown.
 */
export async function markQuestionVisited(submissionId: string, questionId: string): Promise<void> {
  const now = new Date();
  await prisma.submissionQuestionState.upsert({
    where: { submissionId_questionId: { submissionId, questionId } },
    update: { lastVisitedAt: now },
    create: { submissionId, questionId, firstVisitedAt: now, lastVisitedAt: now },
  });
  // firstVisitedAt must only ever be set once — the upsert above always
  // refreshes it on create, but a create() with an existing row (a race
  // between two near-simultaneous requests) is impossible under the
  // unique constraint, so no separate "set if null" step is needed.
}

/**
 * Authorises and applies a direct (GOTO) navigation request. Never
 * trusts a client-supplied questionId — resolution is always by index
 * into the submission's persisted selected/ordered question set.
 * Returns the resolved target index on success; throws
 * QuestionNavigatorError (with the exact status/message Part 6
 * recommends) on any rejection, after logging the appropriate
 * integrity event.
 */
export async function authoriseDirectNavigation(
  submissionId: string,
  studentId: string,
  targetIndex: number,
): Promise<{ ctx: NavigatorContextResult; finalIndex: number }> {
  const ctx = await loadNavigatorContext(submissionId, studentId);
  if (ctx.submission.status !== "IN_PROGRESS") {
    throw new QuestionNavigatorError(409, "Submission is no longer in progress");
  }

  const currentIndex = ctx.submission.currentQuestionIndex;
  const total = ctx.orderedIds.length;
  const check = canNavigateToQuestion({
    targetIndex,
    currentIndex,
    totalQuestions: total,
    allowQuestionJumping: ctx.settings.allowQuestionJumping,
    allowBackNavigation: ctx.settings.allowBackNavigation,
    submissionInProgress: true,
  });

  await logDirectNavigationEvent(ctx, currentIndex, targetIndex, check.allowed, ctx.settings);

  if (!check.allowed) {
    if (check.reasonCode === "INVALID_INDEX") throw new QuestionNavigatorError(400, "Invalid question position");
    if (check.reasonCode === "BACK_NAVIGATION_NOT_ALLOWED") {
      throw new QuestionNavigatorError(403, "Back navigation is not allowed for this exam");
    }
    throw new QuestionNavigatorError(403, "Direct question navigation is not allowed for this exam");
  }

  if (targetIndex !== currentIndex) {
    await prisma.submission.update({ where: { id: ctx.submission.id }, data: { currentQuestionIndex: targetIndex } });
    ctx.submission.currentQuestionIndex = targetIndex;
  }
  const targetQuestionId = ctx.orderedIds[targetIndex];
  if (targetQuestionId) markQuestionVisited(ctx.submission.id, targetQuestionId).catch(() => {});

  return { ctx, finalIndex: targetIndex };
}

async function logDirectNavigationEvent(
  ctx: NavigatorContextResult,
  fromIndex: number,
  toIndex: number,
  permitted: boolean,
  settings: SecureExamSettings,
): Promise<void> {
  // A no-op "navigate to the same question" is never logged — nothing
  // actually happened.
  if (fromIndex === toIndex) return;
  const eventType = permitted ? "QUESTION_NAVIGATED_DIRECT" : "QUESTION_DIRECT_NAVIGATION_BLOCKED";
  await prisma.integrityEvent
    .create({
      data: {
        submissionId: ctx.submission.id,
        examId: ctx.submission.examId,
        studentId: ctx.submission.studentId,
        eventType,
        severity: severityFor(eventType, settings),
        message: permitted
          ? "Moved directly to a different question via the navigator."
          : "A direct question-navigation request was not permitted by this exam's settings.",
        occurredAt: new Date(),
        // Only index metadata — never question text or answer text.
        metadataJson: { fromIndex, toIndex, navigationType: "DIRECT", permitted },
      },
    })
    .catch(() => {
      // Navigation logging is best-effort — never blocks the student.
    });
}

export type NavigatorQuestionStateDto = {
  questionId: string;
  flaggedForReview: boolean;
};

/** PATCH /api/submissions/[id]/question-state/[questionId] */
export async function setQuestionFlag(
  submissionId: string,
  studentId: string,
  questionId: string,
  flaggedForReview: boolean,
): Promise<NavigatorQuestionStateDto> {
  const ctx = await loadNavigatorContext(submissionId, studentId);
  if (ctx.submission.status !== "IN_PROGRESS") {
    throw new QuestionNavigatorError(409, "Submission is no longer in progress");
  }
  if (!ctx.settings.allowFlagForReview) {
    throw new QuestionNavigatorError(403, "Flagging questions for review is not allowed for this exam");
  }
  // Never accept an arbitrary submission/question combination — the
  // question must actually belong to THIS submission's persisted
  // selected/ordered question set.
  if (!ctx.orderedIds.includes(questionId)) {
    throw new QuestionNavigatorError(400, "This question is not part of your exam attempt");
  }

  const now = new Date();
  const updated = await prisma.submissionQuestionState.upsert({
    where: { submissionId_questionId: { submissionId, questionId } },
    update: { flaggedForReview, lastVisitedAt: now },
    create: { submissionId, questionId, flaggedForReview, firstVisitedAt: null, lastVisitedAt: now },
  });

  return { questionId, flaggedForReview: updated.flaggedForReview };
}
