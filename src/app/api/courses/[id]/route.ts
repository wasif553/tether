import { NextResponse } from "next/server";
import { z } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  isPlatformAdmin,
  assertSameInstitution,
  institutionErrorResponse,
} from "@/lib/institutionScope";

const updateCourseSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
});

/** Fetches the course and asserts the caller may manage it (platform admin, or a lecturer enrolled on it). */
async function getManageableCourse(courseId: string, session: Session) {
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course) return null;
  assertSameInstitution(session, course.institutionId);

  if (!isPlatformAdmin(session) && session.user.role === "LECTURER") {
    const enrolled = await prisma.courseEnrollment.findUnique({
      where: { courseId_userId: { courseId, userId: session.user.id } },
    });
    if (!enrolled || enrolled.role !== "LECTURER") return "forbidden" as const;
  }
  return course;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "STUDENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const course = await getManageableCourse(id, session);
    if (course === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (course === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const enrollments = await prisma.courseEnrollment.findMany({
      where: { courseId: id },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true, institutionStudentId: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({ ...course, enrollments });
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
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "STUDENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const course = await getManageableCourse(id, session);
    if (course === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (course === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const parsed = updateCourseSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const updated = await prisma.course.update({ where: { id }, data: parsed.data });
    return NextResponse.json(updated);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
