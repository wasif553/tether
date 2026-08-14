/**
 * Question-navigation performance follow-up — single-round-trip
 * save+navigate. See docs/one-question-delivery-v1.md and
 * docs/tether-secure-resume-recovery-v1.md.
 *
 * POST /api/submissions/[id]/save-and-navigate
 *
 * Combines what was previously two separate client requests for the
 * common "Next"/"Previous" case — PATCH /answers followed by POST
 * /question-progress — into ONE, for a DIRTY (not-yet-server-
 * acknowledged) current answer. Reuses the exact same answer-save
 * (saveAnswerWithIdempotency, src/lib/answerSaveRunner.ts) and
 * question-navigation (resolveSequentialQuestionNavigation,
 * src/lib/submissionQuestionPayload.ts) logic those two routes already
 * use — never a second, independently-drifting implementation. Every
 * ownership/activation/lease/oneQuestionAtATime check is the SAME one
 * loadOneQuestionSubmission already performs for GET /question and POST
 * /question-progress; this route makes no additional or different
 * assumption about delivery mode (TETHER_CLIENT_REQUIRED, SEB_REQUIRED,
 * STANDARD_WEB, ...) than those existing routes already enforce.
 *
 * The answer write and the question-index advancement run inside ONE
 * database transaction — either both commit or neither does. The next
 * question is NEVER included in the response unless the answer save has
 * already committed (including an idempotent replay/stale-revision
 * no-op — both are genuine acknowledged states, just not this exact
 * revision's own write); an invalid question rolls the whole transaction
 * back and returns an error with no index mutation at all.
 *
 * GOTO (grid-tile direct jump) is intentionally NOT handled here — see
 * question-progress/route.ts's own doc comment: it is authorised through
 * a distinct, stricter path (authoriseDirectNavigation), is a much lower-
 * frequency action, and combining it was out of scope for this
 * high-frequency Next/Previous latency optimization.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, severityFor } from "@/lib/secureExam";
import { resolveSubmissionTimingPolicy, submissionDeadline } from "@/lib/assessmentLifecycle";
import { recordAnswerSavedActivity, recordSimpleActivityEvent } from "@/lib/answerActivityTelemetry";
import { findMostRecentSessionId } from "@/lib/examAttemptSessionRunner";
import { markQuestionVisited } from "@/lib/questionNavigatorRunner";
import { saveAnswerWithIdempotency } from "@/lib/answerSaveRunner";
import {
  buildOneQuestionPayload,
  loadOneQuestionSubmission,
  resolveSequentialQuestionNavigation,
  OneQuestionModeError,
} from "@/lib/submissionQuestionPayload";
import { renewContentAccessLeaseFromValidatedDecision } from "@/lib/secureClient/requireTetherContentAccess";
import { logServerTetherDiagnostic } from "@/lib/tetherDiagnosticLog";

const bodySchema = z.object({
  questionId: z.string(),
  response: z.string(),
  clientRequestId: z.string().min(1).max(200).optional(),
  clientRevision: z.number().int().min(0).max(1_000_000_000).optional(),
  // Same field name/semantics as POST /question-progress's own
  // `currentIndex` — the client's requested TARGET index, clamped
  // server-side against the stored index exactly like that route already
  // does (nextAllowedIndex/isBlockedBackNavigation).
  currentIndex: z.number().int().min(0),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const timingStartMs = performance.now();
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { questionId, response, clientRequestId, clientRevision, currentIndex: requestedIndex } = parsed.data;

  let context;
  try {
    context = await loadOneQuestionSubmission(id, session.user.id, req);
  } catch (err) {
    if (err instanceof OneQuestionModeError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
  const { submission, settings, leaseDecision } = context;

  // Same deadline enforcement as PATCH /answers — see that route's own
  // comment. Not part of loadOneQuestionSubmission itself, which is also
  // used by the read-only GET /question route where a deadline check
  // doesn't apply.
  const timingPolicy = resolveSubmissionTimingPolicy({
    examPolicySnapshotJson: submission.examPolicySnapshotJson,
    currentExamDurationMins: submission.exam.durationMins,
    currentSecureSettings: parseSecureSettings(submission.exam.secureSettings),
  });
  const deadline = submissionDeadline(submission.startedAt, timingPolicy.durationMins);
  if (new Date() > deadline && !timingPolicy.allowLateSubmit) {
    return NextResponse.json({ error: "Time is up" }, { status: 409 });
  }

  // The answer write and the index advancement are ONE atomic unit: if
  // the answer turns out to be for an invalid question, NOTHING commits —
  // never a navigated index with no corresponding save, and never a
  // saved-but-navigation-desynced state either. Preserves the exact same
  // per-(submission,question) advisory-lock concurrency protection
  // saveAnswerWithIdempotency already provides; the index update inside
  // the same transaction only ever touches the Submission row (a
  // different lock than the advisory one), always acquired AFTER the
  // advisory lock in every caller — a single, consistent acquisition
  // order, so this introduces no new deadlock pattern.
  const transactionStartMs = performance.now();
  const outcome = await prisma.$transaction(async (tx) => {
    const saveResult = await saveAnswerWithIdempotency(tx, {
      submissionId: submission.id,
      examId: submission.examId,
      questionId,
      response,
      clientRequestId,
      clientRevision,
    });
    if (saveResult.kind === "invalid_question") return { kind: "invalid_question" as const };

    const nav = await resolveSequentialQuestionNavigation(tx, { submission, settings, requestedIndex });
    return { kind: "ok" as const, saveResult, nav };
  });
  const transactionMs = performance.now() - transactionStartMs;

  if (outcome.kind === "invalid_question") {
    return NextResponse.json({ error: "Invalid question" }, { status: 400 });
  }
  const { saveResult, nav } = outcome;
  const { answer, applied } = saveResult;
  const { finalIndex, eventType } = nav;

  // Best-effort telemetry — fire-and-forget, plain `prisma` (never the
  // transaction client), fired only AFTER the transaction has actually
  // committed. Exactly the SAME two sets of telemetry PATCH /answers and
  // POST /question-progress each already fire on their own success path
  // — this route performs both of those operations in one request, so it
  // fires both of those existing telemetry sets once each, never a third
  // independent copy.
  prisma.submission.update({ where: { id: submission.id }, data: { lastAutosaveAcknowledgedAt: new Date() } }).catch(() => {});
  if (applied) {
    findMostRecentSessionId(submission.id)
      .then((examAttemptSessionId) => recordAnswerSavedActivity({ submissionId: submission.id, questionId, examAttemptSessionId, response }))
      .catch(() => {});
  }
  if (eventType) {
    prisma.integrityEvent
      .create({
        data: {
          submissionId: submission.id,
          examId: submission.examId,
          studentId: submission.studentId,
          eventType,
          severity: severityFor(eventType, settings),
          message:
            eventType === "QUESTION_BACK_NAVIGATION_BLOCKED"
              ? "A request to return to an earlier question was blocked (back navigation disabled)."
              : eventType === "QUESTION_NAVIGATED_NEXT"
                ? "Moved to the next question."
                : "Moved to a previous question.",
          occurredAt: new Date(),
        },
      })
      .catch(() => {});
    recordSimpleActivityEvent({ submissionId: submission.id, eventType: "QUESTION_NAVIGATED", questionIndex: finalIndex, dedupeWindowMs: 2_000 }).catch(() => {});
  }
  if (nav.visitedQuestionId) markQuestionVisited(submission.id, nav.visitedQuestionId).catch(() => {});

  const payload = buildOneQuestionPayload(submission, settings, finalIndex);
  if (!payload) {
    return NextResponse.json({ error: "This exam has no questions" }, { status: 404 });
  }

  const jsonResponse = NextResponse.json({
    answer: {
      questionId: answer.questionId,
      response: answer.response,
      acknowledgedRevision: answer.clientRevision ?? null,
      acknowledgedRequestId: answer.lastClientRequestId ?? null,
    },
    navigation: payload,
  });

  // Rolling lease renewal, from the SAME decision loadOneQuestionSubmission
  // already computed — no second decode/verify/DB read (see
  // renewContentAccessLeaseFromValidatedDecision's own doc comment).
  if (leaseDecision) {
    renewContentAccessLeaseFromValidatedDecision(jsonResponse, leaseDecision, { submissionId: submission.id, studentId: submission.studentId });
  }

  logServerTetherDiagnostic("SAVE_AND_NAVIGATE_TIMING", {
    transactionMs: Math.round(transactionMs),
    totalMs: Math.round(performance.now() - timingStartMs),
  });

  return jsonResponse;
}

export const dynamic = "force-dynamic";
