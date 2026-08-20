/**
 * Tether Course Invitation + Acceptance v1 — see
 * docs/tether-course-invitation-acceptance-v1.md.
 *
 * GET /api/course-invitations/[invitationId]/[token] — read-only
 * preview shown before acceptance. Never mutates state. Authenticated
 * STUDENT only; the invitation is bound to a specific studentId, so a
 * different logged-in student gets a distinct "wrong_account" denial
 * rather than the generic one (per the feature's own spec — this is
 * deliberately more specific than Standalone Exam Link v1's blanket
 * denial, since here the invitation is bound to an account, not merely
 * to an exam).
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { verifyCourseInvitationToken } from "@/lib/courseInvitationToken";
import { resolveTrustedRequestSource } from "@/lib/security/clientSource";
import { courseInvitationRateLimitGate, recordCourseInvitationInvalidGuess } from "@/lib/security/courseInvitationRateLimit";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ invitationId: string; token: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const { invitationId, token } = await params;
  const sourceIp = resolveTrustedRequestSource(req);
  const gate = await courseInvitationRateLimitGate(sourceIp, invitationId);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    );
  }

  const invitation = await prisma.courseEnrollmentInvitation.findUnique({
    where: { id: invitationId },
    include: { course: { include: { institution: { select: { name: true } } } } },
  });

  if (!invitation) {
    await recordCourseInvitationInvalidGuess(sourceIp, invitationId);
    return NextResponse.json({ ok: false, reason: "invalid" });
  }
  if (invitation.studentId !== session.user.id) {
    return NextResponse.json({ ok: false, reason: "wrong_account" });
  }
  if (invitation.acceptedAt) {
    return NextResponse.json({ ok: false, reason: "already_accepted" });
  }
  if (invitation.revokedAt) {
    return NextResponse.json({ ok: false, reason: "revoked" });
  }
  if (invitation.expiresAt < new Date()) {
    return NextResponse.json({ ok: false, reason: "expired" });
  }
  if (!invitation.tokenHash || !verifyCourseInvitationToken(token, invitation.tokenHash)) {
    await recordCourseInvitationInvalidGuess(sourceIp, invitationId);
    return NextResponse.json({ ok: false, reason: "invalid" });
  }

  // Only the minimum useful invitation information — no institution id,
  // no internal fields.
  return NextResponse.json({
    ok: true,
    institutionName: invitation.course.institution.name,
    course: { code: invitation.course.code, name: invitation.course.name },
  });
}

export const dynamic = "force-dynamic";
