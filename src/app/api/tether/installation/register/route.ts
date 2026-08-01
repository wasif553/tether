/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md.
 *
 * POST /api/tether/installation/register — the student's Tether Secure
 * Browser generates a per-installation keypair and registers its PUBLIC
 * key here, proving possession of the matching private key by signing
 * the registration challenge's nonce. Never trusts a client-claimed
 * "TPM_ATTESTED" protection level — no attestation-evidence-verification
 * code exists yet to substantiate that claim, so it is rejected outright
 * (see isSelfReportableKeyProtectionLevel). Never logs the full
 * challenge, signature, or public key.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { requireInstitutionId } from "@/lib/institutionScope";
import {
  registerInstallation,
  isSelfReportableKeyProtectionLevel,
  isValidInstallationKeyAlgorithm,
  SELF_REPORTABLE_KEY_PROTECTION_LEVELS,
  INSTALLATION_KEY_ALGORITHMS,
} from "@/lib/systemCheck/tetherAttestationRunner";
import { REGISTRATION_PURPOSE } from "@/lib/secureClient/tetherAttestation";

const challengeSchema = z.object({
  schemaVersion: z.number().int(),
  challengeId: z.string().min(1).max(200),
  keyId: z.string().min(1).max(200),
  issuer: z.string().min(1).max(200),
  purpose: z.literal(REGISTRATION_PURPOSE),
  audience: z.string().min(1).max(200),
  userSubjectHash: z.string().min(1).max(200),
  issuedAt: z.string().min(1).max(64),
  notBefore: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
  nonce: z.string().min(1).max(512),
  publicKeyFingerprint: z.string().min(1).max(200),
});

const bodySchema = z.object({
  challenge: challengeSchema,
  challengeSignature: z.string().min(1).max(2048),
  publicKey: z.string().min(1).max(4096),
  keyAlgorithm: z.enum(INSTALLATION_KEY_ALGORITHMS),
  keyProtectionLevel: z.enum(SELF_REPORTABLE_KEY_PROTECTION_LEVELS),
  proofOfPossessionSignature: z.string().min(1).max(2048),
  clientVersion: z.string().max(40).nullable().optional(),
  platform: z.string().max(40).nullable().optional(),
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
  if (!isValidInstallationKeyAlgorithm(body.keyAlgorithm) || !isSelfReportableKeyProtectionLevel(body.keyProtectionLevel)) {
    return NextResponse.json({ error: "Unsupported key algorithm or protection level" }, { status: 400 });
  }

  let institutionId: string;
  try {
    institutionId = requireInstitutionId(session);
  } catch {
    return NextResponse.json({ error: "Institution not resolved for this account" }, { status: 403 });
  }

  const result = await registerInstallation({
    userId: session.user.id,
    institutionId,
    challenge: body.challenge,
    challengeSignature: body.challengeSignature,
    publicKey: body.publicKey,
    keyAlgorithm: body.keyAlgorithm,
    keyProtectionLevel: body.keyProtectionLevel,
    proofOfPossessionSignature: body.proofOfPossessionSignature,
    clientVersion: body.clientVersion ?? null,
    platform: body.platform ?? null,
  });

  if (result.outcome === "INVALID_CHALLENGE") {
    return NextResponse.json({ registered: false, reason: result.reason }, { status: 400 });
  }
  if (result.outcome === "PROOF_OF_POSSESSION_INVALID") {
    return NextResponse.json({ registered: false, reason: "PROOF_OF_POSSESSION_INVALID" }, { status: 400 });
  }
  if (result.outcome === "DUPLICATE_KEY") {
    return NextResponse.json({ registered: false, reason: "DUPLICATE_KEY" }, { status: 409 });
  }
  if (result.outcome === "CHALLENGE_ALREADY_CONSUMED") {
    return NextResponse.json({ registered: false, reason: "CHALLENGE_ALREADY_CONSUMED" }, { status: 409 });
  }
  if (result.outcome === "LIMIT_REACHED") {
    return NextResponse.json(
      { registered: false, reason: "LIMIT_REACHED", maxActiveInstallations: result.maxActiveInstallations },
      { status: 409 },
    );
  }
  if (result.outcome === "RATE_LIMITED") {
    return NextResponse.json({ registered: false, reason: "RATE_LIMITED" }, { status: 429 });
  }

  return NextResponse.json({ registered: true, installationId: result.installationId, publicKeyFingerprint: result.publicKeyFingerprint });
}

export const dynamic = "force-dynamic";
