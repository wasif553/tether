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
 *
 * Security review v3 — storage-cardinality fix: the rate-limit
 * reservation now happens ONLY immediately before actual tokenHash
 * verification, not up front. `invitationId` comes straight from the
 * URL, so reserving before the invitation lookup would let anyone create
 * a SecurityRateLimitBucket row per arbitrary/nonexistent id they type,
 * with no bound tied to a real resource. Every other existing, non-
 * secret-guessing outcome (invitation absent, wrong_account,
 * already_accepted, revoked, expired) is resolved BEFORE any reservation
 * is attempted and never creates one.
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

  const invitation = await prisma.courseEnrollmentInvitation.findUnique({
    where: { id: invitationId },
    include: { course: { include: { institution: { select: { name: true } } } } },
  });

  if (!invitation) {
    // Unknown invitation id — no rate-limit reservation is ever attempted
    // for an id that doesn't correspond to a real row.
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

  // Only now — genuinely about to verify a real invitation's token — is a
  // contextual slot reserved.
  const reservation = await reserveCourseInvitationSlot(sourceIp, invitationId);
  if (reservation.status === "blocked") {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } },
    );
  }
  if (reservation.status === "infrastructure_error") {
    // Fail closed without ever verifying the token, so a limiter outage
    // can never become an existence/validity oracle.
    return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });
  }

  if (!invitation.tokenHash || !verifyCourseInvitationToken(token, invitation.tokenHash)) {
    // Genuinely invalid token — reservation stays consumed.
    return NextResponse.json({ ok: false, reason: "invalid" });
  }

  await releaseCourseInvitationSlot(sourceIp, invitationId, reservation.windowStartMs);

  // Only the minimum useful invitation information — no institution id,
  // no internal fields.
  return NextResponse.json({
    ok: true,
    institutionName: invitation.course.institution.name,
    course: { code: invitation.course.code, name: invitation.course.name },
  });
}

export const dynamic = "force-dynamic";
