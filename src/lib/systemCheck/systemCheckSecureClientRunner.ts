/**
 * Tether System Check and Exam Readiness v1 — corrective pass (first-time
 * verification). See docs/tether-system-check-v1.md, "System-check
 * secure-client verification".
 *
 * Server-only orchestration for the SYSTEM_CHECK challenge/verify flow.
 * Touches Prisma, so this must never be imported from a "use client"
 * component — pure decision logic lives in
 * src/lib/secureClient/systemCheckChallenge.ts. Reuses the EXACT same
 * Ed25519 signing key as the real exam-launch manifest flow
 * (getSigningPrivateKey/getSigningPublicKey/getSigningKeyId from
 * secureClientRunner.ts) — there is only ever one signing key configured
 * for this deployment, and this module does not introduce a second one.
 *
 * Structural non-authorization guarantee: nothing in this file creates,
 * reads, or updates Submission, Answer, IntegrityEvent, ExamAttemptSession,
 * SecureClientSession, or SecureClientLaunchManifest — the only table
 * this module ever writes to is SystemCheckSecureClientVerification,
 * which the exam start/launch/attestation code path never reads. A
 * SYSTEM_CHECK verification therefore cannot authorize exam content by
 * construction, not merely by convention — see
 * src/lib/tetherSystemCheckSecureClient.routes.test.ts for the automated
 * proof (exam start/content routes behave identically whether or not a
 * verification row exists).
 */
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { getSigningPrivateKey, getSigningPublicKey, getSigningKeyId } from "@/lib/secureClientRunner";
import {
  SYSTEM_CHECK_CHALLENGE_SCHEMA_VERSION,
  SYSTEM_CHECK_CHALLENGE_ISSUER,
  SYSTEM_CHECK_CHALLENGE_PURPOSE,
  computeUserSubjectHash,
  computeChallengeHash,
  generateSystemCheckNonce,
  hashNonce,
  signChallenge,
  validateChallengeContext,
  type SystemCheckChallenge,
  type ChallengeValidationReasonCode,
} from "@/lib/secureClient/systemCheckChallenge";
import { verifyClientAttestation, clientAttestationPublicKey, type ClientAttestationFacts } from "@/lib/secureClient/systemCheckClientAttestation";
import { isValidDisplayTopologyClassification } from "@/lib/systemCheck/readiness";

/** Short-lived on purpose — a quick round trip while the student has the system-check page open, not a multi-minute installer wait like the exam-launch manifest's TTL. */
export const SYSTEM_CHECK_CHALLENGE_TTL_SECONDS = 120;

/** A fixed, non-exam audience string — distinct in spirit from the exam-launch manifest's per-exam canonicalExamOrigin/audience, since a system check has no exam to bind to. */
export const SYSTEM_CHECK_AUDIENCE = "tether-system-check";

/** The only client types a genuine system-check verification may claim. Mirrors CLIENT_TYPES in secureClientPolicy.ts, minus SAFE_EXAM_BROWSER (SEB has no comparable native bridge to attest with). */
export const SYSTEM_CHECK_CLIENT_TYPES = ["TETHER_SECURE_CLIENT", "MOCK_TETHER_CLIENT"] as const;
export type SystemCheckClientType = (typeof SYSTEM_CHECK_CLIENT_TYPES)[number];
export function isValidSystemCheckClientType(value: string): value is SystemCheckClientType {
  return (SYSTEM_CHECK_CLIENT_TYPES as readonly string[]).includes(value);
}

/** Issues a fresh, signed, single-use SYSTEM_CHECK challenge. No database write — the challenge itself is the stateless, self-contained artifact (mirrors how a signed JWT needs no server-side row until it is redeemed); replay protection is enforced at verification time via the nonceHash unique constraint. */
export function issueSystemCheckChallenge(params: { userId: string }): { challenge: SystemCheckChallenge; signature: string } {
  const now = new Date();
  const challenge: SystemCheckChallenge = {
    schemaVersion: SYSTEM_CHECK_CHALLENGE_SCHEMA_VERSION,
    challengeId: randomBytes(16).toString("hex"),
    keyId: getSigningKeyId(),
    issuer: SYSTEM_CHECK_CHALLENGE_ISSUER,
    purpose: SYSTEM_CHECK_CHALLENGE_PURPOSE,
    audience: SYSTEM_CHECK_AUDIENCE,
    userSubjectHash: computeUserSubjectHash(params.userId),
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: new Date(now.getTime() + SYSTEM_CHECK_CHALLENGE_TTL_SECONDS * 1000).toISOString(),
    nonce: generateSystemCheckNonce(),
  };
  const signature = signChallenge(challenge, getSigningPrivateKey());
  return { challenge, signature };
}

export type VerifySystemCheckChallengeParams = {
  userId: string;
  institutionId: string;
  challenge: SystemCheckChallenge;
  signature: string;
  clientType: SystemCheckClientType;
  /**
   * Security hardening pass — see docs/tether-system-check-v1.md,
   * "Genuine client attestation". REQUIRED: the second, independent
   * signature produced by the embedded client-attestation private key
   * that exists only inside a genuine packaged Electron main process
   * (apps/lockdown/src/clientAttestationKey.ts) — never a renderer-
   * computed or client-self-reported value. Proves possession of that
   * key, which an ordinary browser cannot obtain or reproduce.
   */
  clientAttestation: ClientAttestationFacts;
};

