/**
 * Tether System Check and Exam Readiness v1 — corrective pass (first-time
 * verification). See docs/tether-system-check-v1.md.
 *
 * POST /api/tether/system-check/secure-client/verify — the student's
 * Tether Secure Browser echoes back the signed challenge it received
 * from .../challenge, along with the native client facts it gathered
 * (clientType/clientVersion/platform via the existing
 * window.sesLockdown bridge). The server independently re-verifies the
 * Ed25519 signature and every bound context field — it NEVER trusts a
 * renderer-supplied "verified" boolean; there is no such field in this
 * request body at all. A second verify attempt with the same nonce is
 * rejected as a replay (nonceHash UNIQUE constraint). Never logs the
 * full challenge or signature — only the outcome and reason code.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { requireInstitutionId } from "@/lib/institutionScope";
import { verifySystemCheckChallenge, isValidSystemCheckClientType, SYSTEM_CHECK_CLIENT_TYPES } from "@/lib/systemCheck/systemCheckSecureClientRunner";
import { SYSTEM_CHECK_CHALLENGE_PURPOSE } from "@/lib/secureClient/systemCheckChallenge";

const challengeSchema = z.object({
  schemaVersion: z.number().int(),
  challengeId: z.string().min(1).max(200),
  keyId: z.string().min(1).max(200),
  issuer: z.string().min(1).max(200),
  purpose: z.literal(SYSTEM_CHECK_CHALLENGE_PURPOSE),
  audience: z.string().min(1).max(200),
  userSubjectHash: z.string().min(1).max(200),
  issuedAt: z.string().min(1).max(64),
  notBefore: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
  nonce: z.string().min(1).max(512),
});

const bodySchema = z.object({
  challenge: challengeSchema,
  signature: z.string().min(1).max(2048),
  clientType: z.enum(SYSTEM_CHECK_CLIENT_TYPES),
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
  if (!isValidSystemCheckClientType(body.clientType)) {
    return NextResponse.json({ error: "Unsupported client type" }, { status: 400 });
  }

  let institutionId: string;
  try {
    institutionId = requireInstitutionId(session);
  } catch {
    return NextResponse.json({ error: "Institution not resolved for this account" }, { status: 403 });
  }

  const result = await verifySystemCheckChallenge({
    userId: session.user.id,
    institutionId,
    challenge: body.challenge,
    signature: body.signature,
    clientType: body.clientType,
    clientVersion: body.clientVersion ?? null,
    platform: body.platform ?? null,
  });

  if (result.outcome === "INVALID") {
    return NextResponse.json({ verified: false, reason: result.reason }, { status: 400 });
  }
  if (result.outcome === "REPLAY") {
    return NextResponse.json({ verified: false, reason: "REPLAY" }, { status: 409 });
  }

  return NextResponse.json({ verified: true, verificationId: result.verificationId, expiresAt: result.expiresAt });
}

export const dynamic = "force-dynamic";
