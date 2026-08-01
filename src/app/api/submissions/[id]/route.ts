import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";
import { canStudentViewMarks, resolveSubmissionTimingPolicy, submissionDeadline } from "@/lib/assessmentLifecycle";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import { getCurrentSessionForSubmission } from "@/lib/secureClientRunner";
import { isTetherSecureClientBypassAllowed } from "@/lib/secureClientAvailability";
import { resolveSecureClientStartGate, buildTetherLaunchPagePath } from "@/lib/secureClientStartGate";
import { parseAttestationRequirement, resolveEffectiveTetherVerification } from "@/lib/tetherAttestationConfig";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: {
      exam: { include: { questions: { orderBy: { order: "asc" } }, institution: { select: { slug: true } } } },
      answers: true,
      gradePassback: true,
      student: { select: { id: true, name: true, email: true, institutionStudentId: true } },
    },
  });

  if (!submission) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isOwner = submission.studentId === session.user.id;
  const isExamOwner =
    session.user.role === "LECTURER" && submission.exam.createdById === session.user.id;
  if (!isOwner && !isExamOwner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Tether launch/install flow v1 — Requirement 9 ("Production start
  // protection"). The actual content-exposure boundary: GET
  // /api/submissions/[id] is what serves question text/options (see
  // `questions` below), so this is where "reject an ordinary browser"
  // gets real teeth, unlike POST /api/exams/[id]/start (which can't
  // block here — no SecureClientSession can exist before the submission
  // does). Reads the IMMUTABLE per-attempt policy snapshot — never
  // re-derived from the exam's current settings — so this can never
  // retroactively change what an in-progress attempt requires. Only ever
  // applies to the student's own IN_PROGRESS view: the lecturer's
  // grading view (isExamOwner) is always unaffected, and a
  // SUBMITTED/GRADED submission is a historical record the student may
  // still review normally. Only ever triggers for TETHER_CLIENT_REQUIRED
  // (resolveSecureClientStartGate) — every SEB/STANDARD_WEB/MONITORED_WEB
  // submission is completely unaffected.
  if (isOwner && !isExamOwner && submission.status === "IN_PROGRESS") {
    const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
    if (policy.deliveryMode === "TETHER_CLIENT_REQUIRED") {
      const currentSession = await getCurrentSessionForSubmission(submission.id);
      // Secure Client Attestation v2 — the real content-exposure gate.
      // See src/lib/tetherAttestationConfig.ts for the full
      // LEGACY/DUAL/V2_REQUIRED truth table. Reads the SESSION's own
      // immutable requirement snapshot — never the live environment
      // variable, and never any client-supplied version (closes the
      // client-controlled-downgrade path the pre-Preview safety pass
      // found in the previous design).
      const hasVerifiedTetherSession = resolveEffectiveTetherVerification({
        sessionRequirement: parseAttestationRequirement(currentSession?.attestationRequirement ?? null),
        legacyVerified: currentSession?.verificationStatus === "VERIFIED",
        v2Verified: currentSession?.installationAttestationVerified === true,
      });
      const devBypassAllowed = isTetherSecureClientBypassAllowed(submission.exam.institution?.slug ?? null);
      const gate = resolveSecureClientStartGate({ effectiveDeliveryMode: policy.deliveryMode, hasVerifiedTetherSession, devBypassAllowed });
      if (gate.kind === "REDIRECT_TO_TETHER_LAUNCH") {
        return NextResponse.json(
          {
            error: "This exam requires Tether Secure Browser.",
            code: "TETHER_SESSION_REQUIRED",
            action: { redirectTo: buildTetherLaunchPagePath(submission.examId) },
          },
          { status: 403 },
        );
      }
    }
  }

  const settings = parseSecureSettings(submission.exam.secureSettings);
  // Freeze timing policy for active exam attempts — the deadline shown
  // to the student/lecturer always reflects THIS attempt's own frozen
  // timingPolicy snapshot (captured at start), never the exam's
  // possibly-since-edited live durationMins. See
  // resolveSubmissionTimingPolicy in assessmentLifecycle.ts.
  const timingPolicy = resolveSubmissionTimingPolicy({
    examPolicySnapshotJson: submission.examPolicySnapshotJson,
    currentExamDurationMins: submission.exam.durationMins,
    currentSecureSettings: settings,
  });
  const deadline = submissionDeadline(submission.startedAt, timingPolicy.durationMins);
  const studentCanViewMarks = canStudentViewMarks({
    role: session.user.role,
    isOwner,
    marksReleasedAt: submission.exam.marksReleasedAt,
  });
  const canViewMarks = isExamOwner || studentCanViewMarks;
  const canViewQuestionPoints =
    isExamOwner || submission.status === "IN_PROGRESS" || studentCanViewMarks;
  // One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md. Only ever applies to the STUDENT's
  // own in-progress view — the lecturer's grading view (isExamOwner)
  // always gets the full question list regardless of this setting, since
  // it's a student-delivery concern, not a grading concern. The student
  // page instead fetches one question at a time from
  // GET/POST /api/submissions/[id]/question(-progress).
  const deliverOneQuestionAtATime =
    isOwner && !isExamOwner && settings.oneQuestionAtATime && submission.status === "IN_PROGRESS";

  // Question Pools v1 — see docs/question-pools-v1.md. Resolves to this
  // submission's persisted selected/ordered subset when pools are active
  // for this exam, otherwise the full exam question set unchanged
  // (resolveEffectiveQuestionIds falls back to the full set on its own
  // when nothing valid is stored, or when pools aren't active at all).
  // Applied to BOTH the student's own view and the lecturer's grading
  // view of this submission — a lecturer reviewing one student's
  // attempt should see exactly the questions that student was actually
  // given, not the full pool/question bank (which remains visible
  // elsewhere, in the exam editor).
  const effectiveQuestionIds = resolveEffectiveQuestionIds({
    examQuestionIds: submission.exam.questions.map((q) => q.id),
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });
  const effectiveQuestionIdSet = new Set(effectiveQuestionIds);
  const effectiveOrderIndex = new Map(effectiveQuestionIds.map((qid, i) => [qid, i]));
  const effectiveQuestions = submission.exam.questions
    .filter((q) => effectiveQuestionIdSet.has(q.id))
    .sort((a, b) => effectiveOrderIndex.get(a.id)! - effectiveOrderIndex.get(b.id)!);

  const questions = deliverOneQuestionAtATime
    ? []
    : effectiveQuestions.map((q) => ({
        id: q.id,
        type: q.type,
        text: q.text,
        options: q.options,
        points: canViewQuestionPoints ? q.points : undefined,
        order: q.order,
        correctAnswer: isExamOwner ? q.correctAnswer : undefined,
      }));

  const canvasPassback =
    isExamOwner && submission.gradePassback
      ? {
          status: submission.gradePassback.status,
          scoreGiven: submission.gradePassback.scoreGiven,
          scoreMaximum: submission.gradePassback.scoreMaximum,
          sentAt: submission.gradePassback.sentAt,
          attemptedAt: submission.gradePassback.attemptedAt,
          errorMessage: submission.gradePassback.errorMessage,
        }
      : null;

  return NextResponse.json({
    id: submission.id,
    status: submission.status,
    attemptNumber: submission.attemptNumber,
    startedAt: submission.startedAt,
    submittedAt: submission.submittedAt,
    totalScore: canViewMarks ? submission.totalScore : null,
    deadline,
    marksReleasedAt: submission.exam.marksReleasedAt,
    marksReleased: submission.exam.marksReleasedAt != null,
    canvasPassback,
    // Optional Student Verification v1 — see
    // docs/on-device-ai-integrity-detection-v1.md. Never includes
    // passwordHash or any other sensitive field.
    student: {
      // id is included only for the Exam Watermark v1 fallback identifier
      // (see src/lib/examWatermark.ts) — used only when institutionStudentId
      // and email are both unavailable, and only ever shown truncated to 8
      // characters, never the raw id.
      id: submission.student.id,
      name: submission.student.name,
      email: submission.student.email,
      institutionStudentId: submission.student.institutionStudentId,
    },
    exam: {
      id: submission.exam.id,
      title: submission.exam.title,
      questions,
      // Present even when `questions` is empty (one-question mode) so the
      // student page can render "Question X of N" without needing the
      // full question list. Reflects the SELECTED question count when
      // question pools are active, never the full exam/pool question
      // count.
      totalQuestions: effectiveQuestionIds.length,
      secureSettings: settings,
    },
    answers: submission.answers.map((a) => ({
      questionId: a.questionId,
      response: a.response,
      score: canViewMarks ? a.score : undefined,
      feedback: canViewMarks ? a.feedback : undefined,
      aiDraftScore: isExamOwner ? a.aiDraftScore : undefined,
      aiReasoning: isExamOwner ? a.aiReasoning : undefined,
    })),
  });
}

export const dynamic = "force-dynamic";
