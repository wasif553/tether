import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, secureSettingsInputSchema } from "@/lib/secureExam";
import type { Prisma } from "@/generated/prisma/client";
import { assertSameInstitution, institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { assertCanAssignExamToCourse, assertStudentsInCourse, CourseAssignmentError } from "@/lib/courseAssignment";

const updateExamSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    durationMins: z.number().int().positive().optional(),
    published: z.boolean().optional(),
    startsAt: z.string().datetime().optional().nullable(),
    endsAt: z.string().datetime().optional().nullable(),
    secureSettings: secureSettingsInputSchema.optional(),
    // Student Onboarding and Exam Access v1 — see
    // docs/student-onboarding-and-exam-access.md. undefined = leave
    // unchanged, null = clear the code, a string = set a new code.
    accessCode: z.string().min(4).nullable().optional(),
    // Course, Enrolment, Exam Assignment, Scheduling v1 — see
    // docs/course-enrolment-and-exam-assignment.md. courseId: null clears
    // the course link (reverts to a legacy institution-wide exam).
    courseId: z.string().min(1).nullable().optional(),
    assignmentMode: z.enum(["COURSE", "SELECTED_STUDENTS"]).optional(),
    // Replaces the full selected-student list when provided (and
    // assignmentMode is SELECTED_STUDENTS) — not an incremental add.
    selectedStudentIds: z.array(z.string().min(1)).optional(),
    availableFrom: z.string().datetime().nullable().optional(),
    availableUntil: z.string().datetime().nullable().optional(),
  })
  .refine(
    (data) =>
      !data.availableFrom || !data.availableUntil || data.availableUntil > data.availableFrom,
    { message: "availableUntil must be after availableFrom", path: ["availableUntil"] },
  );

/** Strips accessCodeHash from any exam object before it's ever sent in a response. */
function omitAccessCodeHash<T extends { accessCodeHash?: string | null }>(
  exam: T,
): Omit<T, "accessCodeHash"> {
  const rest: Partial<T> = { ...exam };
  delete rest.accessCodeHash;
  return rest as Omit<T, "accessCodeHash">;
}

async function getOwnedExam(examId: string, lecturerId: string, session: Parameters<typeof institutionWhere>[0]) {
  return prisma.exam.findFirst({
    where: { id: examId, createdById: lecturerId, ...institutionWhere(session) },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const exam = await prisma.exam.findUnique({
      where: { id },
      include: {
        questions: { orderBy: { order: "asc" } },
        // Question Pools v1 — see docs/question-pools-v1.md. Lecturer-only
        // (stripped from the student-facing response below) — a student
        // must never see pool names/draw counts/which questions are in a
        // pool.
        questionPools: { orderBy: { order: "asc" } },
      },
    });

    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Both the lecturer-owner path and the student-view path are direct-ID
    // access — assert institution membership before any role-specific
    // branching below, so a student/lecturer in another institution gets a
    // generic 403/404 rather than reaching the data at all.
    assertSameInstitution(session, exam.institutionId);

    if (session.user.role === "LECTURER" && exam.createdById !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Secure Exam Mode settings are not sensitive — students need them to
    // know whether fullscreen is required, copy/paste is blocked, etc.
    const secureSettings = parseSecureSettings(exam.secureSettings);

    if (session.user.role === "STUDENT") {
      if (!exam.published) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      // Question Pools v1 — a student must never see pool names, draw
      // counts, or which pool a question belongs to (see
      // docs/question-pools-v1.md, "What students see").
      const examWithoutPools = { ...omitAccessCodeHash(exam) } as Partial<typeof exam>;
      delete examWithoutPools.questionPools;
      const sanitized = {
        ...examWithoutPools,
        secureSettings,
        questions: exam.questions.map((q) => ({ ...q, correctAnswer: undefined, questionPoolId: undefined })),
      };
      return NextResponse.json(sanitized);
    }

    return NextResponse.json({ ...omitAccessCodeHash(exam), secureSettings });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function PATCH(
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
    const parsed = updateExamSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const {
      startsAt,
      endsAt,
      secureSettings,
      accessCode,
      courseId,
      assignmentMode,
      selectedStudentIds,
      availableFrom,
      availableUntil,
      ...rest
    } = parsed.data;

    const mergedSecureSettings = secureSettings
      ? parseSecureSettings({ ...parseSecureSettings(exam.secureSettings), ...secureSettings })
      : undefined;

    // accessCode: undefined leaves it untouched, null clears it, a string
    // sets a new one. The plaintext code is never stored — only its hash.
    let accessCodeFields: { accessCodeHash: string | null; accessCodeRequired: boolean } | undefined;
    if (accessCode === null) {
      accessCodeFields = { accessCodeHash: null, accessCodeRequired: false };
    } else if (typeof accessCode === "string") {
      accessCodeFields = { accessCodeHash: await bcrypt.hash(accessCode, 12), accessCodeRequired: true };
    }

    // Course/assignment: courseId undefined leaves it untouched, null
    // clears it (reverts to legacy institution-wide exam), a string sets
    // it — but only after verifying the lecturer teaches that course.
    const effectiveCourseId = courseId !== undefined ? courseId : exam.courseId;
    if (courseId) {
      await assertCanAssignExamToCourse(session, courseId);
    }
    if (
      effectiveCourseId &&
      (assignmentMode === "SELECTED_STUDENTS" || (assignmentMode === undefined && exam.assignmentMode === "SELECTED_STUDENTS")) &&
      selectedStudentIds
    ) {
      await assertStudentsInCourse(effectiveCourseId, selectedStudentIds);
    }

    const updated = await prisma.exam.update({
      where: { id },
      data: {
        ...rest,
        ...(accessCodeFields ?? {}),
        ...(courseId !== undefined ? { courseId } : {}),
        ...(assignmentMode !== undefined ? { assignmentMode } : {}),
        ...(startsAt !== undefined ? { startsAt: startsAt ? new Date(startsAt) : null } : {}),
        ...(endsAt !== undefined ? { endsAt: endsAt ? new Date(endsAt) : null } : {}),
        ...(availableFrom !== undefined
          ? { availableFrom: availableFrom ? new Date(availableFrom) : null }
          : {}),
        ...(availableUntil !== undefined
          ? { availableUntil: availableUntil ? new Date(availableUntil) : null }
          : {}),
        ...(mergedSecureSettings
          ? { secureSettings: mergedSecureSettings as Prisma.InputJsonValue }
          : {}),
        // selectedStudentIds replaces the full ExamAssignment set for this
        // exam — deleteMany + create in the same update call via nested
        // writes so it's atomic with the rest of the PATCH.
        ...(selectedStudentIds
          ? {
              assignments: {
                deleteMany: {},
                create: selectedStudentIds.map((studentId) => ({ studentId })),
              },
            }
          : {}),
      },
    });

    return NextResponse.json({
      ...omitAccessCodeHash(updated),
      secureSettings: parseSecureSettings(updated.secureSettings),
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    if (err instanceof CourseAssignmentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function DELETE(
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

    await prisma.exam.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
