/**
 * Evidence Review Workflow v1 — see docs/evidence-review-workflow-v1.md.
 *
 * GET /api/lecturer/submissions/[id]/integrity-review — returns the
 * submission's attempt policy (or "unavailable" for legacy attempts),
 * every integrity event with its policy interpretation/review status/
 * reviewer/comments/status history, a submission-level review summary,
 * and an explainable recommendation. Lecturer (exam owner) or platform
 * admin, same institution. Never returns evidence storage keys, raw IPs,
 * device/session hashes, or correct answers.
 *
 * (Route segment is `[id]`, not `[submissionId]`, to match every other
 * sibling route under src/app/api/lecturer/submissions/[id]/... — Next.js
 * requires the same dynamic segment name across sibling routes.)
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { buildIntegrityReview } from "@/lib/integrityReviewRunner";

type SubmissionPermission = { response: NextResponse } | { session: Session };

async function requireSubmissionPermission(submissionId: string): Promise<SubmissionPermission> {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { exam: { select: { createdById: true, institutionId: true } } },
  });
  if (!submission) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!isPlatformAdmin(session) && submission.exam.createdById !== session.user.id) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  try {
    assertSameInstitution(session, submission.exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return { response };
    throw err;
  }
  return { session };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const permission = await requireSubmissionPermission(id);
  if ("response" in permission) return permission.response;

  const review = await buildIntegrityReview(id);
  return NextResponse.json(review);
}

export const dynamic = "force-dynamic";
