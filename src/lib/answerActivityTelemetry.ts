/**
 * Exam Session Binding v1 — coarse answer-activity telemetry. See
 * docs/exam-session-binding-v1.md.
 *
 * Server-only, touches Prisma. Never stores keystrokes, clipboard
 * content, or a duplicate of the full answer text — only a length, an
 * HMAC hash of the response (change-detection only, never
 * reconstruction), and a length delta from the prior saved version.
 * serverReceivedAt (set by Prisma's @default(now())) is authoritative;
 * clientElapsedMs is supplementary only. Every function here is
 * best-effort and must never throw in a way that could fail the caller's
 * answer save, navigation, or submission.
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { hmacHash } from "@/lib/sessionBinding";

export type SimpleActivityEventType =
  | "ATTEMPT_STARTED"
  | "QUESTION_OPENED"
  | "QUESTION_NAVIGATED"
  | "HEARTBEAT"
  | "PAGE_HIDDEN"
  | "PAGE_VISIBLE"
  | "ATTEMPT_SUBMITTED";

/**
 * Records one ANSWER_SAVED telemetry row for the existing answer
 * autosave flow. Computes the length delta from the prior ANSWER_SAVED
 * event for the same question (not from the Answer table itself, so
 * telemetry never needs to re-read the answer's full text). Never
 * throws — failure here must never lose the student's saved answer.
 */
export async function recordAnswerSavedActivity(opts: {
  submissionId: string;
  questionId: string;
  examAttemptSessionId: string | null;
  response: string;
  clientElapsedMs?: number | null;
}): Promise<void> {
  try {
    const responseLength = opts.response.length;
    const responseHash = hmacHash(opts.response);
    const prior = await prisma.answerActivityEvent.findFirst({
      where: { submissionId: opts.submissionId, questionId: opts.questionId, eventType: "ANSWER_SAVED" },
      orderBy: { serverReceivedAt: "desc" },
      select: { id: true, responseLength: true },
    });
    const responseLengthDelta = responseLength - (prior?.responseLength ?? 0);

    await prisma.answerActivityEvent.create({
      data: {
        submissionId: opts.submissionId,
        questionId: opts.questionId,
        examAttemptSessionId: opts.examAttemptSessionId,
        eventType: "ANSWER_SAVED",
        clientElapsedMs: opts.clientElapsedMs ?? null,
        responseLength,
        responseHash,
        responseLengthDelta,
        previousEventId: prior?.id ?? null,
      },
    });
  } catch {
    // Telemetry must never break the answer save.
  }
}

/**
 * Records a simple, non-response-carrying activity event (navigation,
 * visibility change, heartbeat marker, attempt start/submit). Supports
 * an optional dedup window to rate-limit near-duplicate events of the
 * same type/question (Part 8 — "deduplicate excessive events").
 */
export async function recordSimpleActivityEvent(opts: {
  submissionId: string;
  examAttemptSessionId?: string | null;
  questionId?: string | null;
  eventType: SimpleActivityEventType;
  questionIndex?: number | null;
  clientElapsedMs?: number | null;
  metadata?: Record<string, unknown> | null;
  /** Skip creating a new row if an identical eventType+questionId event was recorded within this many ms. */
  dedupeWindowMs?: number;
}): Promise<void> {
  try {
    if (opts.dedupeWindowMs) {
      const recent = await prisma.answerActivityEvent.findFirst({
        where: {
          submissionId: opts.submissionId,
          eventType: opts.eventType,
          questionId: opts.questionId ?? null,
          serverReceivedAt: { gte: new Date(Date.now() - opts.dedupeWindowMs) },
        },
        select: { id: true },
      });
      if (recent) return;
    }

    await prisma.answerActivityEvent.create({
      data: {
        submissionId: opts.submissionId,
        examAttemptSessionId: opts.examAttemptSessionId ?? null,
        questionId: opts.questionId ?? null,
        eventType: opts.eventType,
        questionIndex: opts.questionIndex ?? null,
        clientElapsedMs: opts.clientElapsedMs ?? null,
        metadataJson: (opts.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    });
  } catch {
    // Telemetry must never break exam flow.
  }
}
