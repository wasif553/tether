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
// forever as an institution accumulates completed exams.
//
// Production administration hardening v1 — see
// docs/tether-broad-rollout-readiness.md, "True DB-level history
// pagination". The cap below used to be applied only AFTER an unbounded
// `exam.findMany` had already fetched the student's ENTIRE historical
// exam list. It is now enforced at the query level: `loadStudentExams`
// below issues two `findMany` calls instead of one — an uncapped "current"
// query (anything not yet closed, OR closed but with an in-progress
// submission — see its own doc comment for why this is a safe, precise
// over-approximation that can never drop an actionable exam) and a
// separate, `take`-bounded "old, closed, no in-progress submission" query
// for the history tail. Neither query can regress result correctness:
// the split is exact (every exam is a member of exactly one side), not a
// heuristic time-window guess.
//
// `?all=true` remains supported for backward compatibility (existing
// callers/tests), returning the full unbounded history in one response —
// still a real, if less scalable, mode. `?historyOffset=N&historyLimit=M`
// is the new, real pagination mode: it fetches ONLY the next bounded page
// of history, via `skip`/`take` on the already-narrowed "old, closed"
// query, and returns `{ history, hasMore }` instead of the plain-array
// shape (opt-in — never returned unless historyOffset/historyLimit is
// explicitly passed).
const DEFAULT_COMPLETED_HISTORY_LIMIT = 20;

type StudentVisibilityScope = {
  studentId: string;
  studentCourseIds: string[];
  institution: { institutionId?: string };
};

function studentVisibilityWhere(scope: StudentVisibilityScope) {
  return {
    published: true,
    ...scope.institution,
    OR: [
      { courseId: null },
      { courseId: { in: scope.studentCourseIds }, assignmentMode: "COURSE" as const },
      { assignments: { some: { studentId: scope.studentId } } },
    ],
  };
}

const examIncludeForStudent = (studentId: string) => ({
  submissions: {
    where: { studentId },
    orderBy: [{ attemptNumber: "desc" as const }, { startedAt: "desc" as const }],
  },
  _count: { select: { questions: true } },
  course: { select: { id: true, name: true, code: true } },
});

/**
 * Precise, over-approximating "possibly still actionable" query — never a
 * heuristic recency window. Captures: exams with no closing date, exams
 * not yet closed, AND (regardless of window) any exam this student has an
 * IN_PROGRESS submission for — the one case that must never be excluded
 * by a "closed" filter, since a student can still be mid-attempt on an
 * exam whose window has technically lapsed. Always fetched in full
 * (uncapped): this is exactly the previously-uncapped "actionable" set,
 * now computed at the query level instead of in application code after a
 * full-table fetch.
 */
