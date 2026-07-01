import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, requireInstitutionId, institutionErrorResponse } from "@/lib/institutionScope";
import { assertCanAssignExamToCourse, assertStudentsInCourse, CourseAssignmentError } from "@/lib/courseAssignment";

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

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const exams = await prisma.exam.findMany({
      where: { createdById: session.user.id, ...institutionWhere(session) },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { questions: true, submissions: true } },
        course: { select: { id: true, name: true, code: true } },
      },
    });

    // Never include accessCodeHash in any API response — see
    // docs/student-onboarding-and-exam-access.md.
    const sanitized = exams.map((exam) => {
      const rest: Partial<typeof exam> = { ...exam };
      delete rest.accessCodeHash;
      return rest;
    });
    return NextResponse.json(sanitized);
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
