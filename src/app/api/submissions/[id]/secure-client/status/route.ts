/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * GET /api/submissions/[id]/secure-client/status
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureClientPolicy, describeDisplayRequirement } from "@/lib/secureClientPolicy";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const submission = await prisma.submission.findUnique({ where: { id }, select: { studentId: true, secureClientPolicySnapshotJson: true } });
  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  const current = await prisma.secureClientSession.findFirst({
    where: { submissionId: id, status: { in: ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    deliveryMode: policy.deliveryMode,
    studentPreflightRequired: policy.studentPreflightRequired,
    displayRequirement: describeDisplayRequirement(policy),
    session: current
      ? {
          id: current.id,
          status: current.status,
          verificationStatus: current.verificationStatus,
          clientType: current.clientType,
          lastHeartbeatAt: current.lastHeartbeatAt,
        }
      : null,
  });
}

export const dynamic = "force-dynamic";
