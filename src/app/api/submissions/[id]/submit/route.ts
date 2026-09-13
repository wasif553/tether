import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, severityFor } from "@/lib/secureExam";
import { canAcceptSubmit, resolveSubmissionTimingPolicy, submissionDeadline } from "@/lib/assessmentLifecycle";
import { parseAnswerProvenancePolicy, isAnswerProvenanceEnabled } from "@/lib/answerProvenancePolicy";
import { isSourceDeclarationSatisfied } from "@/lib/answerDevelopmentRunner";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { isSubmissionContentAccessible, EXAM_NOT_ACTIVATED_CODE, EXAM_NOT_ACTIVATED_MESSAGE } from "@/lib/secureClientActivation";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import {
  checkTetherContentAccessLease,
  readContentAccessLeaseCookieFromRequest,
  renewContentAccessLeaseFromValidatedDecision,
  TETHER_CONTENT_ACCESS_REQUIRED_CODE,
  TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE,
  type ContentAccessDecision,
} from "@/lib/secureClient/requireTetherContentAccess";
import { finalizeSubmission, parseFinalResponses, runPostFinalizationEffects } from "@/lib/submissionFinalization";

function studentSubmitResponse(submission: {
  id: string;
  status: string;
  submittedAt: Date | null;
  attemptNumber: number;
  totalScore?: number | null;
}, exam: { marksReleasedAt: Date | null }) {
  const marksReleased = exam.marksReleasedAt != null;
  return {
    id: submission.id,
    status: submission.status,
    submittedAt: submission.submittedAt,
    attemptNumber: submission.attemptNumber,
    totalScore: marksReleased ? (submission.totalScore ?? null) : null,
    marksReleased,
  };
}

