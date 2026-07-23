/**
 * Cohort-Level Collusion Detection and Integrity Graph v1 — see
 * docs/cohort-collusion-graph-v1.md.
 *
 * PATCH /api/lecturer/collusion-clusters/[clusterId]/review — records a
 * lecturer's review decision on one possible coordinated-answer cluster.
 * The decision is a human judgment ("Reviewed — no concern" / "Concern
 * remains" / "Oral verification requested" / "Escalated" / "Resolved")
 * or simply a private note — never an automatic finding, and it never
 * changes any grade, submission, or answer. Every status change is
 * audited (old/new status only — never the free-text note).
 *
 * "Request oral verification" here only records the cluster's review
 * label — it does NOT itself create an OralVerification row. Creating
 * one is always a separate, explicit call to the pre-existing
 * POST /api/lecturer/submissions/[id]/oral-verification route for each
 * selected member (see docs/oral-verification-workflow-v1.md) — this
 * route never duplicates that creation logic.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { CLUSTER_REVIEW_STATUSES } from "@/lib/cohortCollusion/graph";

const reviewSchema = z.object({
  reviewStatus: z.enum(CLUSTER_REVIEW_STATUSES).optional(),
  reviewNote: z.string().max(2000).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ clusterId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { clusterId } = await params;
  const cluster = await prisma.collusionCluster.findUnique({
    where: { id: clusterId },
    include: { analysis: { select: { examId: true, exam: { select: { id: true, createdById: true, institutionId: true } } } } },
  });
  if (!cluster) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const exam = cluster.analysis.exam;
  if (!isPlatformAdmin(session) && exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return response;
    throw err;
  }

  const body = await req.json().catch(() => ({}));
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.reviewStatus == null && parsed.data.reviewNote == null) {
    return NextResponse.json({ error: "Provide reviewStatus and/or reviewNote" }, { status: 400 });
  }

  const updated = await prisma.collusionCluster.update({
    where: { id: clusterId },
    data: {
      ...(parsed.data.reviewStatus != null
        ? { reviewStatus: parsed.data.reviewStatus, reviewedAt: new Date(), reviewedById: session.user.id }
        : {}),
      ...(parsed.data.reviewNote != null ? { reviewNote: parsed.data.reviewNote } : {}),
    },
    select: { id: true, reviewStatus: true, reviewNote: true, reviewedAt: true },
  });

  if (parsed.data.reviewStatus != null) {
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "COLLUSION_CLUSTER_REVIEW_UPDATED",
      targetType: "CollusionCluster",
      targetId: clusterId,
      institutionId: exam.institutionId,
      metadata: {
        examId: exam.id,
        oldStatus: cluster.reviewStatus,
        newStatus: parsed.data.reviewStatus,
      },
    }).catch(() => {});
  }

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
