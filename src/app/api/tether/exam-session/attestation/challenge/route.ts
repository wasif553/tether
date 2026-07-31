/**
 * Secure Client Attestation v2 — EXAM_SESSION purpose. See
 * docs/tether-system-check-v1.md, "Real exam attestation — additive
 * groundwork". ADDITIVE only — the legacy exam-launch/attestation flow
 * (secureClientRunner.ts, POST /api/secure-client/sessions/[id]/attestation)
 * is completely unchanged and remains the sole determinant of a
 * session's actual READY/CANNOT_START outcome. This issues a
 * purpose=EXAM_SESSION, installation-bound challenge additionally
 * binding examId/submissionId/a policy hash, so a resulting signature
 * can never be replayed against a different exam or relabelled as
 * SYSTEM_CHECK.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import { computePolicyHash } from "@/lib/secureClient/secureLaunchManifest";
import { issueAttestationChallenge } from "@/lib/systemCheck/tetherAttestationRunner";

const bodySchema = z.object({
  installationId: z.string().min(1).max(100),
  submissionId: z.string().min(1).max(100),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }

  const submission = await prisma.submission.findUnique({ where: { id: parsed.data.submissionId } });
  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Submission not found." }, { status: 404 });
  }
  if (submission.status !== "IN_PROGRESS") {
    return NextResponse.json({ error: "This submission is no longer active." }, { status: 409 });
  }

  const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  const policyHash = computePolicyHash(policy);

  const result = await issueAttestationChallenge({
    userId: session.user.id,
    purpose: "EXAM_SESSION",
    installationId: parsed.data.installationId,
    examId: submission.examId,
    submissionId: submission.id,
    policyHash,
  });
  if (result.outcome === "INSTALLATION_NOT_FOUND") {
    return NextResponse.json({ error: "Installation not found." }, { status: 404 });
  }
  if (result.outcome === "INSTALLATION_NOT_ACTIVE") {
    return NextResponse.json({ error: "This installation is no longer active." }, { status: 409 });
  }

  return NextResponse.json({ challenge: result.challenge, signature: result.signature });
}

export const dynamic = "force-dynamic";
