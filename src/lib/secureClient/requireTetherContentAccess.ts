/**
 * Release-blocking security audit — the server content boundary. See
 * tetherContentAccessLease.ts's own doc comment for the full
 * vulnerability writeup this closes, and
 * docs/tether-content-access-lease-v1.md.
 *
 * The ONE function every TETHER_CLIENT_REQUIRED content-bearing route
 * must call, in addition to (never instead of) the existing
 * hasVerifiedTetherSession / isSubmissionContentAccessible checks —
 * this is what makes the whole check bound to a browser that has
 * genuinely presented native installation-key proof at least once,
 * rather than merely submission-bound. Deliberately mirrors
 * loadValidatedSecureClientSubmission's own "one shared function, every
 * call site reuses it" convention in secureClientRunner.ts, so this can
 * never drift between routes.
 *
 * Accuracy note (release-blocking follow-up review): this is a
 * short-lived, browser-held BEARER credential — a capability cookie —
 * not a signature over each individual HTTP request. It can only ever
 * be MINTED after genuine native installation-key proof (see
 * issueContentAccessLeaseCookie's own doc comment for the exact, sole
 * issuance point), and every read is re-checked against the LIVE
 * SecureClientSession for this submission, but while it remains valid
 * and unexpired it authorizes every request that carries it, exactly
 * like any other session cookie. The server's existing live
 * session/heartbeat/freshness checks (resolveTrustedTetherVerification)
 * are NOT replaced by this lease and continue to run independently on
 * every protected route.
 *
 * Scope: TETHER_CLIENT_REQUIRED only. SAFE_EXAM_BROWSER has no
 * installation-key mechanism to prove possession with, so it is never
 * required or issued for a SEB_REQUIRED attempt — see each call site's
 * own `policy.deliveryMode === "TETHER_CLIENT_REQUIRED"` guard.
 */
import { NextResponse } from "next/server";
import { getSigningPrivateKey, getSigningPublicKey, getSigningKeyId, getCurrentSessionForSubmission } from "@/lib/secureClientRunner";
import {
  CONTENT_ACCESS_LEASE_COOKIE_NAME,
  buildContentAccessLeaseClaims,
  encodeContentAccessLeaseCookieValue,
  decodeAndVerifyContentAccessLeaseCookieValue,
  isContentAccessLeaseExpired,
  contentAccessLeaseMatches,
  CONTENT_ACCESS_LEASE_TTL_SECONDS,
} from "./tetherContentAccessLease";

function isSecureEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Same cookie-option shape/conventions as sessionBinding.ts's
 * browserSessionCookieOptions — httpOnly, no client-side script can ever
 * read or forge this value. SameSite=Strict (tighter than
 * sessionBinding.ts's own Lax): every request that needs to carry this
 * cookie is a same-origin fetch() issued by the Tether renderer itself
 * against this app's own origin — never a cross-site navigation or a
 * third-party embed — so there is no legitimate flow Strict would break.
 */
function contentAccessLeaseCookieOptions() {
  return {
    httpOnly: true as const,
    secure: isSecureEnvironment(),
    sameSite: "strict" as const,
    path: "/",
    maxAge: CONTENT_ACCESS_LEASE_TTL_SECONDS,
  };
}

/**
 * Called ONLY from a point that already required genuine, native-backed
 * proof for THIS request — release-blocking follow-up review: legacy
 * attestation is NOT such a point (it is entirely client-self-reported,
 * no installation-key signature) and must NEVER call this. The two
 * legitimate call sites are: (1) v2 installation-key-backed EXAM_SESSION
 * attestation succeeding (POST /api/tether/exam-session/attestation/verify
 * — the sole INITIAL issuance point), and (2) POST /activate's own
 * success, which only ever REFRESHES an already-valid lease (it requires
 * one to already be present via checkTetherContentAccessLease before it
 * can succeed at all — see that route's own doc comment — so it can
 * never bootstrap the first lease). Sets (or refreshes) the lease cookie
 * on the given response, scoped to the CURRENT secure-client session.
 * Safe to call repeatedly — each call simply reissues a fresh lease.
 */
export function issueContentAccessLeaseCookie(
  response: NextResponse,
  params: { submissionId: string; secureClientSessionId: string; installationKeyFingerprint: string | null; studentId: string },
): void {
  const claims = buildContentAccessLeaseClaims({
    keyId: getSigningKeyId(),
    submissionId: params.submissionId,
    secureClientSessionId: params.secureClientSessionId,
    installationKeyFingerprint: params.installationKeyFingerprint,
    studentId: params.studentId,
  });
  const value = encodeContentAccessLeaseCookieValue(claims, getSigningPrivateKey());
  response.cookies.set(CONTENT_ACCESS_LEASE_COOKIE_NAME, value, contentAccessLeaseCookieOptions());
}

/** Same manual Cookie-header parse as examAttemptSessionRunner.ts's own parseCookies — these routes take a plain Request, not a NextRequest, so there is no req.cookies accessor. One shared implementation so every call site reads the lease cookie identically. */
export function readContentAccessLeaseCookieFromRequest(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== CONTENT_ACCESS_LEASE_COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export type ContentAccessDecision =
  | { ok: true; renewal: { secureClientSessionId: string; installationKeyFingerprint: string | null } }
  | { ok: false; reason: "MISSING" | "INVALID" | "EXPIRED" | "SESSION_MISMATCH" };

/**
 * The read-side check every protected content route must pass, in
 * ADDITION to its own existing hasVerifiedTetherSession/
 * isSubmissionContentAccessible checks — never a replacement for either.
 * Re-derives the CURRENT trusted secure-client session from the database
 * itself (never trusts the cookie's own claims about which session is
 * "current") — a lease from a session that has since been superseded
 * (a new legitimate Tether launch, a revoked/replaced session) is
 * correctly rejected even though its signature is still cryptographically
 * valid.
 */
export async function checkTetherContentAccessLease(
  cookieValue: string | undefined,
  params: { submissionId: string; studentId: string },
): Promise<ContentAccessDecision> {
  if (!cookieValue) return { ok: false, reason: "MISSING" };

  const claims = decodeAndVerifyContentAccessLeaseCookieValue(cookieValue, getSigningPublicKey());
  if (!claims) return { ok: false, reason: "INVALID" };

  if (isContentAccessLeaseExpired(claims, Date.now())) return { ok: false, reason: "EXPIRED" };

  const currentSession = await getCurrentSessionForSubmission(params.submissionId);
  if (!currentSession) return { ok: false, reason: "SESSION_MISMATCH" };

  const matches = contentAccessLeaseMatches(claims, {
    submissionId: params.submissionId,
    studentId: params.studentId,
    currentSecureClientSessionId: currentSession.id,
    currentInstallationKeyFingerprint: currentSession.clientInstallationIdHash ?? null,
  });
  if (!matches) return { ok: false, reason: "SESSION_MISMATCH" };
  return {
    ok: true,
    renewal: {
      secureClientSessionId: currentSession.id,
      installationKeyFingerprint: currentSession.clientInstallationIdHash ?? null,
    },
  };
}

/**
 * Rolling renewal (release-blocking follow-up review — the lease's fixed
 * 30-minute TTL, with issuance only ever happening at v2 attestation and
 * the one-time POST /activate, meant a legitimate 60/90/120-minute exam
 * would start getting TETHER_CONTENT_ACCESS_REQUIRED 403s on every
 * content route roughly 30 minutes in, even with native lockdown, the
 * SecureClientSession, and the heartbeat all still perfectly healthy).
 *
 * Safe to call unconditionally at the end of ANY protected route's
 * success path, including STANDARD_WEB/SEB_REQUIRED ones — it is a pure
 * best-effort "extend if currently valid" operation, never a gate: it
 * never throws and never affects the response's status/body, and it
 * silently no-ops whenever there is nothing to renew (no cookie at all —
 * every non-Tether request — or one that is invalid, expired, or bound to
 * a superseded session). Internally just re-runs
 * checkTetherContentAccessLease's own full decode + signature + expiry +
 * live-current-session + installation-fingerprint chain, so a renewal can
 * only ever happen for a lease that independently re-validates against
 * live state at the moment of the call — this can never be used to
 * bootstrap a lease that did not already exist and pass every one of
 * those checks, matching REQUIRED PROPERTY 3/4 in
 * docs/tether-content-access-lease-v1.md (missing/expired can never be
 * renewed through this or any other route — only fresh v2 installation
 * attestation can mint a new one).
 */
export async function renewTetherContentAccessLeaseIfValid(
  req: Request,
  response: NextResponse,
  params: { submissionId: string; studentId: string },
): Promise<void> {
  const decision = await checkTetherContentAccessLease(readContentAccessLeaseCookieFromRequest(req), params);
  renewContentAccessLeaseFromValidatedDecision(response, decision, params);
}

/**
 * Performance follow-up (physical acceptance review — answer-save/
 * navigation latency audit): every route that already gates on the lease
 * calls checkTetherContentAccessLease once as that gate, then previously
 * called renewTetherContentAccessLeaseIfValid on its success path, which
 * ran the ENTIRE check a SECOND time — a second Ed25519 decode+verify and
 * a second getCurrentSessionForSubmission database read, both fully
 * redundant, since a request that already has `decision.ok === true` from
 * the gate cannot meaningfully re-decide anything by re-running the exact
 * same check against the exact same live state microseconds later.
 *
 * Use this instead of renewTetherContentAccessLeaseIfValid whenever the
 * route already computed a ContentAccessDecision earlier in the SAME
 * request (as its own access gate) — it reissues the lease straight from
 * that already-validated decision's `renewal` payload, doing no
 * additional decoding, signature verification, or database work at all.
 * Exactly as fail-closed as the original: `decision.ok` can only be true
 * if checkTetherContentAccessLease's full chain (decode, signature,
 * expiry, live-current-session match, installation-fingerprint match)
 * already passed at the point that decision was produced, so this can
 * never renew — let alone bootstrap — a lease that didn't independently
 * earn it.
 *
 * `decision` MUST be a genuine ContentAccessDecision value returned by
 * checkTetherContentAccessLease earlier in THIS SAME request/route
 * execution — never a value reconstructed from client input, cached
 * across requests, or passed through a network boundary. There is
 * nothing in this function's own logic that re-derives or re-checks that
 * fact, so callers are the enforcement point for it — exactly like every
 * other "trust the caller already did the gate check" helper in this
 * codebase (see e.g. isSubmissionContentAccessible's own callers).
 *
 * renewTetherContentAccessLeaseIfValid remains the right choice for a
 * route that does NOT already gate on the lease and only wants to
 * opportunistically extend one if present (its one legitimate use today:
 * session-heartbeat, which is not itself lease-gated).
 */
export function renewContentAccessLeaseFromValidatedDecision(
  response: NextResponse,
  decision: ContentAccessDecision,
  params: { submissionId: string; studentId: string },
): void {
  if (!decision.ok) return;
  issueContentAccessLeaseCookie(response, {
    submissionId: params.submissionId,
    secureClientSessionId: decision.renewal.secureClientSessionId,
    installationKeyFingerprint: decision.renewal.installationKeyFingerprint,
    studentId: params.studentId,
  });
}

/** Bounded, non-alarming — mirrors EXAM_NOT_ACTIVATED_MESSAGE/_CODE's own shape in secureClientActivation.ts. Never reveals WHY (missing vs. expired vs. mismatched) beyond the code, which is already only diagnostic. */
export const TETHER_CONTENT_ACCESS_REQUIRED_CODE = "TETHER_CONTENT_ACCESS_REQUIRED";
export const TETHER_CONTENT_ACCESS_REQUIRED_MESSAGE =
  "This examination must be accessed from the same Tether Secure Browser session that activated it. Return to Tether Secure Browser to continue.";
