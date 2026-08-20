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
import { reserveCourseInvitationSlot, releaseCourseInvitationSlot } from "@/lib/security/courseInvitationRateLimit";

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
  const reservation = await reserveCourseInvitationSlot(sourceIp, invitationId);
  if (reservation.status === "blocked") {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } },
    );
  }
  if (reservation.status === "infrastructure_error") {
    // Security review v2 — fail closed without ever looking up the
    // invitation or verifying its token, so a limiter outage can never
    // become an existence oracle.
    return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });
  }

  const invitation = await prisma.courseEnrollmentInvitation.findUnique({
    where: { id: invitationId },
    include: { course: { include: { institution: { select: { name: true } } } } },
  });

  if (!invitation) {
    // Genuinely invalid — reservation stays consumed.
    return NextResponse.json({ ok: false, reason: "invalid" });
  }
  if (invitation.studentId !== session.user.id) {
    await releaseCourseInvitationSlot(sourceIp, invitationId);
    return NextResponse.json({ ok: false, reason: "wrong_account" });
  }
  if (invitation.acceptedAt) {
    await releaseCourseInvitationSlot(sourceIp, invitationId);
    return NextResponse.json({ ok: false, reason: "already_accepted" });
  }
  if (invitation.revokedAt) {
    await releaseCourseInvitationSlot(sourceIp, invitationId);
    return NextResponse.json({ ok: false, reason: "revoked" });
  }
  if (invitation.expiresAt < new Date()) {
    await releaseCourseInvitationSlot(sourceIp, invitationId);
    return NextResponse.json({ ok: false, reason: "expired" });
  }
  if (!invitation.tokenHash || !verifyCourseInvitationToken(token, invitation.tokenHash)) {
    // Genuinely invalid token — reservation stays consumed.
    return NextResponse.json({ ok: false, reason: "invalid" });
  }

  await releaseCourseInvitationSlot(sourceIp, invitationId);

  // Only the minimum useful invitation information — no institution id,
  // no internal fields.
  return NextResponse.json({
    ok: true,
    institutionName: invitation.course.institution.name,
    course: { code: invitation.course.code, name: invitation.course.name },
  });
}

export const dynamic = "force-dynamic";
