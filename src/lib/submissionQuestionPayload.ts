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
import { parseSecureSettings, type SecureExamSettings } from "@/lib/secureExam";
import {
  canNavigateNext,
  canNavigatePrevious,
  clampQuestionIndex,
  resolveOptionOrder,
  resolveQuestionOrder,
} from "@/lib/questionDelivery";

export class OneQuestionModeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type SubmissionWithQuestions = NonNullable<Awaited<ReturnType<typeof loadOneQuestionSubmission>>>["submission"];

/**
 * Loads the submission (with exam questions + answers) for the
 * one-question-mode routes, and validates: exists, owned by this
 * student, still IN_PROGRESS, and the exam actually has
 * oneQuestionAtATime enabled. Throws OneQuestionModeError with the
 * correct HTTP status for the caller to return directly.
 */
export async function loadOneQuestionSubmission(submissionId: string, studentId: string) {
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
  const settings = parseSecureSettings(submission.exam.secureSettings);
  if (!settings.oneQuestionAtATime) {
    throw new OneQuestionModeError(
      400,
      "One-question-at-a-time delivery is not enabled for this exam",
    );
  }
  return { submission, settings };
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
  settings: Pick<SecureExamSettings, "allowBackNavigation">,
  index: number,
): OneQuestionPayload | null {
  const originalIds = submission.exam.questions.map((q) => q.id);
  const orderedIds = resolveQuestionOrder(originalIds, submission.questionOrderJson);
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