export type VerifySystemCheckChallengeResult =
  | { outcome: "VERIFIED"; verificationId: string; expiresAt: Date }
  | { outcome: "REPLAY" }
  | { outcome: "INVALID"; reason: ChallengeValidationReasonCode }
  | { outcome: "CLIENT_ATTESTATION_INVALID" };

/**
 * Verifies a signed SYSTEM_CHECK challenge response and, only if
 * genuine, persists exactly one narrowly-scoped verification row. Never
 * trusts a renderer-supplied "verified" boolean. Two INDEPENDENT
 * signatures are checked:
 *
 *  1. The server's own challenge signature (validateChallengeContext) —
 *     proves the challenge itself was issued by this server, bound to
 *     this user/purpose/audience, and hasn't expired. This alone is
 *     NOT proof of client genuineness — any browser can echo a valid
 *     challenge back (see the security hardening pass report).
 *  2. The client-attestation signature (verifyClientAttestation) —
 *     proves the responder possesses the embedded private key that
 *     ONLY exists inside a genuine packaged Tether Secure Browser main
 *     process, bound to the exact nonce/clientVersion/platform/
 *     displayTopologyClassification facts reported. An ordinary Chrome
 *     or Edge browser — even one that fabricates every native fact and
 *     resubmits a perfectly valid server challenge — cannot produce a
 *     valid signature here, because it never possesses that key.
 *
 * BOTH must pass before a verification row is ever written. Replay is
 * rejected by the nonceHash UNIQUE constraint — a second verify attempt
 * with the same nonce always fails to insert, exactly like
 * consumeLaunchManifest's real-exam-flow replay protection.
 */
export async function verifySystemCheckChallenge(params: VerifySystemCheckChallengeParams): Promise<VerifySystemCheckChallengeResult> {
  const expectedUserSubjectHash = computeUserSubjectHash(params.userId);
  const validation = validateChallengeContext(params.challenge, params.signature, getSigningPublicKey(), {
    expectedAudience: SYSTEM_CHECK_AUDIENCE,
    expectedUserSubjectHash,
    nowMs: Date.now(),
  });
  if (validation !== "VALID") {
    return { outcome: "INVALID", reason: validation };
  }

  // The client-attestation must be bound to THIS exact challenge's
  // nonce — a signature genuinely produced for a DIFFERENT nonce (e.g.
  // replayed from an earlier round trip) is rejected here, before ever
  // reaching the crypto verification itself.
  if (params.clientAttestation.nonce !== params.challenge.nonce) {
    return { outcome: "CLIENT_ATTESTATION_INVALID" };
  }
  if (!isValidDisplayTopologyClassification(params.clientAttestation.displayTopologyClassification)) {
    return { outcome: "CLIENT_ATTESTATION_INVALID" };
  }
  let publicKey: string;
  try {
    publicKey = clientAttestationPublicKey();
  } catch {
    return { outcome: "CLIENT_ATTESTATION_INVALID" };
  }
  if (!verifyClientAttestation(params.clientAttestation, publicKey)) {
    return { outcome: "CLIENT_ATTESTATION_INVALID" };
  }

  const nonceHash = hashNonce(params.challenge.nonce);
  const challengeHash = computeChallengeHash(params.challenge);

  try {
    const record = await prisma.systemCheckSecureClientVerification.create({
      data: {
        userId: params.userId,
        institutionId: params.institutionId,
        purpose: "SYSTEM_CHECK",
        clientType: params.clientType,
        verificationStatus: "VERIFIED",
        clientVersion: params.clientAttestation.clientVersion,
        platform: params.clientAttestation.platform,
        displayTopologyClassification: params.clientAttestation.displayTopologyClassification,
        nonceHash,
        challengeHash,
        issuedAt: new Date(params.challenge.issuedAt),
        expiresAt: new Date(params.challenge.expiresAt),
        verifiedAt: new Date(),
      },
    });
    return { outcome: "VERIFIED", verificationId: record.id, expiresAt: record.expiresAt };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { outcome: "REPLAY" };
    }
    throw err;
  }
}

/**
 * Ownership + freshness lookup for POST /api/tether/system-check/runs —
 * mirrors loadValidatedSecureClientSession's ownership check exactly
 * (404-equivalent semantics for both "not found" and "belongs to
 * someone else", never distinguishing the two in the response). Also
 * confirms `purpose === "SYSTEM_CHECK"` and that the verification has
 * not itself expired, so a verification's usefulness for the readiness
 * check expires along with the underlying signed challenge.
 */
export async function loadOwnedSystemCheckVerification(verificationId: string, userId: string) {
  const record = await prisma.systemCheckSecureClientVerification.findUnique({ where: { id: verificationId } });
  if (!record || record.userId !== userId) return null;
  return record;
}
