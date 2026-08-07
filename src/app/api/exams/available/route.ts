import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { attemptsRemaining } from "@/lib/assessmentLifecycle";
import { parseSecureSettings } from "@/lib/secureExam";
import { isStudentHistoryItem } from "@/lib/studentDashboardGrouping";

// Pilot UI release readiness v1 — see docs/tether-v1.7.2-pilot-release-readiness.md.
// A finalized (SUBMITTED/GRADED) exam the student cannot act on further
// stays useful only as recent history; without a cap this response grows
// forever as an institution accumulates completed exams. Bounded here
// (same 2 queries as before — this only trims the already-fetched,
// already-computed result array before it's serialized) rather than in
// CSS, so payload size stops growing with historical volume. `?all=true`
// (used by the dashboard's "Show all completed examinations" expansion)
// returns the full set for a student who deliberately asks for it.
const DEFAULT_COMPLETED_HISTORY_LIMIT = 20;

export async function GET(req?: Request) {
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
        const canStartAttempt = !inProgressSubmission && remainingAttempts > 0;

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
          availability: (isClosed ? "closed" : isUpcoming ? "upcoming" : "open") as "open" | "upcoming" | "closed",
          maxAttempts: settings.maxAttempts,
          remainingAttempts,
          canStartAttempt,
          submission: activeSubmission
            ? {
                id: activeSubmission.id,
                status: activeSubmission.status,
                attemptNumber: activeSubmission.attemptNumber,
                submittedAt: activeSubmission.submittedAt,
              }
            : null,
        };
      })
      // Hide exams that are closed and never started by this student —
      // nothing useful for the student to do with a closed exam they
      // never attempted. A closed exam they already have a submission
      // for remains visible so they can see their result.
      .filter((exam) => exam.availability !== "closed" || exam.submission !== null);

    // Pilot UI release readiness v1 — an exam with nothing further the
    // student can do (not in progress, no attempts left / no longer
    // open) is "history": useful for a "recently completed" list, but
    // must not grow this response forever. Actionable exams (in
    // progress, startable, or upcoming) are never capped — only the
    // no-further-action tail is, newest-first, so nothing actionable is
    // ever silently dropped. Response stays a plain array (unchanged
    // shape — several existing tests call GET() with no Request and
    // parse the body as an array directly), so this is purely additive:
    // `?all=true` (used by the dashboard's "Show all completed
    // examinations" expansion) returns the full history tail instead of
    // just the most recent DEFAULT_COMPLETED_HISTORY_LIMIT.
    const includeAllHistory = req != null && new URL(req.url).searchParams.get("all") === "true";
    const actionable = result.filter((exam) => !isStudentHistoryItem(exam));
    const history = result
      .filter(isStudentHistoryItem)
      .sort((a, b) => {
        const aTime = a.submission?.submittedAt ? new Date(a.submission.submittedAt).getTime() : 0;
        const bTime = b.submission?.submittedAt ? new Date(b.submission.submittedAt).getTime() : 0;
        return bTime - aTime;
      });
    const boundedHistory = includeAllHistory ? history : history.slice(0, DEFAULT_COMPLETED_HISTORY_LIMIT);

    return NextResponse.json([...actionable, ...boundedHistory]);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
