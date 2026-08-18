import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, requireInstitutionId, institutionErrorResponse } from "@/lib/institutionScope";
import { assertCanAssignExamToCourse, assertStudentsInCourse, CourseAssignmentError } from "@/lib/courseAssignment";
import { isLecturerClosedHistoryItem } from "@/lib/lecturerDashboardGrouping";

const createExamSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    durationMins: z.number().int().positive(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    // Course, Enrolment, Exam Assignment, Scheduling v1 — see
    // docs/course-enrolment-and-exam-assignment.md. courseId omitted or
    // null means this is a legacy institution-wide exam.
    courseId: z.string().min(1).optional(),
    assignmentMode: z.enum(["COURSE", "SELECTED_STUDENTS"]).optional(),
    selectedStudentIds: z.array(z.string().min(1)).optional(),
    availableFrom: z.string().datetime().optional(),
    availableUntil: z.string().datetime().optional(),
  })
  .refine(
    (data) => !data.availableFrom || !data.availableUntil || data.availableUntil > data.availableFrom,
    { message: "availableUntil must be after availableFrom", path: ["availableUntil"] },
  );

// Pilot UI release readiness v1 — see
// docs/tether-v1.7.2-pilot-release-readiness.md. Same rationale/pattern
// as GET /api/exams/available (student list): bounds response growth for
// a lecturer with many years of closed exams without adding a query per
// exam. Drafts and anything still open/scheduled are never capped, and —
// critically — neither is a closed exam that still needs review
// (isLecturerClosedHistoryItem excludes it), so "Needs your attention"
// can never silently lose an item to this cap.
//
// Production administration hardening v1 — see
// docs/tether-broad-rollout-readiness.md, "True DB-level history
// pagination". The cap used to be applied only AFTER an unbounded
// `exam.findMany` fetched a lecturer's ENTIRE exam history. Now:
//   1. the needs-review groupBy runs FIRST (scoped directly to this
//      lecturer's exams via a relation filter — it no longer needs the
//      exam list fetched first), giving the exact set of exam ids that
//      must never be excluded from the "current" query regardless of
//      how old/closed they are;
//   2. an uncapped "current" query (draft, scheduled, still-open, no
//      window, OR needs review) — the precise complement of
//      isLecturerClosedHistoryItem, so this can never drop an active or
//      needs-attention item;
//   3. a `take`/`skip`-bounded "closed, review already clear" query for
//      the history tail — this is what actually stops payload size from
//      growing with a lecturer's accumulated closed-exam count.
const DEFAULT_CLOSED_HISTORY_LIMIT = 20;

type LecturerScope = { createdById: string; institution: { institutionId?: string } };

/** ONE aggregate query for every exam this lecturer owns at once — index-backed (IntegrityEvent @@index([examId]), @@index([reviewStatus])) — never a query per exam, and no longer needs the exam list fetched first. */
async function loadLecturerNeedsReviewCounts(scope: LecturerScope): Promise<Map<string, number>> {
  const reviewCounts = await prisma.integrityEvent.groupBy({
    by: ["examId"],
    where: { reviewStatus: "NEEDS_REVIEW", exam: { createdById: scope.createdById, ...scope.institution } },
    _count: { _all: true },
  });
  return new Map(reviewCounts.map((row) => [row.examId, row._count._all]));
}

const lecturerExamInclude = {
  _count: { select: { questions: true, submissions: true } },
  course: { select: { id: true, name: true, code: true } },
};

/**
 * Precise, over-approximating "current" query — the exact complement of
 * isLecturerClosedHistoryItem, computed at the query level: draft
 * (unpublished), scheduled (availableFrom in the future), still-open (no
 * availableUntil, or availableUntil not yet passed), OR needing review
 * regardless of window. Always fetched in full (uncapped) — this is
 * exactly the previously-uncapped "active" set.
 */
