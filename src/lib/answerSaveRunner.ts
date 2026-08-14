/**
 * Question-navigation performance follow-up — single-round-trip
 * save+navigate. See docs/tether-secure-resume-recovery-v1.md, "Autosave
 * idempotency and revision control" (Part 2).
 *
 * The answer-save core extracted out of PATCH /api/submissions/[id]/answers
 * so that route AND POST /api/submissions/[id]/save-and-navigate share the
 * exact same idempotency/revision/concurrency semantics — never two
 * independently-drifting implementations (see docs on that combined
 * route for why this exists).
 *
 * Accepts a Prisma client OR an interactive-transaction client (mirrors
 * DbClient in answerDevelopmentRunner.ts) so a caller that already holds
 * its own transaction (save-and-navigate, composing this write with the
 * question-index advancement into one atomic unit) can run this AS PART
 * of that same transaction, while PATCH /answers wraps a call to this in
 * its own single-purpose prisma.$transaction, unchanged in effect.
 *
 * MUST be called with a client that is INSIDE a transaction — the
 * pg_advisory_xact_lock below only serializes concurrent writers when
 * held for the duration of a real transaction; every existing/new call
 * site always wraps this in prisma.$transaction(async (tx) => ...).
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;
type Answer = Awaited<ReturnType<typeof prisma.answer.upsert>>;

export type AnswerSaveParams = {
  submissionId: string;
  examId: string;
  questionId: string;
  response: string;
  clientRequestId?: string | null;
  clientRevision?: number | null;
};

export type AnswerSaveResult = { kind: "invalid_question" } | { kind: "saved"; answer: Answer; applied: boolean };

export async function saveAnswerWithIdempotency(db: DbClient, params: AnswerSaveParams): Promise<AnswerSaveResult> {
  // Correctness pass (post-merge review) — an advisory lock scoped to
  // THIS (submission, question) pair, mirroring the existing
  // submission-scoped locks in secureClientRunner.ts/submit/route.ts.
  // Without this, two concurrent saves for the same question could both
  // read `existing` before either commits (each sees "no row yet" or the
  // same stale revision), so the revision-comparison guard below never
  // actually fires for either — and Prisma's upsert has no conditional
  // WHERE on its ON CONFLICT DO UPDATE, so whichever request's write
  // lands LAST at the database always wins, regardless of which one
  // carries the higher revision. Confirmed empirically (a scripted
  // 40-iteration concurrent-write test) before this fix: a lower
  // revision overwrote a higher one in ~25% of runs. The lock fully
  // serializes the read-decide-write section for this exact question, so
  // the application-level revision check is no longer racing a
  // concurrent writer — closing the gap at the transaction boundary, not
  // merely in application code.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.submissionId}), hashtext(${params.questionId}))`;

  const question = await db.question.findFirst({
    where: { id: params.questionId, examId: params.examId },
  });
  if (!question) return { kind: "invalid_question" };

  // Autosave idempotency and revision control (Part 2) — only engages
  // when the caller actually sends a clientRequestId; a caller that
  // never does (any client predating this feature) always falls through
  // to the plain upsert below, unchanged.
  if (params.clientRequestId) {
    const existing = await db.answer.findUnique({
      where: { submissionId_questionId: { submissionId: params.submissionId, questionId: params.questionId } },
    });
    if (existing) {
      // Retrying the SAME request returns the previous successful
      // acknowledgement — never writes again, never creates a duplicate
      // row (there is only ever one Answer row per submission+question,
      // enforced by the existing unique constraint either way).
      if (existing.lastClientRequestId === params.clientRequestId) {
        return { kind: "saved", answer: existing, applied: false };
      }
      // A revision that is not strictly greater than the currently
      // acknowledged one is a stale/duplicate arrival (network retry
      // racing a newer save, or reordering) — accepted as a no-op, the
      // current row is returned as-is, `response` is never regressed.
      if (params.clientRevision != null && existing.clientRevision != null && params.clientRevision <= existing.clientRevision) {
        return { kind: "saved", answer: existing, applied: false };
      }
    }
  }

  const answer = await db.answer.upsert({
    where: { submissionId_questionId: { submissionId: params.submissionId, questionId: params.questionId } },
    update: {
      response: params.response,
      lastClientRequestId: params.clientRequestId ?? undefined,
      clientRevision: params.clientRevision ?? undefined,
    },
    create: {
      submissionId: params.submissionId,
      questionId: params.questionId,
      response: params.response,
      lastClientRequestId: params.clientRequestId ?? null,
      clientRevision: params.clientRevision ?? null,
    },
  });
  return { kind: "saved", answer, applied: true };
}
