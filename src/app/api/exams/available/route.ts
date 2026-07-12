import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { attemptsRemaining } from "@/lib/assessmentLifecycle";
import { parseSecureSettings } from "@/lib/secureExam";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Course, Enrolment, Exam Assignment, Scheduling v1 — see
    // docs/course-enrolment-and-exam-assignment.md. A student may see an
    // exam via any of three independent paths:
    //   1. courseId is null — a legacy institution-wide exam, visible to
    //      every student in the institution exactly as before this
    //      feature shipped (see the doc's "Legacy exam visibility" plan).
    //   2. the exam's course uses assignmentMode COURSE and the student
    //      is enrolled in that course as a STUDENT.
    //   3. the student has a direct ExamAssignment row on the exam
    //      (assignmentMode SELECTED_STUDENTS).
    const studentCourseIds = (
      await prisma.courseEnrollment.findMany({
        where: { userId: session.user.id, role: "STUDENT" },
        select: { courseId: true },
      })
    ).map((e) => e.courseId);

    const exams = await prisma.exam.findMany({
      where: {
        published: true,
        ...institutionWhere(session),
        OR: [
          { courseId: null },
          { courseId: { in: studentCourseIds }, assignmentMode: "COURSE" },
          { assignments: { some: { studentId: session.user.id } } },
        ],
      },
      orderBy: { createdAt: "desc" },
      include: {
        submissions: {
          where: { studentId: session.user.id },
          orderBy: [{ attemptNumber: "desc" }, { startedAt: "desc" }],
        },
        _count: { select: { questions: true } },
        course: { select: { id: true, name: true, code: true } },
      },
    });

    const now = new Date();
    const result = exams
      .map((exam) => {
        // Availability window: only enforced if set on the exam (legacy
        // exams with neither field set have no window restriction).
        const opensAt = exam.availableFrom ?? exam.startsAt ?? null;
        const closesAt = exam.availableUntil ?? exam.endsAt ?? null;
        const isUpcoming = opensAt != null && now < opensAt;
        const isClosed = closesAt != null && now > closesAt;

        const settings = parseSecureSettings(exam.secureSettings);
        const inProgressSubmission = exam.submissions.find((submission) => submission.status === "IN_PROGRESS");
        const latestSubmission = exam.submissions[0] ?? null;
        const finalizedAttemptCount = exam.submissions.filter((submission) => submission.status !== "IN_PROGRESS").length;
        const remainingAttempts = attemptsRemaining({
          finalizedAttemptCount,
          maxAttempts: settings.maxAttempts,
        });
        const activeSubmission = inProgressSubmission ?? latestSubmission;

        return {
          id: exam.id,
          title: exam.title,
          description: exam.description,
          durationMins: exam.durationMins,
          startsAt: exam.startsAt,
          endsAt: exam.endsAt,
          availableFrom: exam.availableFrom,
          availableUntil: exam.availableUntil,
          questionCount: exam._count.questions,
          accessCodeRequired: exam.accessCodeRequired,
          course: exam.course,
          availability: isClosed ? "closed" : isUpcoming ? "upcoming" : "open",
          maxAttempts: settings.maxAttempts,
          remainingAttempts,
          canStartAttempt: !inProgressSubmission && remainingAttempts > 0,
          submission: activeSubmission
            ? {
                id: activeSubmission.id,
                status: activeSubmission.status,
                attemptNumber: activeSubmission.attemptNumber,
              }
            : null,
        };
      })
      // Hide exams that are closed and never started by this student —
      // nothing useful for the student to do with a closed exam they
      // never attempted. A closed exam they already have a submission
      // for remains visible so they can see their result.
      .filter((exam) => exam.availability !== "closed" || exam.submission !== null);

    return NextResponse.json(result);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
