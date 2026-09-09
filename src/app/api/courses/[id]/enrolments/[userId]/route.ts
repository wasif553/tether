import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  isPlatformAdmin,
  assertSameInstitution,
  institutionErrorResponse,
} from "@/lib/institutionScope";
import { canRemoveCourseEnrollment } from "@/lib/courseTeachingTeam";

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

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "STUDENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id: courseId, userId } = await params;
    const course = await getManageableCourse(courseId, session);
    if (course === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (course === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const targetEnrollment = await prisma.courseEnrollment.findUnique({
      where: { courseId_userId: { courseId, userId } },
      select: { role: true },
    });
    if (!targetEnrollment) {
      return NextResponse.json({ error: "Enrolment not found" }, { status: 404 });
    }

    const actorRole = isPlatformAdmin(session) ? "PLATFORM_ADMIN" : "LECTURER";
    if (!canRemoveCourseEnrollment(actorRole, targetEnrollment.role)) {
      return NextResponse.json(
        { error: "Only a platform administrator can remove a lecturer from a course." },
        { status: 403 },
      );
    }

    await prisma.courseEnrollment.delete({
      where: { courseId_userId: { courseId, userId } },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