async function loadCurrentStudentExams(scope: StudentVisibilityScope, now: Date) {
  // BUG FIX (caught by the existing course/assignment-visibility test
  // suite during release:validate) — `studentVisibilityWhere(scope)`
  // returns an object with its own `OR` key. Spreading it and then
  // setting a SECOND `OR` key on the same object literal does not
  // combine them — the second `OR` silently overwrites the first,
  // discarding the course/assignment visibility filter entirely and
  // exposing every published exam in the institution regardless of
  // enrollment. Both OR conditions must be combined explicitly via
  // `AND: [{OR: ...}, {OR: ...}]` — never two top-level `OR` keys on the
  // same where object.
  const visibility = studentVisibilityWhere(scope);
  return prisma.exam.findMany({
    where: {
      published: visibility.published,
      ...scope.institution,
      AND: [
        { OR: visibility.OR },
        {
          OR: [
            { availableUntil: null },
            { availableUntil: { gte: now } },
            { submissions: { some: { studentId: scope.studentId, status: "IN_PROGRESS" as const } } },
          ],
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    include: examIncludeForStudent(scope.studentId),
  });
}

/**
 * The complement of loadCurrentStudentExams above — definitively closed
 * AND with no in-progress submission for this student (so never a
 * duplicate of anything loadCurrentStudentExams already returned).
 * `take`/`skip`-bounded: this is the query that actually stops payload
 * size from growing with an institution's accumulated historical exam
 * count.
 */
function oldStudentExamsWhere(scope: StudentVisibilityScope, now: Date) {
  return {
    ...studentVisibilityWhere(scope),
    availableUntil: { lt: now },
    submissions: { none: { studentId: scope.studentId, status: "IN_PROGRESS" as const } },
  };
}

/**
 * `take`/`skip`-bounded — this is the query that actually stops payload
 * size from growing with an institution's accumulated historical exam
 * count. Ordered by the exam's own `availableUntil` (not the student's
 * `submittedAt`, which isn't a column Prisma can order a *this* query
 * by without an extra join) — a close, but not perfect, proxy for
 * recency. In the rare case a student's actual submittedAt diverges
 * significantly from the exam's closing date (e.g. a very late
 * allowed-late submission on an otherwise old exam), that item may not
 * surface in the default bounded view until `?all=true` or a further
 * history page is requested — never affects the actionable set above,
 * which is never bounded.
 */
async function loadOldStudentExamsPage(scope: StudentVisibilityScope, now: Date, offset: number, limit: number) {
  return prisma.exam.findMany({
    where: oldStudentExamsWhere(scope, now),
    orderBy: [{ availableUntil: "desc" }, { id: "desc" }],
    skip: offset,
    take: limit + 1, // +1 so the caller can detect hasMore without a separate count query
    include: examIncludeForStudent(scope.studentId),
  });
}

/** Legacy/compat unbounded fetch — backs `?all=true` exactly as before this pass, for a student who explicitly asks to see everything. */
async function loadAllOldStudentExams(scope: StudentVisibilityScope, now: Date) {
  return prisma.exam.findMany({
    where: oldStudentExamsWhere(scope, now),
    orderBy: [{ availableUntil: "desc" }, { id: "desc" }],
    include: examIncludeForStudent(scope.studentId),
  });
}

type StudentExamRow = Awaited<ReturnType<typeof loadCurrentStudentExams>>[number];

/**
 * Pure per-exam view computation — extracted so both the default combined
 * response and the new paginated-history-page response compute the exact
 * same shape from the exact same logic. Unchanged from the pre-pagination
 * version of this route: still filters out a closed exam the student
 * never attempted (nothing useful to show for it).
 */
function computeStudentExamView(exams: StudentExamRow[], now: Date) {
  return exams
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
}

function sortStudentHistoryBySubmittedAtDesc<T extends { submission: { submittedAt: Date | string | null } | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTime = a.submission?.submittedAt ? new Date(a.submission.submittedAt).getTime() : 0;
    const bTime = b.submission?.submittedAt ? new Date(b.submission.submittedAt).getTime() : 0;
    return bTime - aTime;
  });
}

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

    const now = new Date();
    const scope: StudentVisibilityScope = { studentId: session.user.id, studentCourseIds, institution: institutionWhere(session) };

    const url = req != null ? new URL(req.url) : null;
    const includeAllHistory = url?.searchParams.get("all") === "true";
    const historyOffsetRaw = url?.searchParams.get("historyOffset");
    const historyLimitRaw = url?.searchParams.get("historyLimit");
    const isHistoryPageRequest = historyOffsetRaw != null || historyLimitRaw != null;

    if (isHistoryPageRequest) {
      // New, real pagination mode — fetches ONLY the next bounded page of
      // history via the DB-level `skip`/`take` query above, never the
      // "current" set (already delivered by the initial, unpaginated
      // request). Response shape is deliberately different ({history,
      // hasMore}) so a caller can never confuse this with the default
      // plain-array response.
      const offset = Math.max(0, Number(historyOffsetRaw) || 0);
      const limit = Math.min(100, Math.max(1, Number(historyLimitRaw) || DEFAULT_COMPLETED_HISTORY_LIMIT));
      const page = await loadOldStudentExamsPage(scope, now, offset, limit);
      const hasMore = page.length > limit;
      const pageExams = sortStudentHistoryBySubmittedAtDesc(computeStudentExamView(page.slice(0, limit), now));
      return NextResponse.json({ history: pageExams, hasMore });
    }

    const currentExams = await loadCurrentStudentExams(scope, now);
    const oldExams = includeAllHistory ? await loadAllOldStudentExams(scope, now) : (await loadOldStudentExamsPage(scope, now, 0, DEFAULT_COMPLETED_HISTORY_LIMIT)).slice(0, DEFAULT_COMPLETED_HISTORY_LIMIT);

    // Pilot UI release readiness v1 — an exam with nothing further the
    // student can do (not in progress, no attempts left / no longer
    // open) is "history": useful for a "recently completed" list, but
    // must not grow this response forever. Actionable exams (in
    // progress, startable, or upcoming) are never capped — only the
    // no-further-action tail is, newest-first, so nothing actionable is
    // ever silently dropped. Response stays a plain array (unchanged
    // shape — several existing tests call GET() with no Request and
    // parse the body as an array directly).
    //
    // Production administration hardening v1 — `currentExams` may itself
    // contain a handful of items that compute to "history" (e.g. a
    // currently-open exam whose attempts this student has exhausted —
    // still "not closed" at the query level, so loadCurrentStudentExams
    // correctly includes it, but studentDashboardGroup still classifies
    // it as completed). These are merged with `oldExams`'s contributions
    // before the final submittedAt-desc sort/cap, so the bounded result
    // is exactly as correct as the pre-pagination version was — just
    // computed from two bounded queries instead of one unbounded one.
    const combinedView = computeStudentExamView([...currentExams, ...oldExams], now);
    const actionable = combinedView.filter((exam) => !isStudentHistoryItem(exam));
    const history = sortStudentHistoryBySubmittedAtDesc(combinedView.filter(isStudentHistoryItem));
    const boundedHistory = includeAllHistory ? history : history.slice(0, DEFAULT_COMPLETED_HISTORY_LIMIT);

    return NextResponse.json([...actionable, ...boundedHistory]);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
