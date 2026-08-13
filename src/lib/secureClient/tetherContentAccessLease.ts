/**
 * Release-blocking security audit — the server content boundary. See
 * docs/tether-content-access-lease-v1.md.
 *
 * CONFIRMED VULNERABILITY this exists to close: every existing content
 * gate for a TETHER_CLIENT_REQUIRED attempt (isSubmissionContentAccessible
 * — activatedAt !== null — and hasVerifiedTetherSession, resolved via
 * getCurrentSessionForSubmission + resolveTrustedTetherVerification) is
 * SUBMISSION-bound, never REQUEST-bound: both are plain database reads
 * keyed only by submissionId, with no way to tell whether the CURRENT
 * HTTP request actually originated from the Tether installation that
 * established that trust. An ordinary Chrome/Edge tab, authenticated as
 * the SAME student via their normal login (which requires no
 * Tether-specific proof at all — the student's own credentials are
 * always sufficient), could reach every one of these routes and satisfy
 * every existing check purely because a verified session and an
 * activated submission already exist SOMEWHERE — not because THIS
 * request came from Tether.
 *
 * This module adds a short-lived, server-signed, browser-held bearer
 * lease, delivered ONLY as an HttpOnly cookie in the response to an
 * event that already required genuine NATIVE INSTALLATION-KEY proof:
 * v2 EXAM_SESSION attestation succeeding (installation private-key
 * signature verified server-side), or POST /activate's own success
 * (refresh only — it can never bootstrap the first lease, since it
 * itself requires one to already be present). Release-blocking
 * follow-up review: legacy attestation (POST
 * /api/secure-client/sessions/[sessionId]/attestation) is EXPLICITLY
 * EXCLUDED as an issuance source — its body (checks/required/
 * displayCount/clientVersion/...) is entirely client-self-reported with
 * no installation-key signature anywhere in that flow, so an ordinary
 * authenticated browser could otherwise manufacture the lease itself by
 * simply POSTing a fabricated body (e.g. {checks:{}, required:{}}, which
 * always resolves to overallStatus READY) — defeating the whole point of
 * this module. See requireTetherContentAccess.ts's issueContentAccessLeaseCookie
 * doc comment for the exact, sole legitimate call sites.
 *
 * Because Electron's cookie jar is never shared with the student's
 * ordinary system browser profile, this cookie is physically absent
 * from any Chrome/Edge request, however validly authenticated as the
 * same student — closing exactly the gap above without weakening
 * anything for STANDARD_WEB. Scoped to TETHER_CLIENT_REQUIRED only —
 * this lease is never required or issued for SEB_REQUIRED either: SEB
 * has no native installation-key mechanism to prove possession with, so
 * requiring it there would only lock every SEB attempt out of its own
 * exam. This is a deliberate scope boundary, not an oversight — SEB's
 * own parallel request-binding gap (if any) is unaddressed by this
 * module and would need its own, SEB-native mechanism.
 *
 * Deliberately reuses the EXISTING Ed25519 server signing keypair
 * (TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY/PUBLIC_KEY — see
 * getSigningPrivateKey/getSigningPublicKey in secureClientRunner.ts,
 * already used to sign launch manifests and attestation challenges)
 * rather than a new secret or a database-stored token — no schema
 * migration required. The lease itself is a compact, self-contained,
 * signed claim set (the same canonicalJsonStringify + Ed25519
 * sign/verify pattern as secureLaunchManifest.ts), never a bare
 * database id or a client-supplied boolean.
 *
 * Server-only (Node `crypto`), otherwise dependency-free — no Prisma,
 * no Next.js, mirroring every other module in src/lib/secureClient/.
 */
import crypto from "crypto";
import { canonicalJsonStringify, computeStudentSubjectHash } from "./secureLaunchManifest";

export const CONTENT_ACCESS_LEASE_SCHEMA_VERSION = 1;
export const CONTENT_ACCESS_LEASE_PURPOSE = "TETHER_CONTENT_ACCESS" as const;
export const CONTENT_ACCESS_LEASE_COOKIE_NAME = "tether_content_lease";

/** Short — this is a request-bound proof re-issued on every attestation/activation event, never a long-lived credential. */
export const CONTENT_ACCESS_LEASE_TTL_SECONDS = 60 * 30;

export type ContentAccessLeaseClaims = {
  schemaVersion: number;
  purpose: typeof CONTENT_ACCESS_LEASE_PURPOSE;
  keyId: string;
  submissionId: string;
  secureClientSessionId: string;
  /**
   * The installation public-key fingerprint proven by the v2 attestation
   * that issued (or, at /activate refresh, most recently reconfirmed) this
   * lease — see verifyExamSessionAttestation's own
   * installationPublicKeyFingerprint result field. Binds the lease to the
   * SPECIFIC key material that was cryptographically proven, not merely
   * to a mutable installation row id. null only in the defensive case of
   * a caller that somehow has no fingerprint to offer — matches() below
   * always fails closed on null.
   */
  installationKeyFingerprint: string | null;
  studentSubjectHash: string;
  issuedAt: string;
  expiresAt: string;
};

