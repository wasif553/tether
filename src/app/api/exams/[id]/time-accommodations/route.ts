/**
 * Individual Exam Timing & Accommodations v1 — see
 * src/lib/examTimeAccommodation.ts and
 * docs/exam-time-accommodations-v1.md.
 *
 * GET  /api/exams/[id]/time-accommodations — list accommodations for
 *   lecturer editing, plus the exam's standard duration and the exam's
 *   eligible-student population (for the "add accommodation" picker).
 * POST /api/exams/[id]/time-accommodations — create (or, if one already
 *   exists for this student, update) an accommodation.
 *
 * Lecturer (owner of the exam) only — never reachable by a student. This
 * endpoint only ever reads/writes the operational adjustment
 * (adjustmentMode/adjustmentValue) — no diagnosis, disability type, or
 * free-text reason field exists anywhere in this contract.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse, requireInstitutionId } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import {
  EXAM_TIME_ACCOMMODATION_MODES,
  resolveEffectiveExamDurationMins,
  InvalidExamTimeAccommodationError,
} from "@/lib/examTimeAccommodation";

const upsertAccommodationSchema = z.object({
  studentId: z.string().min(1),
  adjustmentMode: z.enum(EXAM_TIME_ACCOMMODATION_MODES),
  adjustmentValue: z.number().int().positive(),
});

async function getOwnedExam(examId: string, lecturerId: string, session: Parameters<typeof institutionWhere>[0]) {
  return prisma.exam.findFirst({
    where: { id: examId, createdById: lecturerId, ...institutionWhere(session) },
  });
}

/**
 * Mirrors the exact student-access rule POST /api/exams/[id]/start uses
 * (see that route's own "Course, Enrolment, Exam Assignment, Scheduling
 * v1" check) plus the legacy institution-wide case it handles implicitly
 * via its own auth gate — a lecturer must never be able to create an
 * accommodation for a student who could not actually take this exam.
 */
async function isStudentEligibleForExam(
  exam: { id: string; courseId: string | null; assignmentMode: "COURSE" | "SELECTED_STUDENTS"; institutionId: string | null },
  studentId: string,
): Promise<boolean> {
  if (!exam.courseId) {
    const student = await prisma.user.findUnique({
      where: { id: studentId },
      select: { role: true, institutionId: true },
    });
    return student?.role === "STUDENT" && student.institutionId === exam.institutionId;
  }
  if (exam.assignmentMode === "COURSE") {
    const enrolled = await prisma.courseEnrollment.findUnique({
      where: { courseId_userId: { courseId: exam.courseId, userId: studentId } },
    });
    return enrolled?.role === "STUDENT";
  }
  const assigned = await prisma.examAssignment.findUnique({
    where: { examId_studentId: { examId: exam.id, studentId } },
  });
  return assigned != null;
}

/** The full eligible-student population for this exam's access rules — used for the lecturer's "add accommodation" student picker. */
async function listEligibleStudents(exam: {
  id: string;
  courseId: string | null;
  assignmentMode: "COURSE" | "SELECTED_STUDENTS";
  institutionId: string | null;
}) {
  const select = { id: true, name: true, email: true, institutionStudentId: true } as const;
  if (!exam.courseId) {
    return prisma.user.findMany({ where: { institutionId: exam.institutionId, role: "STUDENT" }, select, orderBy: { name: "asc" } });
  }
  if (exam.assignmentMode === "COURSE") {
    const enrollments = await prisma.courseEnrollment.findMany({
      where: { courseId: exam.courseId, role: "STUDENT" },
      include: { user: { select } },
    });
    return enrollments.map((e) => e.user);
  }
  const assignments = await prisma.examAssignment.findMany({
    where: { examId: exam.id },
    include: { student: { select } },
  });
  return assignments.map((a) => a.student);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const exam = await getOwnedExam(id, session.user.id, session);
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [accommodations, eligibleStudents] = await Promise.all([
      prisma.examTimeAccommodation.findMany({
        where: { examId: id },
        include: { student: { select: { id: true, name: true, email: true, institutionStudentId: true } } },
        orderBy: { createdAt: "asc" },
      }),
      listEligibleStudents(exam),
    ]);

    // Cheap, read-only, best-effort UX signal only — never used to alter
    // any enforcement decision. See "In-progress student warning" in
    // docs/exam-time-accommodations-v1.md: server behaviour already
    // protects an active attempt regardless of this flag.
    const inProgressStudentIds = new Set(
      (
        await prisma.submission.findMany({
          where: { examId: id, status: "IN_PROGRESS", studentId: { in: accommodations.map((a) => a.studentId) } },
          select: { studentId: true },
        })
      ).map((s) => s.studentId),
    );

    return NextResponse.json({
      standardDurationMins: exam.durationMins,
      accommodations: accommodations.map((a) => ({
        id: a.id,
        studentId: a.studentId,
        name: a.student.name,
        email: a.student.email,
        institutionStudentId: a.student.institutionStudentId,
        adjustmentMode: a.adjustmentMode,
        adjustmentValue: a.adjustmentValue,
        effectiveDurationMins: resolveEffectiveExamDurationMins({
          standardDurationMins: exam.durationMins,
          accommodation: { adjustmentMode: a.adjustmentMode as never, adjustmentValue: a.adjustmentValue },
        }),
        hasInProgressAttempt: inProgressStudentIds.has(a.studentId),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      eligibleStudents,
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const exam = await getOwnedExam(id, session.user.id, session);
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = upsertAccommodationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { studentId, adjustmentMode, adjustmentValue } = parsed.data;

    const eligible = await isStudentEligibleForExam(exam, studentId);
    if (!eligible) {
      return NextResponse.json({ error: "This student does not have access to this exam." }, { status: 400 });
    }

    let effectiveDurationMins: number;
    try {
      effectiveDurationMins = resolveEffectiveExamDurationMins({
        standardDurationMins: exam.durationMins,
        accommodation: { adjustmentMode, adjustmentValue },
      });
    } catch (err) {
      if (err instanceof InvalidExamTimeAccommodationError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    const existing = await prisma.examTimeAccommodation.findUnique({
      where: { examId_studentId: { examId: id, studentId } },
    });

    const accommodation = await prisma.examTimeAccommodation.upsert({
      where: { examId_studentId: { examId: id, studentId } },
      update: { adjustmentMode, adjustmentValue },
      create: { examId: id, studentId, adjustmentMode, adjustmentValue, createdById: session.user.id },
      include: { student: { select: { id: true, name: true, email: true, institutionStudentId: true } } },
    });

    const institutionId = requireInstitutionId(session);
    createPlatformAuditLog({
      actorId: session.user.id,
      action: existing ? "EXAM_TIME_ACCOMMODATION_UPDATED" : "EXAM_TIME_ACCOMMODATION_CREATED",
      targetType: "ExamTimeAccommodation",
      targetId: accommodation.id,
      institutionId,
      metadata: {
        examId: id,
        studentId,
        adjustmentMode,
        adjustmentValue,
        standardDurationMins: exam.durationMins,
        effectiveDurationMins,
      },
    }).catch(() => {});

    return NextResponse.json(
      {
        id: accommodation.id,
        studentId: accommodation.studentId,
        name: accommodation.student.name,
        email: accommodation.student.email,
        institutionStudentId: accommodation.student.institutionStudentId,
        adjustmentMode: accommodation.adjustmentMode,
        adjustmentValue: accommodation.adjustmentValue,
        effectiveDurationMins,
        createdAt: accommodation.createdAt,
        updatedAt: accommodation.updatedAt,
      },
      { status: existing ? 200 : 201 },
    );
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