/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 (Part 9) — final
 * submission idempotency. Called from every ALREADY_FINALIZED response
 * path. Distinguishes a genuinely IDEMPOTENT replay (the caller's own
 * `submissionRequestId` matches the one that first finalized this
 * submission — a duplicate click, a timeout-after-commit retry, or a
 * reconnect-and-retry after a crash) from an ordinary "already submitted
 * by some other means" (no id sent, or the ids differ) — only the former
 * is audited, and distinctly, per Part 13 ("idempotent final-submission
 * replay resolved"). Best-effort: never allowed to affect the response.
 */
async function auditIdempotentSubmitReplayIfMatching(
  current: { id: string; studentId: string; finalSubmissionRequestId: string | null },
  institutionId: string | null,
  submissionRequestId: string | null,
): Promise<void> {
  if (!submissionRequestId || !current.finalSubmissionRequestId || submissionRequestId !== current.finalSubmissionRequestId) return;
  await createPlatformAuditLog({
    actorId: current.studentId,
    action: "TETHER_IDEMPOTENT_FINAL_SUBMISSION_REPLAY_RESOLVED",
    targetType: "Submission",
    targetId: current.id,
    institutionId,
    metadata: { submissionRequestId },
  }).catch(() => {});
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    const systemAutoSubmit = body?.systemAutoSubmit === true;
    const submissionRequestId =
      typeof body?.submissionRequestId === "string" && body.submissionRequestId.length > 0 && body.submissionRequestId.length <= 200
        ? body.submissionRequestId
        : null;

    const finalResponsesParsed = parseFinalResponses(body?.finalResponses);
    if (!finalResponsesParsed.ok) {
      return NextResponse.json({ error: "Invalid finalResponses payload", code: "INVALID_FINAL_RESPONSES" }, { status: 400 });
    }
    const finalResponses = finalResponsesParsed.value;

    // --- Pre-checks (ownership, activation, Tether content-access lease,
    // deadline, provenance declaration) — unchanged from before the
    // finalization-service extraction. finalizeSubmission below re-reads
    // the submission itself (it must be independently callable without a
    // caller-supplied object), so this outer read is used for gating only.
    const submission = await prisma.submission.findUnique({
      where: { id },
      include: { exam: { include: { questions: true } } },
    });

    if (!submission || submission.studentId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (submission.status !== "IN_PROGRESS") {
      await auditIdempotentSubmitReplayIfMatching(submission, submission.exam.institutionId, submissionRequestId);
      return NextResponse.json({
        ...studentSubmitResponse(submission, submission.exam),
        code: "ALREADY_FINALIZED",
      });
    }

    if (!isSubmissionContentAccessible(submission)) {
      return NextResponse.json({ error: EXAM_NOT_ACTIVATED_MESSAGE, code: EXAM_NOT_ACTIVATED_CODE }, { status: 403 });
    }

    let leaseDecisionForRenewal: ContentAccessDecision | null = null;
    const submitClientPolicy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
    if (submitClientPolicy.deliveryMode === "TETHER_CLIENT_REQUIRED") {
      const leaseDecision = await checkTetherContentAccessLease(readContentAccessLeaseCookieFromRequest(req), {
        submissionId: submission.id,
        studentId: session.user.id,
      });
      leaseDecisionForRenewal = leaseDecision;
      if (!leaseDecision.ok) {
        return NextResponse.json({ error: TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE, code: TETHER_CONTENT_ACCESS_REQUIRED_CODE }, { status: 403 });
      }
    }

    const settings = parseSecureSettings(submission.exam.secureSettings);
    const timingPolicy = resolveSubmissionTimingPolicy({
      examPolicySnapshotJson: submission.examPolicySnapshotJson,
      currentExamDurationMins: submission.exam.durationMins,
      currentSecureSettings: settings,
    });
    const deadline = submissionDeadline(submission.startedAt, timingPolicy.durationMins);
    if (!canAcceptSubmit({ now: new Date(), deadline, settings: timingPolicy, systemAutoSubmit })) {
      await prisma.integrityEvent.create({
        data: {
          submissionId: id,
          examId: submission.examId,
          studentId: submission.studentId,
          eventType: "SUBMIT_AFTER_DEADLINE",
          severity: severityFor("SUBMIT_AFTER_DEADLINE", settings),
          message: "A submission attempt was made after the exam deadline.",
          occurredAt: new Date(),
        },
      });
      return NextResponse.json(
        {
          code: "DEADLINE_PASSED",
          error: "The deadline for this exam has passed and late submission is not allowed",
        },
        { status: 409 },
      );
    }

    const provenancePolicy = parseAnswerProvenancePolicy(submission.answerProvenancePolicySnapshotJson);
    if (isAnswerProvenanceEnabled(provenancePolicy) && provenancePolicy.requireAiSourceDeclaration) {
      const declared = await isSourceDeclarationSatisfied(id, provenancePolicy);
      if (!declared) {
        return NextResponse.json(
          {
            code: "SOURCE_DECLARATION_REQUIRED",
            error: "A source/AI-use declaration is required before this exam can be submitted.",
          },
          { status: 400 },
        );
      }
    }

    // --- The one authoritative finalization mechanism (advisory lock,
    // fresh in-transaction status re-check, grading, status transition,
    // provenance checkpoint) — shared with POST /api/exams/[id]/start's
    // existing-attempt backstop and the scheduled overdue-submission
    // sweep. See src/lib/submissionFinalization.ts.
    const result = await finalizeSubmission({
      submissionId: id,
      finalResponses,
      submissionRequestId,
      triggeredBy: "STUDENT_SUBMIT",
    });

    if (result.kind === "NOT_FOUND") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (result.kind === "INVALID_FINAL_RESPONSE_QUESTION") {
      return NextResponse.json(
        { error: "finalResponses referenced a question outside this submission", code: "INVALID_FINAL_RESPONSE_QUESTION" },
        { status: 400 },
      );
    }
    if (result.kind === "ALREADY_FINALIZED") {
      await auditIdempotentSubmitReplayIfMatching(result.submission, result.exam.institutionId, submissionRequestId);
      const response = NextResponse.json({ ...studentSubmitResponse(result.submission, result.exam), code: "ALREADY_FINALIZED" });
      if (leaseDecisionForRenewal) {
        renewContentAccessLeaseFromValidatedDecision(response, leaseDecisionForRenewal, { submissionId: id, studentId: session.user.id });
      }
      return response;
    }

    // result.kind === "FINALIZED" — this request was the one that
    // actually performed IN_PROGRESS -> SUBMITTED/GRADED; run one-time
    // post-finalization effects exactly once, attributed to this real
    // student request.
    await runPostFinalizationEffects({
      submissionId: id,
      examId: submission.examId,
      studentId: submission.studentId,
      hasEssay: result.hasEssay,
      req,
    });

    const response = NextResponse.json(studentSubmitResponse(result.submission, result.exam));
    if (leaseDecisionForRenewal) {
      renewContentAccessLeaseFromValidatedDecision(response, leaseDecisionForRenewal, { submissionId: submission.id, studentId: submission.studentId });
    }
    return response;
  } catch (error) {
    console.error("[submit] error:", error);
    return NextResponse.json({ error: "Failed to submit exam" }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
