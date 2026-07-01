import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse, requireInstitutionId } from "@/lib/institutionScope";
import { captureNetworkEvidence } from "@/lib/networkEvidence";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await prisma.exam.findUnique({ where: { id } });
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

  const existing = await prisma.submission.findUnique({
    where: { examId_studentId: { examId: id, studentId: session.user.id } },
  });
  if (existing) return NextResponse.json(existing);

  // Student Onboarding and Exam Access v1 — see
  // docs/student-onboarding-and-exam-access.md. Checked after the
  // existing-submission idempotency check above, so resuming an
  // already-started exam never re-prompts for the code, but no new
  // submission is ever created without a valid one.
  if (exam.accessCodeRequired) {
    const body = await req.json().catch(() => ({}));
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

  // Two near-simultaneous "start exam" requests from the same student (e.g.
  // a double-click, or a flaky network retry) can both pass the check above
  // before either has created a row. The @@unique([examId, studentId])
  // constraint then rejects the loser — recover by returning the winner's
  // submission instead of a 500, so starting is idempotent under races.
  try {
    const submission = await prisma.submission.create({
      data: { examId: id, studentId: session.user.id },
    });

    // Academic Integrity Network Evidence v1 — captured fire-and-forget
    // after the submission row exists. Never blocks exam start.
    const institutionId = requireInstitutionId(session);
    captureNetworkEvidence({
      req,
      submissionId: submission.id,
      examId: id,
      studentId: session.user.id,
      institutionId,
      source: "EXAM_START",
    }).catch(() => {/* evidence capture is best-effort */});

    return NextResponse.json(submission, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.submission.findUnique({
        where: { examId_studentId: { examId: id, studentId: session.user.id } },
      });
      if (winner) return NextResponse.json(winner);
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
