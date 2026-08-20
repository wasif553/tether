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
 * Security review v3 — storage-cardinality fix: `id` (the exam id) is
 * attacker-controlled URL input. Every existing eligibility check
 * (exam missing, unpublished, wrong assignment mode, invite disabled,
 * missing tokenHash) is now resolved BEFORE any rate-limit reservation
 * is attempted, so arbitrary/nonexistent exam ids can never each create
 * a SecurityRateLimitBucket row. A reservation is taken ONLY once the
 * request is genuinely about to verify a real, eligible standalone
 * invite's token.
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
  // Security review v2 — keyed on source + THIS authenticated student
  // (never client-supplied) + exam, so one student's guessing can never
  // affect another student's ability to accept a different invite for
  // the same exam from the same shared network.
  const studentId = session.user.id;

  const body = await req.json().catch(() => null);
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) {
    return invalidInvite();
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
    // No real, eligible standalone invite exists for this id — never
    // reserve a slot for an arbitrary/nonexistent/ineligible exam id.
    return invalidInvite();
  }

  // Genuinely about to verify a real, eligible standalone invite's
  // token — only now is a contextual slot reserved.
  const reservation = await reserveStandaloneInviteSlot(sourceIp, studentId, id);
  if (reservation.status === "blocked") {
    return NextResponse.json(
      { ok: false, reason: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(reservation.retryAfterSeconds) } },
    );
  }
  if (reservation.status === "infrastructure_error") {
    // Fail closed without ever verifying the invite token, so a limiter
    // outage can never become a token-validity oracle.
    return NextResponse.json({ ok: false, reason: "unavailable" }, { status: 503 });
  }

  if (!verifyStandaloneInviteToken(parsed.data.token, exam.standaloneInviteTokenHash)) {
    return invalidInvite();
  }

  await releaseStandaloneInviteSlot(sourceIp, studentId, id, reservation.windowStartMs);

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