export function buildContentAccessLeaseClaims(params: {
  keyId: string;
  submissionId: string;
  secureClientSessionId: string;
  installationKeyFingerprint: string | null;
  studentId: string;
  nowMs?: number;
  ttlSeconds?: number;
}): ContentAccessLeaseClaims {
  const now = params.nowMs ?? Date.now();
  const ttl = (params.ttlSeconds ?? CONTENT_ACCESS_LEASE_TTL_SECONDS) * 1000;
  return {
    schemaVersion: CONTENT_ACCESS_LEASE_SCHEMA_VERSION,
    purpose: CONTENT_ACCESS_LEASE_PURPOSE,
    keyId: params.keyId,
    submissionId: params.submissionId,
    secureClientSessionId: params.secureClientSessionId,
    installationKeyFingerprint: params.installationKeyFingerprint,
    studentSubjectHash: computeStudentSubjectHash(params.studentId),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
  };
}

function canonicalClaimsString(claims: ContentAccessLeaseClaims): string {
  return canonicalJsonStringify(claims);
}

export function signContentAccessLeaseClaims(claims: ContentAccessLeaseClaims, privateKeyPem: string): string {
  const data = Buffer.from(canonicalClaimsString(claims), "utf8");
  return crypto.sign(null, data, privateKeyPem).toString("base64");
}

export function verifyContentAccessLeaseSignature(claims: ContentAccessLeaseClaims, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const data = Buffer.from(canonicalClaimsString(claims), "utf8");
    const signature = Buffer.from(signatureBase64, "base64");
    return crypto.verify(null, data, publicKeyPem, signature);
  } catch {
    return false;
  }
}

/** The cookie's actual on-the-wire value: base64url(canonical claims JSON) + "." + base64url(signature) — compact, self-contained, never requiring a server-side lookup to decode (though callers still re-check the claims against live DB state — see requireTetherContentAccess.ts). */
export function encodeContentAccessLeaseCookieValue(claims: ContentAccessLeaseClaims, privateKeyPem: string): string {
  const signature = signContentAccessLeaseClaims(claims, privateKeyPem);
  const claimsPart = Buffer.from(canonicalClaimsString(claims), "utf8").toString("base64url");
  const signaturePart = Buffer.from(signature, "base64").toString("base64url");
  return `${claimsPart}.${signaturePart}`;
}

/**
 * Decodes and cryptographically verifies a cookie value. Returns null for
 * ANYTHING malformed, unparseable, or with an invalid signature — never
 * throws, and never returns claims that were not genuinely signed by
 * this server's own private key. Does NOT check expiry or match the
 * claims against live DB state — see requireTetherContentAccess.ts for
 * the full, additional checks every caller must also apply.
 */
export function decodeAndVerifyContentAccessLeaseCookieValue(cookieValue: string, publicKeyPem: string): ContentAccessLeaseClaims | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  const [claimsPart, signaturePart] = parts;
  let claims: unknown;
  try {
    const claimsJson = Buffer.from(claimsPart, "base64url").toString("utf8");
    claims = JSON.parse(claimsJson);
  } catch {
    return null;
  }
  if (!isPlausibleContentAccessLeaseClaims(claims)) return null;
  const signatureBase64 = Buffer.from(signaturePart, "base64url").toString("base64");
  if (!verifyContentAccessLeaseSignature(claims, signatureBase64, publicKeyPem)) return null;
  return claims;
}

function isPlausibleContentAccessLeaseClaims(value: unknown): value is ContentAccessLeaseClaims {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === CONTENT_ACCESS_LEASE_SCHEMA_VERSION &&
    v.purpose === CONTENT_ACCESS_LEASE_PURPOSE &&
    typeof v.keyId === "string" &&
    typeof v.submissionId === "string" &&
    typeof v.secureClientSessionId === "string" &&
    (v.installationKeyFingerprint === null || typeof v.installationKeyFingerprint === "string") &&
    typeof v.studentSubjectHash === "string" &&
    typeof v.issuedAt === "string" &&
    typeof v.expiresAt === "string"
  );
}

/** Pure — never touches the clock itself, so it is directly unit-testable. */
export function isContentAccessLeaseExpired(claims: ContentAccessLeaseClaims, nowMs: number): boolean {
  const expiresAtMs = Date.parse(claims.expiresAt);
  if (Number.isNaN(expiresAtMs)) return true; // malformed timestamp — fail closed, never treated as unexpired.
  return nowMs >= expiresAtMs;
}

/**
 * The full match check against LIVE state — a cryptographically valid,
 * unexpired lease is still only accepted when it matches exactly what is
 * being requested RIGHT NOW: the same submission, the same student,
 * (critically) the SAME secure-client session that is currently the
 * trusted one for this submission, AND the same installation key
 * fingerprint that session is currently bound to. A lease from a session
 * that has since been superseded (a new legitimate Tether launch, a
 * revoked/replaced session, a different installation taking over) never
 * matches and is correctly rejected — a lease is never trusted merely
 * because it was once validly issued. Fails closed whenever either
 * fingerprint is null (a session/lease pair that somehow never carries
 * proof of installation-key possession is never treated as a match).
 */
export function contentAccessLeaseMatches(
  claims: ContentAccessLeaseClaims,
  expected: {
    submissionId: string;
    studentId: string;
    currentSecureClientSessionId: string;
    currentInstallationKeyFingerprint: string | null;
  },
): boolean {
  return (
    claims.submissionId === expected.submissionId &&
    claims.studentSubjectHash === computeStudentSubjectHash(expected.studentId) &&
    claims.secureClientSessionId === expected.currentSecureClientSessionId &&
    claims.installationKeyFingerprint !== null &&
    claims.installationKeyFingerprint === expected.currentInstallationKeyFingerprint
  );
}
