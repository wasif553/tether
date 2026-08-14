import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings } from "@/lib/secureExam";
import { resolveSubmissionTimingPolicy, submissionDeadline } from "@/lib/assessmentLifecycle";
import { recordAnswerSavedActivity } from "@/lib/answerActivityTelemetry";
import { findMostRecentSessionId } from "@/lib/examAttemptSessionRunner";
import { isSubmissionContentAccessible, EXAM_NOT_ACTIVATED_CODE, EXAM_NOT_ACTIVATED_MESSAGE } from "@/lib/secureClientActivation";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import { saveAnswerWithIdempotency } from "@/lib/answerSaveRunner";
import {
  checkTetherContentAccessLease,
  readContentAccessLeaseCookieFromRequest,
  renewContentAccessLeaseFromValidatedDecision,
  TETHER_CONTENT_ACCESS_REQUIRED_CODE,
  TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE,
  type ContentAccessDecision,
} from "@/lib/secureClient/requireTetherContentAccess";
import { logServerTetherDiagnostic } from "@/lib/tetherDiagnosticLog";

// Tether Secure Exam Recovery and Resilient Autosave v1 (Part 2) — see
// docs/tether-secure-resume-recovery-v1.md, "Autosave idempotency and
// revision control". clientRequestId/clientRevision are both OPTIONAL and
// backward-compatible: a caller that omits them (any client predating
// this feature) gets the exact same plain last-write-wins upsert as
// before. clientRequestId is bounded and scoped implicitly to THIS
// submission+question (the route only ever reads/writes the Answer row
// for `submission.id` — already ownership-checked below — so a value
// cannot be "reused to affect someone else's answer": it is never looked
// up globally, only compared against the ONE row this exact request is
// already authorized to touch).
const answerSchema = z.object({
  questionId: z.string(),
  response: z.string(),
  clientRequestId: z.string().min(1).max(200).optional(),
  clientRevision: z.number().int().min(0).max(1_000_000_000).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Latency profiling (physical acceptance follow-up — question-navigation
  // latency audit). Bounded, opt-in (TETHER_DIAGNOSTIC_LOGGING_ENABLED),
  // never enabled in production — see logServerTetherDiagnostic's own doc
  // comment. Only ever logs plain millisecond durations, never request/
  // response content.
  const timingStartMs = performance.now();
  const authStartMs = timingStartMs;
  const session = await auth();
  const authMs = performance.now() - authStartMs;
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submissionLookupStartMs = performance.now();
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: true },
  });
  const submissionLookupMs = performance.now() - submissionLookupStartMs;

  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.status !== "IN_PROGRESS") {
    return NextResponse.json({ error: "Submission already finalized" }, { status: 409 });
  }

  // v1.7.4 pre-exam readiness — an answer can never be saved for a
  // secure-client-required attempt before server-side activation; see
  // src/lib/secureClientActivation.ts. This is a genuine security
  // boundary, not just a UX nicety: without it, a PREPARING attempt's
  // question ids (guessed or leaked elsewhere) could still record an
  // answer before the student ever passed native lockdown activation.
  if (!isSubmissionContentAccessible(submission)) {
    return NextResponse.json({ error: EXAM_NOT_ACTIVATED_MESSAGE, code: EXAM_NOT_ACTIVATED_CODE }, { status: 403 });
  }

  // Release-blocking server content-boundary audit — see
  // tetherContentAccessLease.ts. isSubmissionContentAccessible above only
  // proves the submission itself is activated, never that THIS request
  // originates from the Tether/SEB instance that activated it. Without
  // this, an ordinary, separately-authenticated Chrome/Edge request could
  // record fabricated answers into an active secure attempt merely
  // because it knows/guesses a questionId — no question content needs to
  // leak for this write-side gap to matter.
  // Performance follow-up (physical acceptance review) — captured so the
  // success response below can renew straight from THIS decision (see
  // renewContentAccessLeaseFromValidatedDecision's own doc comment)
  // instead of re-running the whole check a second time. This is the
  // highest-frequency content-bound write during an attempt, so avoiding
  // a redundant Ed25519 verify + DB read here matters most.
  let leaseDecisionForRenewal: ContentAccessDecision | null = null;
  let leaseCheckMs = 0;
  const answerClientPolicy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  if (answerClientPolicy.deliveryMode === "TETHER_CLIENT_REQUIRED") {
    const leaseCheckStartMs = performance.now();
    const leaseDecision = await checkTetherContentAccessLease(readContentAccessLeaseCookieFromRequest(req), {
      submissionId: submission.id,
      studentId: session.user.id,
    });
    leaseCheckMs = performance.now() - leaseCheckStartMs;
    leaseDecisionForRenewal = leaseDecision;
    if (!leaseDecision.ok) {
      return NextResponse.json({ error: TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE, code: TETHER_CONTENT_ACCESS_REQUIRED_CODE }, { status: 403 });
    }
  }

  // Freeze timing policy for active exam attempts — see
  // resolveSubmissionTimingPolicy in assessmentLifecycle.ts. Never the
  // exam's live durationMins/allowLateSubmit, which a lecturer may have
  // edited after this attempt started.
  const timingPolicy = resolveSubmissionTimingPolicy({
    examPolicySnapshotJson: submission.examPolicySnapshotJson,
    currentExamDurationMins: submission.exam.durationMins,
    currentSecureSettings: parseSecureSettings(submission.exam.secureSettings),
  });
  const deadline = submissionDeadline(submission.startedAt, timingPolicy.durationMins);
  if (new Date() > deadline && !timingPolicy.allowLateSubmit) {
    return NextResponse.json({ error: "Time is up" }, { status: 409 });
  }

  const body = await req.json();
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { questionId, response, clientRequestId, clientRevision } = parsed.data;

  // One transaction instead of two sequential queries — holds a single
  // pooled connection for the whole autosave instead of two checkouts,
  // which matters under concurrent autosave traffic with a small pool.
  // Question-navigation performance follow-up — the actual idempotency/
  // revision/concurrency logic now lives in saveAnswerWithIdempotency
  // (src/lib/answerSaveRunner.ts), shared with POST save-and-navigate,
  // never duplicated between the two routes.
  const transactionStartMs = performance.now();
  const result = await prisma.$transaction((tx) =>
    saveAnswerWithIdempotency(tx, { submissionId: id, examId: submission.examId, questionId, response, clientRequestId, clientRevision }),
  );
  const transactionMs = performance.now() - transactionStartMs;

  if (result.kind === "invalid_question") return NextResponse.json({ error: "Invalid question" }, { status: 400 });
  const { answer, applied } = result;

  // Tether Secure Exam Recovery and Resilient Autosave v1 — best-effort,
  // non-blocking "last server contact for autosave" marker (Part 12,
  // lecturer visibility). Never awaited inline with the response.
  prisma.submission.update({ where: { id }, data: { lastAutosaveAcknowledgedAt: new Date() } }).catch(() => {});

  // Exam Session Binding + Time Anomaly Review v1 — coarse telemetry only
  // (length/hash/delta, never the full response text duplicated). Never
  // blocks the answer save: both calls are fire-and-forget and swallow
  // their own errors internally. Only recorded for a save that actually
  // applied — a pure idempotent replay/stale-revision no-op is not a new
  // activity event.
  if (applied) {
    findMostRecentSessionId(id)
      .then((examAttemptSessionId) =>
        recordAnswerSavedActivity({ submissionId: id, questionId, examAttemptSessionId, response }),
      )
      .catch(() => {});
  }

  const jsonResponse = NextResponse.json({
    questionId: answer.questionId,
    response: answer.response,
    acknowledgedRevision: answer.clientRevision ?? null,
    acknowledgedRequestId: answer.lastClientRequestId ?? null,
  });

  // Rolling lease renewal, from the SAME decision computed above — no
  // second decode/verify/DB read (see
  // renewContentAccessLeaseFromValidatedDecision's own doc comment).
  const leaseRenewalStartMs = performance.now();
  if (leaseDecisionForRenewal) {
    renewContentAccessLeaseFromValidatedDecision(jsonResponse, leaseDecisionForRenewal, { submissionId: submission.id, studentId: submission.studentId });
  }
  const leaseRenewalMs = performance.now() - leaseRenewalStartMs;

  logServerTetherDiagnostic("ANSWERS_PATCH_TIMING", {
    authMs: Math.round(authMs),
    submissionLookupMs: Math.round(submissionLookupMs),
    leaseCheckMs: Math.round(leaseCheckMs),
    transactionMs: Math.round(transactionMs),
    leaseRenewalMs: Math.round(leaseRenewalMs * 100) / 100, // synchronous now (no DB/crypto work) — sub-millisecond, kept at 2dp rather than rounding to 0
    totalMs: Math.round(performance.now() - timingStartMs),
  });

  return jsonResponse;
}

export const dynamic = "force-dynamic";