async function loadCurrentLecturerExams(scope: LecturerScope, now: Date, needsReviewExamIds: string[]) {
  return prisma.exam.findMany({
    where: {
      createdById: scope.createdById,
      ...scope.institution,
      OR: [
        { published: false },
        { availableFrom: { gt: now } },
        { availableUntil: null },
        { availableUntil: { gte: now } },
        ...(needsReviewExamIds.length ? [{ id: { in: needsReviewExamIds } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    include: lecturerExamInclude,
  });
}

function oldLecturerExamsWhere(scope: LecturerScope, now: Date, needsReviewExamIds: string[]) {
  return {
    createdById: scope.createdById,
    ...scope.institution,
    published: true,
    availableUntil: { lt: now },
    ...(needsReviewExamIds.length ? { id: { notIn: needsReviewExamIds } } : {}),
  };
}

/** `take`/`skip`-bounded — the query that stops payload size from growing with a lecturer's accumulated closed-exam count. */
async function loadOldLecturerExamsPage(scope: LecturerScope, now: Date, needsReviewExamIds: string[], offset: number, limit: number) {
  return prisma.exam.findMany({
    where: oldLecturerExamsWhere(scope, now, needsReviewExamIds),
    orderBy: [{ availableUntil: "desc" }, { id: "desc" }],
    skip: offset,
    take: limit + 1,
    include: lecturerExamInclude,
  });
}

/** Legacy/compat unbounded fetch — backs `?all=true` exactly as before this pass. */
async function loadAllOldLecturerExams(scope: LecturerScope, now: Date, needsReviewExamIds: string[]) {
  return prisma.exam.findMany({
    where: oldLecturerExamsWhere(scope, now, needsReviewExamIds),
    orderBy: [{ availableUntil: "desc" }, { id: "desc" }],
    include: lecturerExamInclude,
  });
}

type LecturerExamRow = Awaited<ReturnType<typeof loadCurrentLecturerExams>>[number];

/** Never includes accessCodeHash or standaloneInviteTokenHash in any API response. Attaches needsReviewCount from the map built up-front. */
function sanitizeLecturerExam(exam: LecturerExamRow, needsReviewByExamId: Map<string, number>) {
  const rest: Partial<LecturerExamRow> & { needsReviewCount?: number } = { ...exam };
  delete rest.accessCodeHash;
  delete rest.standaloneInviteTokenHash;
  rest.needsReviewCount = needsReviewByExamId.get(exam.id) ?? 0;
  return rest;
}

function sortLecturerHistoryByClosedDesc<T extends { availableUntil?: Date | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.availableUntil?.getTime() ?? 0) - (a.availableUntil?.getTime() ?? 0));
}

export async function GET(req?: Request) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();
    const scope: LecturerScope = { createdById: session.user.id, institution: institutionWhere(session) };
    const needsReviewByExamId = await loadLecturerNeedsReviewCounts(scope);
    const needsReviewExamIds = [...needsReviewByExamId.keys()];

    const url = req != null ? new URL(req.url) : null;
    const includeAllHistory = url?.searchParams.get("all") === "true";
    const historyOffsetRaw = url?.searchParams.get("historyOffset");
    const historyLimitRaw = url?.searchParams.get("historyLimit");
    const isHistoryPageRequest = historyOffsetRaw != null || historyLimitRaw != null;

    if (isHistoryPageRequest) {
      const offset = Math.max(0, Number(historyOffsetRaw) || 0);
      const limit = Math.min(100, Math.max(1, Number(historyLimitRaw) || DEFAULT_CLOSED_HISTORY_LIMIT));
      const page = await loadOldLecturerExamsPage(scope, now, needsReviewExamIds, offset, limit);
      const hasMore = page.length > limit;
      const sanitizedPage = sortLecturerHistoryByClosedDesc(page.slice(0, limit).map((exam) => sanitizeLecturerExam(exam, needsReviewByExamId)));
      return NextResponse.json({ history: sanitizedPage, hasMore });
    }

    const currentExams = await loadCurrentLecturerExams(scope, now, needsReviewExamIds);
    const oldExams = includeAllHistory
      ? await loadAllOldLecturerExams(scope, now, needsReviewExamIds)
      : (await loadOldLecturerExamsPage(scope, now, needsReviewExamIds, 0, DEFAULT_CLOSED_HISTORY_LIMIT)).slice(0, DEFAULT_CLOSED_HISTORY_LIMIT);

    const sanitized = [...currentExams, ...oldExams].map((exam) => sanitizeLecturerExam(exam, needsReviewByExamId));
    const isHistory = (exam: (typeof sanitized)[number]) => isLecturerClosedHistoryItem(exam as { published: boolean; availableFrom: Date | null; availableUntil: Date | null; needsReviewCount: number }, now);
    const active = sanitized.filter((exam) => !isHistory(exam));
    const closedHistory = sortLecturerHistoryByClosedDesc(sanitized.filter(isHistory));
    const boundedHistory = includeAllHistory ? closedHistory : closedHistory.slice(0, DEFAULT_CLOSED_HISTORY_LIMIT);

    return NextResponse.json([...active, ...boundedHistory]);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = createExamSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const {
    title,
    description,
    durationMins,
    startsAt,
    endsAt,
    courseId,
    assignmentMode,
    selectedStudentIds,
    availableFrom,
    availableUntil,
  } = parsed.data;

  try {
    if (courseId) {
      await assertCanAssignExamToCourse(session, courseId);
      if (assignmentMode === "SELECTED_STUDENTS" && selectedStudentIds?.length) {
        await assertStudentsInCourse(courseId, selectedStudentIds);
      }
    }

    const exam = await prisma.exam.create({
      data: {
        title,
        description,
        durationMins,
        startsAt: startsAt ? new Date(startsAt) : undefined,
        endsAt: endsAt ? new Date(endsAt) : undefined,
        createdById: session.user.id,
        institutionId: requireInstitutionId(session),
        courseId: courseId ?? undefined,
        assignmentMode: assignmentMode ?? undefined,
        availableFrom: availableFrom ? new Date(availableFrom) : undefined,
        availableUntil: availableUntil ? new Date(availableUntil) : undefined,
        ...(courseId && assignmentMode === "SELECTED_STUDENTS" && selectedStudentIds?.length
          ? { assignments: { create: selectedStudentIds.map((studentId) => ({ studentId })) } }
          : {}),
      },
    });

    return NextResponse.json(exam, { status: 201 });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    if (err instanceof CourseAssignmentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
