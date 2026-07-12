import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";

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
    include: { course: { select: { id: true, name: true, code: true } } },
  });

  if (!exam || !exam.published) {
    return NextResponse.json({ ok: false, reason: "no_access" });
  }

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

  return NextResponse.json({
    ok: true,
    exam: {
      id: exam.id,
      title: exam.title,
      description: exam.description,
      durationMins: exam.durationMins,
      accessCodeRequired: exam.accessCodeRequired,
      course: exam.course,
    },
    existingSubmission,
  });
}

export const dynamic = "force-dynamic";
