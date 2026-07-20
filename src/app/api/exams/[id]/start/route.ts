import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse, requireInstitutionId } from "@/lib/institutionScope";
import { captureNetworkEvidence } from "@/lib/networkEvidence";
import { canCreateAttempt, nextAttemptNumber } from "@/lib/assessmentLifecycle";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";
import {
  buildOptionOrders,
  buildQuestionOrder,
  buildSelectedQuestionIds,
  type StoredQuestionOrder,
} from "@/lib/questionDelivery";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { recordSimpleActivityEvent } from "@/lib/answerActivityTelemetry";
import { buildExamPolicySnapshot } from "@/lib/examPolicy";
import { buildAiAssistancePolicySnapshot } from "@/lib/aiAssistancePolicy";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: {
      questions: { orderBy: { order: "asc" } },
      // Question Pools v1 — see docs/question-pools-v1.md.
      questionPools: true,
    },
  });
  if (!exam || !exam.published) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  // Course, Enrolment, Exam Assignment, Scheduling v1 — see
  // docs/course-enrolment-and-exam-assignment.md. A courseId: null exam
  // is a legacy institution-wide exam and needs no further check here —
  // institution membership above is sufficient, exactly as before this
  // feature. Otherwise the student must be enrolled in the exam's course
  // (assignmentMode COURSE) or directly assigned (SELECTED_STUDENTS).
  if (exam.courseId) {
    const [enrolled, assigned] = await Promise.all([
      exam.assignmentMode === "COURSE"
        ? prisma.courseEnrollment.findUnique({
            where: { courseId_userId: { courseId: exam.courseId, userId: session.user.id } },
          })
        : Promise.resolve(null),
      exam.assignmentMode === "SELECTED_STUDENTS"
        ? prisma.examAssignment.findUnique({
            where: { examId_studentId: { examId: id, studentId: session.user.id } },
          })
        : Promise.resolve(null),
    ]);
    const hasAccess =
      (exam.assignmentMode === "COURSE" && enrolled?.role === "STUDENT") ||
      (exam.assignmentMode === "SELECTED_STUDENTS" && assigned != null);
    if (!hasAccess) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  const now = new Date();
  // availableFrom/availableUntil are the new explicit scheduling fields;
  // startsAt/endsAt are the pre-existing ones. Both are honored — either
  // set restricts the window, neither set means no restriction.
  const opensAt = exam.availableFrom ?? exam.startsAt ?? null;
  const closesAt = exam.availableUntil ?? exam.endsAt ?? null;
  if (opensAt && now < opensAt) {
    return NextResponse.json({ error: "Exam has not started yet" }, { status: 403 });
  }
  if (closesAt && now > closesAt) {
    return NextResponse.json({ error: "Exam window has closed" }, { status: 403 });
  }

  const existingInProgress = await prisma.submission.findFirst({
    where: { examId: id, studentId: session.user.id, status: "IN_PROGRESS" },
    orderBy: [{ attemptNumber: "desc" }, { startedAt: "desc" }],
  });
  if (existingInProgress) return NextResponse.json(existingInProgress);

  const settings = parseSecureSettings(exam.secureSettings);
  const attempts = await prisma.submission.findMany({
    where: { examId: id, studentId: session.user.id },
    select: { attemptNumber: true, status: true },
    orderBy: { attemptNumber: "desc" },
  });
  const finalizedAttemptCount = attempts.filter((attempt) => attempt.status !== "IN_PROGRESS").length;
  if (!canCreateAttempt({ finalizedAttemptCount, maxAttempts: settings.maxAttempts })) {
    return NextResponse.json({ error: "No attempts remaining for this exam." }, { status: 409 });
  }
  const attemptNumber = nextAttemptNumber(attempts);

  // Body is read once, up-front, for both the access code (below) and the
  // policy acknowledgement (Exam Design Policy v1 — see
  // docs/exam-design-policy-v1.md). Every new attempt requires both,
  // exactly once each — resuming an existing in-progress attempt (the
  // idempotency check above) never re-prompts for either.
  const body = await req.json().catch(() => ({}));

  // Student Onboarding and Exam Access v1 — see
  // docs/student-onboarding-and-exam-access.md.
  if (exam.accessCodeRequired) {
    const accessCode = typeof body?.accessCode === "string" ? body.accessCode : "";
    const valid =
      accessCode.length > 0 &&
      exam.accessCodeHash != null &&
      (await bcrypt.compare(accessCode, exam.accessCodeHash));
    if (!valid) {
      return NextResponse.json(
        { error: "Valid access code required to start this exam." },
        { status: 403 },
      );
    }
  }

  // Exam Design Policy v1 (Part 7/8) — see docs/exam-design-policy-v1.md.
  // The student must not start a new attempt until acknowledgement is
  // recorded. The acknowledgement timestamp is captured here (server
  // time, not client-supplied) and embedded directly into the immutable
  // policy snapshot built below — there is no separate acknowledgement
  // table in v1.
  if (body?.policyAcknowledged !== true) {
    return NextResponse.json(
      { error: "You must acknowledge the exam conditions before starting this exam." },
      { status: 400 },
    );
  }
  const policyAcknowledgedAt = new Date();

  // Two near-simultaneous "start exam" requests from the same student (e.g.
  // a double-click, or a flaky network retry) can both pass the check above
  // before either has created a row. The @@unique([examId, studentId])
  // constraint then rejects the loser — recover by returning the winner's
  // submission instead of a 500, so starting is idempotent under races.
  // One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md. The stable per-submission
  // question/option order is generated exactly once, here, at attempt
  // creation — using real crypto-backed randomness (Math.random is fine
  // server-side for this; not security-sensitive, just needs to differ
  // per submission), then persisted. It is never recomputed on
  // subsequent requests — "stable across refresh" is a property of this
  // persisted value, not of a reproducible seed, so there is no seed to
  // ever expose to the client. Left null when both randomisation
  // settings are off, in which case the original Question.order is used
  // at read time (see resolveQuestionOrder in questionDelivery.ts).
  // Question Pools v1 — see docs/question-pools-v1.md. When active, the
  // selected/ordered question SUBSET is computed here (and only here,
  // exactly once) and stored in `selectedQuestionIds`; `questionIds`
  // (the plain full-exam reorder field) is left unused in this branch.
  const poolsActive = questionPoolsActive(settings);
  let poolDrawSummary: Array<{ poolId: string; drawCount: number | null; selectedCount: number }> | null = null;

  const questionOrderJson: StoredQuestionOrder | null = poolsActive
    ? (() => {
        const selectedQuestionIds = buildSelectedQuestionIds({
          questions: exam.questions.map((q) => ({
            id: q.id,
            questionPoolId: q.questionPoolId,
            order: q.order,
          })),
          pools: exam.questionPools.map((p) => ({ id: p.id, drawCount: p.drawCount })),
          randomiseQuestionOrder: settings.randomiseQuestionOrder,
        });
        const selectedSet = new Set(selectedQuestionIds);
        poolDrawSummary = exam.questionPools.map((p) => ({
          poolId: p.id,
          drawCount: p.drawCount,
          selectedCount: exam.questions.filter((q) => q.questionPoolId === p.id && selectedSet.has(q.id)).length,
        }));
        return {
          questionIds: [],
          selectedQuestionIds,
          optionOrders: buildOptionOrders({
            questions: exam.questions
              .filter((q) => selectedSet.has(q.id))
              .map((q) => ({ id: q.id, type: q.type, options: q.options as string[] | null })),
            randomiseMcqOptionOrder: settings.randomiseMcqOptionOrder,
          }),
        };
      })()
    : settings.randomiseQuestionOrder || settings.randomiseMcqOptionOrder
      ? {
          questionIds: buildQuestionOrder({
            questionIds: exam.questions.map((q) => q.id),
            randomiseQuestionOrder: settings.randomiseQuestionOrder,
          }),
          optionOrders: buildOptionOrders({
            questions: exam.questions.map((q) => ({
              id: q.id,
              type: q.type,
              options: q.options as string[] | null,
            })),
            randomiseMcqOptionOrder: settings.randomiseMcqOptionOrder,
          }),
        }
      : null;

  // Exam Design Policy v1 — the immutable snapshot for THIS attempt,
  // built once here from the exam's settings as they exist right now.
  // Never recomputed or overwritten later — changing the exam afterwards
  // never changes this attempt's snapshot (see
  // docs/exam-design-policy-v1.md).
  const policySnapshot = buildExamPolicySnapshot(
    {
      examMode: settings.examMode,
      calculatorAllowed: settings.calculatorAllowed,
      notesAllowed: settings.notesAllowed,
      internetAllowed: settings.internetAllowed,
      aiToolsAllowed: settings.aiToolsAllowed,
    },
    {
      secureModeEnabled: settings.secureModeEnabled,
      requireFullscreen: settings.requireFullscreen,
      blockCopyPaste: settings.blockCopyPaste,
      trackWindowBlur: settings.trackWindowBlur,
      requireCamera: settings.requireCamera,
      enableAiCameraIntegrityChecks: settings.enableAiCameraIntegrityChecks,
    },
    policyAcknowledgedAt,
    new Date(),
  );

  // Controlled AI Brainstorming Assistance v1 — see
  // docs/controlled-ai-brainstorming-assistance-v1.md. Same immutable-
  // snapshot pattern as policySnapshot above: built once here from the
  // exam's CURRENT settings, then never recomputed for this attempt even
  // if the lecturer changes aiAssistance* settings afterwards.
  const aiAssistancePolicySnapshot = buildAiAssistancePolicySnapshot({
    aiAssistanceMode: settings.aiAssistanceMode,
    aiAssistanceMaxPromptsPerQuestion: settings.aiAssistanceMaxPromptsPerQuestion,
    aiAssistanceMaxPromptsPerAttempt: settings.aiAssistanceMaxPromptsPerAttempt,
    aiAssistanceMaxResponseCharacters: settings.aiAssistanceMaxResponseCharacters,
    aiAssistanceAllowConceptExplanations: settings.aiAssistanceAllowConceptExplanations,
    aiAssistanceAllowAnswerPlanning: settings.aiAssistanceAllowAnswerPlanning,
    aiAssistanceAllowReasoningFeedback: settings.aiAssistanceAllowReasoningFeedback,
    aiAssistanceAllowProgrammingConceptHelp: settings.aiAssistanceAllowProgrammingConceptHelp,
  });

  try {
    const submission = await prisma.submission.create({
      data: {
        examId: id,
        studentId: session.user.id,
        attemptNumber,
        questionOrderJson: questionOrderJson ?? Prisma.DbNull,
        examPolicySnapshotJson: policySnapshot as unknown as Prisma.InputJsonValue,
        aiAssistancePolicySnapshotJson: aiAssistancePolicySnapshot as unknown as Prisma.InputJsonValue,
      },
    });

    // Academic Integrity Network Evidence v1 — captured fire-and-forget
    // after the submission row exists. Never blocks exam start.
    const institutionId = requireInstitutionId(session);

    // Exam Design Policy v1 — audit both the acknowledgement and the
    // snapshot creation. Never blocks exam start.
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "EXAM_POLICY_ACKNOWLEDGED",
      targetType: "Submission",
      targetId: submission.id,
      institutionId,
      metadata: { examId: id, examMode: policySnapshot.examMode, policyVersion: policySnapshot.policyVersion },
    }).catch(() => {});
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "EXAM_POLICY_SNAPSHOT_CREATED",
      targetType: "Submission",
      targetId: submission.id,
      institutionId,
      metadata: { examId: id, examMode: policySnapshot.examMode, policyVersion: policySnapshot.policyVersion },
    }).catch(() => {});
    captureNetworkEvidence({
      req,
      submissionId: submission.id,
      examId: id,
      studentId: session.user.id,
      institutionId,
      source: "EXAM_START",
    }).catch(() => {/* evidence capture is best-effort */});

    // Exam Session Binding + Time Anomaly Review v1 — coarse telemetry
    // marker only. Session BINDING itself (cookies, device token) is
    // created on the exam page's first heartbeat, not here — see
    // src/lib/examAttemptSessionRunner.ts.
    recordSimpleActivityEvent({ submissionId: submission.id, eventType: "ATTEMPT_STARTED" }).catch(() => {});

    // Question Pools v1 — lightweight, best-effort audit summary. Never
    // includes question text — only ids, counts, and the per-pool draw
    // summary computed above.
    if (poolsActive && questionOrderJson?.selectedQuestionIds) {
      createPlatformAuditLog({
        actorId: session.user.id,
        action: "QUESTION_POOL_SELECTION_GENERATED",
        targetType: "Submission",
        targetId: submission.id,
        institutionId,
        metadata: {
          examId: id,
          selectedCount: questionOrderJson.selectedQuestionIds.length,
          poolDrawSummary,
        },
      }).catch(() => {
        // Audit logging is best-effort — never blocks exam start.
      });
    }

    return NextResponse.json(submission, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.submission.findFirst({
        where: { examId: id, studentId: session.user.id, status: "IN_PROGRESS" },
        orderBy: [{ attemptNumber: "desc" }, { startedAt: "desc" }],
      });
      if (winner) return NextResponse.json(winner);
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
