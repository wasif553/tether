/**
 * Tether Course Invitation + Acceptance v1 — see
 * docs/tether-course-invitation-acceptance-v1.md.
 *
 * POST /api/course-invitations/[invitationId]/[token]/accept — the ONLY
 * route that ever changes User.institutionId from null to a course's
 * institution, and the only route that creates the resulting
 * CourseEnrollment. Authenticated STUDENT only; studentId is always
 * derived from session.user.id, never from the request body.
 *
 * Everything — re-validating the invitation, claiming it, checking and
 * possibly setting institutionId, and creating the CourseEnrollment —
 * happens inside ONE database transaction. If the student became linked
 * to a DIFFERENT institution between invitation creation and this
 * acceptance, the entire transaction rolls back: no partial institution
 * assignment, no course enrolment, ever remains.
 *
 * Race safety: BOTH the invitation row and the User row are claimed via
 * a conditional UPDATE (updateMany with a WHERE clause re-checking the
 * exact prior state) rather than a plain read-then-write — Postgres
 * row-level locking means a concurrent regenerate/revoke/second-accept,
 * or a second acceptance of a DIFFERENT invitation (different
 * institution) for the same null-institution student, can never both
 * "win" a race through the gap between read and write. See the two
 * `updateMany` calls below for the exact mechanism.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { verifyCourseInvitationToken } from "@/lib/courseInvitationToken";

type AcceptOutcome =
  | { kind: "invalid" }
  | { kind: "wrong_account" }
  | { kind: "expired" }
  | { kind: "revoked" }
  | { kind: "already_ok" }
  | { kind: "different_institution" }
  | { kind: "accepted"; courseId: string; institutionId: string };

class CrossInstitutionConflictError extends Error {
  constructor() {
    super("Student became linked to a different institution during acceptance");
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ invitationId: string; token: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const { invitationId, token } = await params;
  const studentId = session.user.id;

  const outcome: AcceptOutcome = await prisma.$transaction(async (tx): Promise<AcceptOutcome> => {
    const invitation = await tx.courseEnrollmentInvitation.findUnique({
      where: { id: invitationId },
      include: { course: true },
    });
    if (!invitation) return { kind: "invalid" };
    if (invitation.studentId !== studentId) return { kind: "wrong_account" };

    // Idempotent short-circuit: this exact student already completed
    // acceptance (this call, an earlier retry, or a losing concurrent
    // request re-reading after the winner committed — see below). The
    // tokenHash is cleared on acceptance, so a stored token can never be
    // re-verified after this point — that is expected, not an error.
    if (invitation.acceptedAt) return { kind: "already_ok" };
    if (invitation.revokedAt) return { kind: "revoked" };
    if (invitation.expiresAt < new Date()) return { kind: "expired" };
    if (!invitation.tokenHash || !verifyCourseInvitationToken(token, invitation.tokenHash)) {
      return { kind: "invalid" };
    }

    // Atomic claim — only matches if the row is STILL exactly as read
    // above (unaccepted, unrevoked, same tokenHash) at the moment of the
    // write. Closes the read/write race window.
    const claim = await tx.courseEnrollmentInvitation.updateMany({
      where: {
        id: invitationId,
        acceptedAt: null,
        revokedAt: null,
        tokenHash: invitation.tokenHash,
      },
      data: { acceptedAt: new Date(), tokenHash: null },
    });

    if (claim.count !== 1) {
      // Lost the race (concurrent regenerate/revoke/accept) — re-read to
      // report accurately instead of a generic failure.
      const fresh = await tx.courseEnrollmentInvitation.findUnique({ where: { id: invitationId } });
      if (fresh?.acceptedAt) return { kind: "already_ok" };
      if (fresh?.revokedAt) return { kind: "revoked" };
      return { kind: "invalid" };
    }

    // Atomic User-row claim — mirrors the invitation claim above, and
    // for the same reason. A plain "read institutionId, then if null
    // write it" has a read/write race: two concurrent acceptances of
    // two DIFFERENT invitations (two different institutions) for this
    // same null-institution student could both read institutionId:
    // null before either writes, and an unconditional
    // `update({where: {id}})` would let the second silently overwrite
    // the first institution — exactly the "Institution A -> Institution
    // B" transition this feature must never allow. This conditional
    // `updateMany` only succeeds if institutionId is STILL null at the
    // moment of the write; Postgres row-level locking means the loser's
    // write is evaluated only after the winner's has already committed.
    const claimUser = await tx.user.updateMany({
      where: { id: studentId, institutionId: null },
      data: { institutionId: invitation.course.institutionId },
    });

    if (claimUser.count !== 1) {
      // Lost the User-row claim — re-read inside this same transaction
      // to tell an idempotent re-run (already exactly this institution)
      // apart from a genuine conflict (a DIFFERENT institution won).
      const student = await tx.user.findUnique({
        where: { id: studentId },
        select: { institutionId: true },
      });
      if (student?.institutionId !== invitation.course.institutionId) {
        // A different institution won the race — throwing here rolls
        // back the entire transaction, including the invitation claim
        // above, so the invitation is left exactly as it was (still
        // pending) rather than "accepted" with no resulting affiliation.
        throw new CrossInstitutionConflictError();
      }
      // else: already exactly this institution — idempotent no-op continuation.
    }

    await tx.courseEnrollment.upsert({
      where: { courseId_userId: { courseId: invitation.courseId, userId: studentId } },
      update: { role: "STUDENT" },
      create: { courseId: invitation.courseId, userId: studentId, role: "STUDENT" },
    });

    await tx.platformAuditLog.create({
      data: {
        actorId: studentId,
        action: "course.invitation_accepted",
        targetType: "CourseEnrollmentInvitation",
        targetId: invitation.id,
        institutionId: invitation.course.institutionId,
        metadata: { courseId: invitation.courseId },
      },
    });

    return { kind: "accepted", courseId: invitation.courseId, institutionId: invitation.course.institutionId };
  }).catch((err) => {
    if (err instanceof CrossInstitutionConflictError) {
      return { kind: "different_institution" as const };
    }
    throw err;
  });

  if (outcome.kind === "accepted" || outcome.kind === "already_ok") {
    return NextResponse.json({ ok: true });
  }
  if (outcome.kind === "different_institution") {
    // Never identify the other institution.
    return NextResponse.json({
      ok: false,
      reason: "different_institution",
      error: "This account is already linked to a different Tether institution.",
    });
  }
  return NextResponse.json({ ok: false, reason: outcome.kind });
}

export const dynamic = "force-dynamic";
