/**
 * VOIDED-attempt recovery v1 — see docs/voided-submission-recovery-v1.md.
 *
 * POST /api/lecturer/submissions/[id]/void — "Void technical attempt and
 * allow restart". Deliberately NOT a generic "void any in-progress
 * attempt" capability: this endpoint only accepts the one proven
 * technical/security recovery condition this feature exists to close —
 * an IN_PROGRESS submission whose FROZEN secure-client policy can no
 * longer satisfy the exam's CURRENT TETHER_CLIENT_REQUIRED configuration
 * (see isSecurePolicyMismatchForResume in secureClientPolicy.ts, the same
 * check GET.../start uses to detect and reject an impossible resume).
 * Any other in-progress submission — including one a lecturer simply
 * wishes a student could retake for ordinary academic reasons — is
 * rejected by this route; that is a different, out-of-scope, future
 * capability.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { parseSecureSettings } from "@/lib/secureExam";
import { parseSecureClientPolicy, isSecurePolicyMismatchForResume } from "@/lib/secureClientPolicy";

const voidRequestSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required to void this attempt."),
  // Explicit confirmation from the UI (Requirement 4) — not just a button
  // click; the request itself must carry this so no other client flow
  // can trigger a void as a side effect of some other action.
  confirm: z.literal(true),
});

/** Thrown inside the transaction when another request already changed the submission's status (won the race) — see report Section 5. Never a real failure; routes to the same SUBMISSION_NOT_VOIDABLE response. */
class SubmissionAlreadyFinalizedError extends Error {}
/** Thrown inside the transaction when the re-checked-under-lock eligibility condition no longer holds (e.g. the exam's secureSettings changed concurrently). */
class SubmissionNotVoidableError extends Error {}

// A fresh Response object every call — a Response body can only ever be
// read once, so a module-level singleton would break the second caller
// to read it (confirmed by a real test failure: "Body is unusable: Body
// has already been read" on a second rejected request in the same
// process — exactly the kind of thing that would also break a second
// real HTTP request in a long-lived Node process, not just a test).
function notVoidableResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "This submission does not meet the technical secure-policy mismatch condition this action is scoped to.",
      code: "SUBMISSION_NOT_VOIDABLE",
    },
    { status: 409 },
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    select: {
      id: true,
      examId: true,
      studentId: true,
      status: true,
      secureClientPolicySnapshotJson: true,
      exam: { select: { id: true, institutionId: true, createdById: true, secureSettings: true } },
    },
  });
  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Existence-hiding pattern, same as approve-ai-grade/route.ts: a
  // non-owning lecturer gets 404, never 403 — never confirms the
  // submission exists to someone who shouldn't be able to see it.
  if (!isPlatformAdmin(session) && submission.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, submission.exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = await req.json().catch(() => null);
  const parsed = voidRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Outer, pre-transaction eligibility check — fails fast with a clear
  // response before ever acquiring the lock, for the overwhelmingly
  // common case (an ordinary healthy submission, or one already
  // finalized). The transaction below re-checks the SAME condition again
  // under the lock — this outer check is a fast rejection, not the
  // authoritative one.
  if (submission.status !== "IN_PROGRESS") {
    return notVoidableResponse();
  }
  const currentSettings = parseSecureSettings(submission.exam.secureSettings);
  const frozenPolicy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  if (!isSecurePolicyMismatchForResume({ currentExamDeliveryMode: currentSettings.deliveryMode, frozenPolicy })) {
    return notVoidableResponse();
  }

  try {
    // Concurrency safety (report Section 5) — reuses the EXACT SAME
    // advisory-lock key space (pg_advisory_xact_lock(hashtext(submissionId)))
    // that POST /api/submissions/[id]/submit already takes for this same
    // row. Postgres advisory locks are lock-key-scoped, not route-scoped:
    // whichever of {this void request, a concurrent submit request}
    // acquires the lock first runs its entire read-check-write cycle to
    // completion (commit or rollback) before the other can even begin its
    // own post-lock status re-check. Combined with the conditional
    // `where: { id, status: "IN_PROGRESS" }` on the actual UPDATE below
    // (mirroring submit/route.ts's own belt-and-suspenders style), there
    // is no interleaving that can leave the row in, or transition it
    // through, an inconsistent VOIDED+SUBMITTED state — see
    // submissionVoidConcurrency.routes.test.ts.
    const voided = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;

      const fresh = await tx.submission.findUnique({
        where: { id },
        select: { status: true, secureClientPolicySnapshotJson: true },
      });
      if (!fresh || fresh.status !== "IN_PROGRESS") {
        throw new SubmissionAlreadyFinalizedError();
      }

      // Re-verify eligibility INSIDE the lock too, against a freshly-read
      // exam row — belt-and-suspenders against a concurrent lecturer
      // settings edit landing between the outer check above and lock
      // acquisition here.
      const freshExam = await tx.exam.findUnique({ where: { id: submission.examId }, select: { secureSettings: true } });
      const freshSettings = parseSecureSettings(freshExam?.secureSettings ?? null);
      const freshFrozenPolicy = parseSecureClientPolicy(fresh.secureClientPolicySnapshotJson);
      if (!isSecurePolicyMismatchForResume({ currentExamDeliveryMode: freshSettings.deliveryMode, frozenPolicy: freshFrozenPolicy })) {
        throw new SubmissionNotVoidableError();
      }

      // Only Submission.status changes. secureClientPolicySnapshotJson,
      // answers, integrity events, network evidence — everything else —
      // is left byte-for-byte untouched, exactly as required.
      const updated = await tx.submission.update({
        where: { id, status: "IN_PROGRESS" },
        data: { status: "VOIDED" },
      });

      // Atomic with the status transition — see createPlatformAuditLog's
      // own doc comment. Passing `tx` here (rather than the default
      // global client) is what guarantees this write commits or rolls
      // back together with the status update above; there is no
      // possible committed state where one happened without the other.
      await createPlatformAuditLog(
        {
          actorId: session.user.id,
          action: "SUBMISSION_VOIDED",
          targetType: "Submission",
          targetId: id,
          institutionId: submission.exam.institutionId,
          metadata: {
            submissionId: id,
            examId: submission.examId,
            studentId: submission.studentId,
            previousStatus: "IN_PROGRESS",
            reason: parsed.data.reason,
            technicalRecoveryReason: "SECURE_POLICY_MISMATCH_RESTART_REQUIRED",
          },
        },
        tx,
      );

      return updated;
    });

    return NextResponse.json({ id: voided.id, status: voided.status });
  } catch (err) {
    if (err instanceof SubmissionAlreadyFinalizedError || err instanceof SubmissionNotVoidableError) {
      return notVoidableResponse();
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
