import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";
import { parseSecureSettings } from "@/lib/secureExam";
import { buildStudentExamPolicySummary } from "@/lib/examPolicy";
import { buildSecureClientPolicySnapshot, deliveryModeRequiresSecureClient } from "@/lib/secureClientPolicy";
import { secureClientAvailabilityForInstitution } from "@/lib/secureClientAvailability";

/**
 * Safe Exam Deep Link v1 — see docs/course-enrolment-and-exam-assignment.md
 * and docs/known-limitations.md. Read-only companion to
 * POST /api/exams/[id]/start: runs the exact same institution / course /
 * assignment / published / availability-window checks, in the same
 * order, but never checks the access code and never creates a
 * Submission. Used by /student/exams/join/[examId] to decide what to
 * show before the student actually starts the exam.
 *
 * Never reveals institution/course details to a student who fails the
 * institution/course/assignment check — that case and "exam does not
 * exist" both return the same generic { ok: false, reason: "no_access" }.
 * A student who *does* have access but is outside the schedule window
 * gets a more specific reason, since they're not being told anything
 * they aren't already entitled to know.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { course: { select: { id: true, name: true, code: true } }, institution: { select: { slug: true } } },
  });

  if (!exam || !exam.published) {
    return NextResponse.json({ ok: false, reason: "no_access" });
  }

  // Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md. A
  // STANDALONE exam is reachable by a student regardless of
  // institution membership (including institutionId: null) — entitlement
  // is entirely governed by an existing ExamAssignment row, created only
  // by the deliberate accept action, never by this read-only check.
  // assertSameInstitution is deliberately skipped for this mode: it
  // would incorrectly throw for a null-institution student and would be
  // the wrong check even for an institution-linked one, since a
  // standalone exam's entitlement is per-student, not per-institution.
  if (exam.assignmentMode === "STANDALONE") {
    const assigned = await prisma.examAssignment.findUnique({
      where: { examId_studentId: { examId: id, studentId: session.user.id } },
    });
    if (!assigned) {
      return NextResponse.json({ ok: false, reason: "no_access" });
    }
  } else {
    try {
      assertSameInstitution(session, exam.institutionId);
    } catch (err) {
      const res = institutionErrorResponse(err);
      if (res) return NextResponse.json({ ok: false, reason: "no_access" });
      throw err;
    }

    // Course, Enrolment, Exam Assignment, Scheduling v1 — identical logic
    // to POST /api/exams/[id]/start. courseId: null is a legacy
    // institution-wide exam and needs no further check.
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
        return NextResponse.json({ ok: false, reason: "no_access" });
      }
    }
  }

  const now = new Date();
  const opensAt = exam.availableFrom ?? exam.startsAt ?? null;
  const closesAt = exam.availableUntil ?? exam.endsAt ?? null;
  if (opensAt && now < opensAt) {
    return NextResponse.json({ ok: false, reason: "not_open", opensAt });
  }
  if (closesAt && now > closesAt) {
    return NextResponse.json({ ok: false, reason: "closed" });
  }

  const existingSubmission =
    (await prisma.submission.findFirst({
      where: { examId: id, studentId: session.user.id, status: "IN_PROGRESS" },
      orderBy: [{ attemptNumber: "desc" }, { startedAt: "desc" }],
      select: { id: true, status: true, attemptNumber: true },
    })) ??
    (await prisma.submission.findFirst({
      where: { examId: id, studentId: session.user.id },
      orderBy: [{ attemptNumber: "desc" }, { startedAt: "desc" }],
      select: { id: true, status: true, attemptNumber: true },
    }));

  // Exam Design Policy v1 — see docs/exam-design-policy-v1.md. The same
  // student-safe summary shown on the "Exam conditions" acknowledgement
  // screen. Built from the exam's CURRENT settings (there is no
  // submission/attempt yet to snapshot) — the immutable snapshot itself
  // is only created once the student actually starts the attempt.
  const settings = parseSecureSettings(exam.secureSettings);
  const examPolicySummary = buildStudentExamPolicySummary({
    examMode: settings.examMode,
    calculatorAllowed: settings.calculatorAllowed,
    notesAllowed: settings.notesAllowed,
    internetAllowed: settings.internetAllowed,
    aiToolsAllowed: settings.aiToolsAllowed,
    secureSettings: {
      secureModeEnabled: settings.secureModeEnabled,
      requireFullscreen: settings.requireFullscreen,
      blockCopyPaste: settings.blockCopyPaste,
      trackWindowBlur: settings.trackWindowBlur,
      requireCamera: settings.requireCamera,
      enableAiCameraIntegrityChecks: settings.enableAiCameraIntegrityChecks,
    },
  });

  // v1.7.4 pre-exam readiness — Phase 1 PRECHECK (see
  // src/app/student/exams/[id]/tether-launch/page.tsx) runs entirely
  // BEFORE POST /api/exams/[id]/start, so no per-attempt frozen policy
  // snapshot exists yet to read. Built from CURRENT exam settings —
  // exactly the same "no submission/attempt yet to snapshot" reasoning
  // examPolicySummary above already documents — never persisted, never
  // treated as the authoritative per-attempt policy (that remains
  // secureClientPolicySnapshotJson, frozen at /start). Only used to
  // decide which native preflight checks the calm readiness screen
  // should run before Begin examination is even shown.
  const securePreflightPolicy = buildSecureClientPolicySnapshot(
    {
      deliveryMode: settings.deliveryMode,
      allowedSebPlatforms: settings.allowedSebPlatforms,
      allowedSebVersions: settings.allowedSebVersions,
      requireSebBrowserExamKey: settings.requireSebBrowserExamKey,
      requireSebConfigKey: settings.requireSebConfigKey,
      allowSebHeaderValidation: settings.allowSebHeaderValidation,
      allowSebJavascriptApiValidation: settings.allowSebJavascriptApiValidation,
      secureLaunchTokenTtlSeconds: settings.secureLaunchTokenTtlSeconds,
      secureClientHeartbeatIntervalSeconds: settings.secureClientHeartbeatIntervalSeconds,
      secureClientHeartbeatGraceSeconds: settings.secureClientHeartbeatGraceSeconds,
      requireDisplayCheck: settings.requireDisplayCheck,
      secureClientMaximumDisplays: settings.secureClientMaximumDisplays,
      displayPolicy: settings.displayPolicy,
      requireRemoteSessionCheck: settings.requireRemoteSessionCheck,
      requireVirtualMachineCheck: settings.requireVirtualMachineCheck,
      requireProcessCheck: settings.requireProcessCheck,
      requireCaptureProtectionCheck: settings.requireCaptureProtectionCheck,
      blockCopyPaste: settings.blockCopyPaste,
      secureClientAllowPrinting: settings.secureClientAllowPrinting,
      secureClientAllowExternalNavigation: settings.secureClientAllowExternalNavigation,
      secureClientAllowApplicationSwitching: settings.secureClientAllowApplicationSwitching,
      secureClientAllowRecovery: settings.secureClientAllowRecovery,
      secureClientEventRetentionDays: settings.secureClientEventRetentionDays,
      secureClientLecturerOverrideAllowed: settings.secureClientLecturerOverrideAllowed,
    },
    secureClientAvailabilityForInstitution(exam.institution?.slug ?? null),
  );

  return NextResponse.json({
    ok: true,
    exam: {
      id: exam.id,
      title: exam.title,
      description: exam.description,
      durationMins: exam.durationMins,
      accessCodeRequired: exam.accessCodeRequired,
      course: exam.course,
      // Mandatory Tether Delivery for Final Examinations — lets the
      // tether-launch page show the exact required student-facing copy
      // ("This final examination must be opened in Tether Secure
      // Browser.") instead of the generic Tether-required wording.
      assessmentType: settings.assessmentType,
    },
    existingSubmission,
    examPolicySummary,
    securePreflight: {
      requiresSecureClient: deliveryModeRequiresSecureClient(securePreflightPolicy.deliveryMode),
      requireDisplayCheck: securePreflightPolicy.requireDisplayCheck,
      displayPolicy: securePreflightPolicy.displayPolicy,
      requireRemoteSessionCheck: securePreflightPolicy.requireRemoteSessionCheck,
    },
  });
}

export const dynamic = "force-dynamic";
