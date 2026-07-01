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

const enrolSchema = z
  .object({
    userId: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: z.enum(["STUDENT", "LECTURER"]),
  })
  .refine((data) => data.userId || data.email, {
    message: "userId or email is required",
  });

/** Fetches the course and asserts the caller may manage its enrolments. */
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "STUDENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id: courseId } = await params;
    const course = await getManageableCourse(courseId, session);
    if (course === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (course === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const parsed = enrolSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    // Target user must exist in the same institution as the course — an
    // enrolment is not a mechanism to cross institution boundaries.
    const targetUser = parsed.data.userId
      ? await prisma.user.findUnique({ where: { id: parsed.data.userId } })
      : parsed.data.email
        ? await prisma.user.findUnique({ where: { email: parsed.data.email } })
        : null;
    if (!targetUser || targetUser.institutionId !== course.institutionId) {
      return NextResponse.json(
        { error: "User does not belong to this institution" },
        { status: 400 },
      );
    }

    const enrollment = await prisma.courseEnrollment.upsert({
      where: { courseId_userId: { courseId, userId: targetUser.id } },
      update: { role: parsed.data.role },
      create: { courseId, userId: targetUser.id, role: parsed.data.role },
    });

    return NextResponse.json(enrollment, { status: 201 });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
