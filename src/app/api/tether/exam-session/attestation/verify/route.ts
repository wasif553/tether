/**
 * Secure Client Attestation v2 — EXAM_SESSION purpose. See
 * docs/tether-system-check-v1.md, "Real exam attestation — additive
 * groundwork".
 *
 * POST /api/tether/exam-session/attestation/verify — verifies BOTH the
 * server's own challenge signature and the installation's own signature
 * over the canonical EXAM_SESSION payload (binding
 * examId/submissionId/policyHash — a signature genuinely produced for a
 * different exam, submission, or policy fails to verify here). Only
 * ADDITIVELY records the result — populates the existing
 * SecureClientSession.clientInstallationIdHash field — and never
 * changes that session's status/verificationStatus, which remain
 * governed entirely by the existing, unmodified recordAttestation()
 * flow. See tetherAttestationRunner.ts's verifyExamSessionAttestation
 * doc comment for exactly why this is deliberately scoped this way in
 * this pass.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { verifyExamSessionAttestation } from "@/lib/systemCheck/tetherAttestationRunner";

const challengeSchema = z.object({
  schemaVersion: z.number().int(),
  challengeId: z.string().min(1).max(200),
  keyId: z.string().min(1).max(200),
  issuer: z.string().min(1).max(200),
  purpose: z.literal("EXAM_SESSION"),
  audience: z.string().min(1).max(200),
  userSubjectHash: z.string().min(1).max(200),
  installationId: z.string().min(1).max(100),
  installationPublicKeyFingerprint: z.string().min(1).max(200),
  issuedAt: z.string().min(1).max(64),
  notBefore: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
  nonce: z.string().min(1).max(512),
  examId: z.string().min(1).max(100),
  submissionId: z.string().min(1).max(100),
  policyHash: z.string().min(1).max(200),
  secureClientSessionId: z.string().min(1).max(100),
  institutionId: z.string().min(1).max(100),
  allowedClientType: z.string().min(1).max(60),
  displayPolicy: z.string().min(1).max(60),
  requiredMinimumClientVersion: z.string().min(1).max(40),
});

const bodySchema = z.object({
  challenge: challengeSchema,
  challengeSignature: z.string().min(1).max(2048),
  installationSignature: z.string().min(1).max(2048),
  clientVersion: z.string().min(1).max(40),
  platform: z.string().min(1).max(40),
  displayTopologyClassification: z.string().min(1).max(40),
  displayCount: z.number().int().min(0).max(64),
  capabilities: z.string().min(1).max(200),
  timestamp: z.string().min(1).max(64),
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
  const body = parsed.data;

  const result = await verifyExamSessionAttestation({
    userId: session.user.id,
    challenge: body.challenge,
    challengeSignature: body.challengeSignature,
    installationSignature: body.installationSignature,
    clientVersion: body.clientVersion,
    platform: body.platform,
    displayTopologyClassification: body.displayTopologyClassification,
    displayCount: body.displayCount,
    capabilities: body.capabilities,
    timestamp: body.timestamp,
  });

  if (result.outcome === "INVALID") {
    return NextResponse.json({ verified: false, reason: result.reason }, { status: 400 });
  }
  if (result.outcome === "INSTALLATION_NOT_ACTIVE") {
    return NextResponse.json({ verified: false, reason: "INSTALLATION_NOT_ACTIVE" }, { status: 409 });
  }
  if (result.outcome === "INSTALLATION_KEY_PROTECTION_REJECTED") {
    return NextResponse.json({ verified: false, reason: "INSTALLATION_KEY_PROTECTION_REJECTED" }, { status: 409 });
  }
  if (result.outcome === "INSTALLATION_SIGNATURE_INVALID") {
    return NextResponse.json({ verified: false, reason: "INSTALLATION_SIGNATURE_INVALID" }, { status: 400 });
  }
  if (result.outcome === "SESSION_NOT_FOUND") {
    return NextResponse.json({ verified: false, reason: "SESSION_NOT_FOUND" }, { status: 404 });
  }
  if (result.outcome === "BINDING_MISMATCH") {
    return NextResponse.json({ verified: false, reason: "BINDING_MISMATCH" }, { status: 400 });
  }
  if (result.outcome === "CLIENT_VERSION_UNSUPPORTED") {
    return NextResponse.json({ verified: false, reason: "CLIENT_VERSION_UNSUPPORTED" }, { status: 400 });
  }
  if (result.outcome === "PLATFORM_UNSUPPORTED") {
    return NextResponse.json({ verified: false, reason: "PLATFORM_UNSUPPORTED" }, { status: 400 });
  }
  if (result.outcome === "DISPLAY_POLICY_VIOLATION") {
    return NextResponse.json({ verified: false, reason: "DISPLAY_POLICY_VIOLATION" }, { status: 400 });
  }
  if (result.outcome === "POLICY_HASH_MISMATCH") {
    return NextResponse.json({ verified: false, reason: "POLICY_HASH_MISMATCH" }, { status: 400 });
  }
  if (result.outcome === "REPLAY") {
    return NextResponse.json({ verified: false, reason: "REPLAY" }, { status: 409 });
  }

  return NextResponse.json({ verified: true, sessionId: result.sessionId });
}

export const dynamic = "force-dynamic";
