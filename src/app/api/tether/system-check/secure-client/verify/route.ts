/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md.
 *
 * POST /api/tether/system-check/secure-client/verify — the student's
 * Tether Secure Browser echoes back the signed SYSTEM_CHECK challenge,
 * together with `installationSignature`: a signature produced by that
 * installation's OWN registered private key (never a globally shared
 * one — see "Genuine client attestation" history / "Secure Client
 * Attestation v2"), computed entirely inside the Electron main process.
 * The server independently re-verifies BOTH the server's own challenge
 * signature AND the installation's signature against ITS registered
 * public key, and confirms the installation is currently ACTIVE (not
 * revoked/replaced). It never trusts a renderer-supplied "verified"
 * boolean — there is no such field in this request body at all. A
 * second verify attempt with the same nonce is rejected as a replay.
 * Never logs the full challenge or any signature.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { requireInstitutionId } from "@/lib/institutionScope";
import { verifySystemCheckAttestation, isValidSystemCheckClientType, SYSTEM_CHECK_CLIENT_TYPES } from "@/lib/systemCheck/tetherAttestationRunner";

const challengeSchema = z.object({
  schemaVersion: z.number().int(),
  challengeId: z.string().min(1).max(200),
  keyId: z.string().min(1).max(200),
  issuer: z.string().min(1).max(200),
  purpose: z.literal("SYSTEM_CHECK"),
  audience: z.string().min(1).max(200),
  userSubjectHash: z.string().min(1).max(200),
  installationId: z.string().min(1).max(100),
  installationPublicKeyFingerprint: z.string().min(1).max(200),
  issuedAt: z.string().min(1).max(64),
  notBefore: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
  nonce: z.string().min(1).max(512),
  examId: z.null(),
  submissionId: z.null(),
  policyHash: z.null(),
  secureClientSessionId: z.null(),
  institutionId: z.null(),
  allowedClientType: z.null(),
  displayPolicy: z.null(),
  requiredMinimumClientVersion: z.null(),
});

const bodySchema = z.object({
  challenge: challengeSchema,
  challengeSignature: z.string().min(1).max(2048),
  clientType: z.enum(SYSTEM_CHECK_CLIENT_TYPES),
  installationSignature: z.string().min(1).max(2048),
  clientVersion: z.string().min(1).max(40),
  platform: z.string().min(1).max(40),
  displayTopologyClassification: z.string().min(1).max(40),
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
  if (!isValidSystemCheckClientType(body.clientType)) {
    return NextResponse.json({ error: "Unsupported client type" }, { status: 400 });
  }

  let institutionId: string;
  try {
    institutionId = requireInstitutionId(session);
  } catch {
    return NextResponse.json({ error: "Institution not resolved for this account" }, { status: 403 });
  }

  const result = await verifySystemCheckAttestation({
    userId: session.user.id,
    institutionId,
    challenge: body.challenge,
    challengeSignature: body.challengeSignature,
    clientType: body.clientType,
    installationSignature: body.installationSignature,
    clientVersion: body.clientVersion,
    platform: body.platform,
    displayTopologyClassification: body.displayTopologyClassification,
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
  if (result.outcome === "REPLAY") {
    return NextResponse.json({ verified: false, reason: "REPLAY" }, { status: 409 });
  }

  return NextResponse.json({ verified: true, verificationId: result.verificationId, expiresAt: result.expiresAt });
}

export const dynamic = "force-dynamic";
