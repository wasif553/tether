/**
 * Tether Course Invitation + Acceptance v1 — see
 * docs/tether-course-invitation-acceptance-v1.md.
 *
 * DELETE /api/courses/[id]/invitations/[invitationId] — revoke a
 * pending invitation. Invalidates it for future acceptance only: never
 * alters User.institutionId, never alters any existing
 * CourseEnrollment, never affects exams/submissions. Does not delete
 * the row — retained as minimal lifecycle/audit evidence.
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

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
  { params }: { params: Promise<{ id: string; invitationId: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role === "STUDENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id: courseId, invitationId } = await params;
    const course = await getManageableCourse(courseId, session);
    if (course === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (course === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const invitation = await prisma.courseEnrollmentInvitation.findUnique({
      where: { id: invitationId },
    });
    if (!invitation || invitation.courseId !== courseId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (invitation.acceptedAt) {
      return NextResponse.json(
        { error: "This invitation has already been accepted and cannot be revoked." },
        { status: 409 },
      );
    }

    await prisma.courseEnrollmentInvitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() },
    });

    createPlatformAuditLog({
      actorId: session.user.id,
      action: "course.invitation_revoked",
      targetType: "CourseEnrollmentInvitation",
      targetId: invitationId,
      institutionId: course.institutionId,
      metadata: { courseId },
    }).catch(() => {});

    return NextResponse.json({ status: "revoked" });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
