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

    const targetUser = parsed.data.userId
      ? await prisma.user.findUnique({ where: { id: parsed.data.userId } })
      : parsed.data.email
        ? await prisma.user.findUnique({ where: { email: parsed.data.email.trim().toLowerCase() } })
        : null;

    if (parsed.data.role === "LECTURER") {
      // Adding a co-lecturer to the course's teaching team — unchanged,
      // out of scope for Tether Course Invitation + Acceptance v1 (see
      // docs/tether-course-invitation-acceptance-v1.md), which only
      // concerns bringing self-service STUDENT accounts into a
      // course/institution. Lecturer accounts are always
      // institution-bound at creation (self-signup atomically creates
      // their own institution; platform-admin invites set it directly),
      // so there is no "null-institution lecturer" case to handle here.
      if (!targetUser || targetUser.institutionId !== course.institutionId) {
        return NextResponse.json(
          { error: "User does not belong to this institution" },
          { status: 400 },
        );
      }
      const enrollment = await prisma.courseEnrollment.upsert({
        where: { courseId_userId: { courseId, userId: targetUser.id } },
        update: { role: "LECTURER" },
        create: { courseId, userId: targetUser.id, role: "LECTURER" },
      });
      return NextResponse.json({ status: "enrolled", enrollment }, { status: 201 });
    }

    // Tether Course Invitation + Acceptance v1 — role === "STUDENT".
    // Replaces the previous single collapsed "does not belong to this
    // institution" response with the distinct cases the feature requires
    // (see docs/tether-course-invitation-acceptance-v1.md, "Existing
    // enrolment endpoint behavior").
    if (!targetUser) {
      // CASE A — no Tether account exists for this email at all. Never
      // create one from this endpoint, and never create an invitation
      // for an email with no existing User.
      return NextResponse.json(
        {
          error: "No Tether student account was found for this email. Ask the student to create their Tether account first.",
          code: "STUDENT_NOT_FOUND",
        },
        { status: 404 },
      );
    }
    if (targetUser.role !== "STUDENT") {
      // CASE B — never enrol a lecturer/admin account as a STUDENT
      // through this workflow.
      return NextResponse.json(
        { error: "This account is not a Tether student account.", code: "NOT_A_STUDENT" },
        { status: 400 },
      );
    }
    if (targetUser.institutionId === course.institutionId) {
      // CASE C — same institution: unchanged existing enrolment
      // behavior, immediate CourseEnrollment upsert.
      const enrollment = await prisma.courseEnrollment.upsert({
        where: { courseId_userId: { courseId, userId: targetUser.id } },
        update: { role: "STUDENT" },
        create: { courseId, userId: targetUser.id, role: "STUDENT" },
      });
      return NextResponse.json({ status: "enrolled", enrollment }, { status: 201 });
    }
    if (targetUser.institutionId == null) {
      // CASE D — a self-service student with no institution yet. Never
      // write User.institutionId or create a CourseEnrollment here —
      // the lecturer UI must offer "Invite to course" instead (see
      // POST /api/courses/[id]/invitations).
      return NextResponse.json({
        status: "invitation_required",
        code: "INVITATION_REQUIRED",
        student: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
      });
    }
    // CASE E — already linked to a DIFFERENT, non-null institution.
    // Reject without revealing which institution, and never move them.
    return NextResponse.json(
      { error: "This student is already linked to another Tether institution.", code: "DIFFERENT_INSTITUTION" },
      { status: 409 },
    );
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
