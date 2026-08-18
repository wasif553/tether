/**
 * Tether Course Invitation + Acceptance v1 — see
 * docs/tether-course-invitation-acceptance-v1.md.
 *
 * GET  /api/courses/[id]/invitations — list this course's invitations
 *   for the lecturer's "Pending invitations" UI. Never includes
 *   tokenHash.
 * POST /api/courses/[id]/invitations — create (or regenerate) the one
 *   logical invitation for a target STUDENT, identified by email, never
 *   by a client-supplied studentId/institutionId. Returns the plaintext
 *   invitation URL ONCE — never stored, never logged, never retrievable
 *   again after this response.
 *
 * Lecturer (or platform admin) who can manage this course only — see
 * getManageableCourse, the same authorization helper already used by
 * the sibling /enrolments routes.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import {
  generateCourseInvitationToken,
  hashCourseInvitationToken,
  buildCourseInvitationUrl,
  COURSE_INVITATION_EXPIRY_MS,
} from "@/lib/courseInvitationToken";

const createInvitationSchema = z.object({ email: z.string().email() });

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

function invitationStatus(inv: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date) {
  if (inv.acceptedAt) return "ACCEPTED" as const;
  if (inv.revokedAt) return "REVOKED" as const;
  if (inv.expiresAt < now) return "EXPIRED" as const;
  return "PENDING" as const;
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
    const { id: courseId } = await params;
    const course = await getManageableCourse(courseId, session);
    if (course === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (course === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const invitations = await prisma.courseEnrollmentInvitation.findMany({
      where: { courseId },
      include: { student: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    });

    const now = new Date();
    // Never includes tokenHash — nothing here should ever let a lecturer
    // (or anyone reading this response) reconstruct or verify a token.
    const sanitized = invitations.map((inv) => ({
      id: inv.id,
      student: inv.student,
      status: invitationStatus(inv, now),
      expiresAt: inv.expiresAt,
      acceptedAt: inv.acceptedAt,
      revokedAt: inv.revokedAt,
      createdAt: inv.createdAt,
    }));

    return NextResponse.json(sanitized);
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
    const parsed = createInvitationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    // Bound to an exact existing STUDENT User.id — never trust a
    // client-supplied studentId/institutionId, and never create an
    // account for an email with no existing User.
    const targetUser = await prisma.user.findUnique({
      where: { email: parsed.data.email.trim().toLowerCase() },
    });
    if (!targetUser) {
      return NextResponse.json(
        {
          error: "No Tether student account was found for this email. Ask the student to create their Tether account first.",
          code: "STUDENT_NOT_FOUND",
        },
        { status: 404 },
      );
    }
    if (targetUser.role !== "STUDENT") {
      return NextResponse.json(
        { error: "This account is not a Tether student account.", code: "NOT_A_STUDENT" },
        { status: 400 },
      );
    }
    // Fail closed if the student became affiliated with ANY institution
    // concurrently, rather than producing an invitation that could never
    // be validly accepted.
    if (targetUser.institutionId === course.institutionId) {
      return NextResponse.json(
        { error: "This student already belongs to your institution — enrol them directly instead.", code: "ALREADY_SAME_INSTITUTION" },
        { status: 409 },
      );
    }
    if (targetUser.institutionId != null) {
      return NextResponse.json(
        { error: "This student is already linked to another Tether institution.", code: "DIFFERENT_INSTITUTION" },
        { status: 409 },
      );
    }

    const existing = await prisma.courseEnrollmentInvitation.findUnique({
      where: { courseId_studentId: { courseId, studentId: targetUser.id } },
    });
    if (existing?.acceptedAt) {
      // Already enrolled via this invitation — regenerating a spent,
      // accepted invitation makes no sense and must never be allowed to
      // silently reset acceptance state.
      return NextResponse.json(
        { error: "This student has already accepted an invitation to this course.", code: "ALREADY_ACCEPTED" },
        { status: 409 },
      );
    }

    const token = generateCourseInvitationToken();
    const tokenHash = hashCourseInvitationToken(token);
    const expiresAt = new Date(Date.now() + COURSE_INVITATION_EXPIRY_MS);

    const invitation = await prisma.courseEnrollmentInvitation.upsert({
      where: { courseId_studentId: { courseId, studentId: targetUser.id } },
      update: { tokenHash, expiresAt, revokedAt: null, invitedById: session.user.id },
      create: { courseId, studentId: targetUser.id, invitedById: session.user.id, tokenHash, expiresAt },
    });

    createPlatformAuditLog({
      actorId: session.user.id,
      action: existing ? "course.invitation_regenerated" : "course.invitation_created",
      targetType: "CourseEnrollmentInvitation",
      targetId: invitation.id,
      institutionId: course.institutionId,
      metadata: { courseId },
    }).catch(() => {});

    return NextResponse.json(
      {
        invitationUrl: buildCourseInvitationUrl(invitation.id, token),
        invitationId: invitation.id,
        expiresAt: invitation.expiresAt,
        student: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
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
