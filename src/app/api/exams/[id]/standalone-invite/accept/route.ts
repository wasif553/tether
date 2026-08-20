/**
 * Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md.
 *
 * POST /api/exams/[id]/standalone-invite/accept
 *
 * The ONLY route that ever creates an ExamAssignment from an
 * invitation token — a deliberate, POST-only, mutating action, never
 * triggered by a GET (access-check stays read-only, see that route's
 * own doc comment). Authenticated STUDENT only. Never sets
 * User.institutionId, never creates a CourseEnrollment, never grants
 * anything beyond an ExamAssignment for this one exam.
 *
 * Every failure path (exam missing, not STANDALONE, invite disabled,
 * wrong token, exam unpublished) returns the exact same generic denial
 * — never reveals which specific check failed, matching the existing
 * access-check route's information-hiding convention.
 *
 * Security review v3 — storage-cardinality fix: attempted to resolve
 * every eligibility check BEFORE reserving, so arbitrary/nonexistent exam
 * ids could never each create a SecurityRateLimitBucket row.
 *
 * Security review v4 — that ordering introduced an information oracle:
 * a nonexistent/ineligible exam id never rate-limited at all (the exam
 * lookup always short-circuited to the same invalid_invite, forever),
 * while a real eligible exam's wrong-token guesses eventually surfaced
 * 429 — letting a caller learn "this id is a real standalone exam"
 * purely from whether rate limiting ever activates. Fixed by keying the
 * limiter on source+authenticatedStudentId ONLY (no examId — see
 * standaloneInviteRateLimit.ts) and reserving BEFORE the exam lookup:
 * every request from a given student+source, real exam or not, now draws
 * from the exact same budget and produces the identical invalid_invite
 * response up to the threshold, then the identical 429 after it. This
 * also closes the unbounded-DB-lookup gap the v3 ordering left for
 * arbitrary exam ids (they never touched the rate limiter at all).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { verifyStandaloneInviteToken } from "@/lib/standaloneInvite";
import { resolveTrustedRequestSource } from "@/lib/security/clientSource";
import { reserveStandaloneInviteSlot, releaseStandaloneInviteSlot } from "@/lib/security/standaloneInviteRateLimit";

const acceptSchema = z.object({
  token: z.string().min(1),
});

function invalidInvite() {
  return NextResponse.json({ ok: false, reason: "invalid_invite" });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const sourceIp = resolveTrustedRequestSource(req);
  // Security review v2/v4 — keyed on source + THIS authenticated student
  // (never client-supplied) ONLY, so one student's guessing can never
  // affect another student's ability to accept a valid invite from the
  // same shared network — see standaloneInviteRateLimit.ts for why exam
  // id is deliberately NOT part of the key.
  const studentId = session.user.id;

  const body = await req.json().catch(() => null);
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) {
    return invalidInvite();
  }

  // Reserved BEFORE the exam lookup — deliberately independent of
  // whether `id` turns out to be a real, eligible standalone exam (see
  // this file's module doc comment for the information-oracle this
  // ordering closes).
  const reservation = await reserveStandaloneInviteSlot(sourceIp, studentId);
  if (reservation.status === "blocked") {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } },
    );
  }
  if (reservation.status === "infrastructure_error") {
    // Fail closed without ever looking up the exam or verifying the
    // invite token, so a limiter outage can never become an oracle.
    return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });
  }

  const exam = await prisma.exam.findUnique({
    where: { id },
    select: {
      id: true,
      published: true,
      assignmentMode: true,
      standaloneInviteEnabled: true,
      standaloneInviteTokenHash: true,
    },
  });

  if (
    !exam ||
    !exam.published ||
    exam.assignmentMode !== "STANDALONE" ||
    !exam.standaloneInviteEnabled ||
    !exam.standaloneInviteTokenHash
  ) {
    // No real, eligible standalone invite exists for this id — the
    // reservation above stays consumed exactly as it would for a wrong
    // token against a real exam, so this outcome is indistinguishable
    // from that one by rate-limit behavior alone.
    return invalidInvite();
  }

  if (!verifyStandaloneInviteToken(parsed.data.token, exam.standaloneInviteTokenHash)) {
    return invalidInvite();
  }

  await releaseStandaloneInviteSlot(sourceIp, studentId, reservation.windowStartMs);

  // The userId is always the authenticated caller — never client-
  // supplied. Idempotent via the existing @@unique([examId, studentId])
  // constraint: a student who already accepted (or was separately
  // assigned some other way) simply keeps their one row.
  await prisma.examAssignment.upsert({
    where: { examId_studentId: { examId: id, studentId: session.user.id } },
    create: { examId: id, studentId: session.user.id },
    update: {},
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
