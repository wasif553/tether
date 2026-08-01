/**
 * Secure Client Attestation v2 — EXAM_SESSION purpose. See
 * docs/tether-system-check-v1.md, "Wiring installation attestation into
 * real exam sessions". The legacy exam-launch/attestation flow
 * (secureClientRunner.ts, POST /api/secure-client/sessions/[id]/attestation)
 * is completely unchanged and, under the safe default
 * TETHER_EXAM_ATTESTATION_MODE=LEGACY, remains the sole determinant of a
 * session's actual READY/CANNOT_START outcome — see
 * src/lib/tetherAttestationConfig.ts. This issues a purpose=EXAM_SESSION,
 * installation-bound challenge binding every field
 * verifyExamSessionAttestation's 20-point checklist requires
 * (examId/submissionId/policyHash/secureClientSessionId/institutionId/
 * allowedClientType/displayPolicy/requiredMinimumClientVersion) — every
 * one of them SERVER-computed from the real, existing SecureClientSession
 * and its immutable policy snapshot, never accepted as a caller-supplied
 * claim.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import { computePolicyHash } from "@/lib/secureClient/secureLaunchManifest";
import { getCurrentSessionForSubmission } from "@/lib/secureClientRunner";
import { issueAttestationChallenge } from "@/lib/systemCheck/tetherAttestationRunner";
import { minimumSupportedTetherVersion } from "@/lib/systemCheckConfig";

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

  // A v2 EXAM_SESSION challenge can only ever be issued for a
  // SecureClientSession that already genuinely exists — this route never
  // creates one (that stays the legacy launch/consume flow's job, see
  // consumeLaunchManifest in secureClientRunner.ts).
  const secureClientSession = await getCurrentSessionForSubmission(submission.id);
  if (!secureClientSession) {
    return NextResponse.json({ error: "No active secure-client session for this submission." }, { status: 409 });
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
    secureClientSessionId: secureClientSession.id,
    institutionId: secureClientSession.institutionId,
    allowedClientType: secureClientSession.clientType,
    displayPolicy: policy.displayPolicy,
    requiredMinimumClientVersion: minimumSupportedTetherVersion(),
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
