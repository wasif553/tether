/**
 * Canvas/LTI identity-collision browser-flow hardening — see
 * docs/lti-identity-collision-hardening-v1.md.
 *
 * Auth.js's session cookie uses the SameSite=Lax default (unchanged,
 * deliberately — see that doc). A Canvas LTI launch is a cross-site POST
 * from Canvas to Tether, so the browser will not attach that cookie to
 * it; `auth()` inside POST /api/lti/launch can never reliably see the
 * student's existing Tether session. Reading it there was the bug this
 * module fixes.
 *
 * Instead, once a Canvas launch (already cryptographically verified)
 * detects an email collision, the launch route issues one of these
 * short-lived, server-signed handoff tokens and redirects the browser to
 * a normal, same-site Tether page. That page performs a same-site POST
 * to the dedicated confirmation endpoint, where `auth()` — now reading
 * cookies on an ordinary same-origin request — works exactly as it does
 * everywhere else in this app.
 *
 * The token carries only the minimum identifiers needed to safely
 * resume linking: which existing User is the candidate, which Canvas
 * identity, which platform, and the role Canvas reported. It is
 * signed (not merely encoded) so the client can carry it through a page
 * navigation and a login round-trip without being able to forge or
 * modify any of those fields — but the token alone is never sufficient
 * to link an account. The confirmation endpoint still requires
 * `session.user.id === handoff.existingUserId`, so forwarding a handoff
 * URL to someone else cannot link the account to them.
 *
 * Signed with jose (already a dependency, already used for LTI id_token
 * verification) using a key HKDF-derived from AUTH_SECRET with a
 * dedicated context label — never AUTH_SECRET itself, so this token's
 * key is cryptographically independent of the NextAuth session-cookie
 * signing key: a leak of one context's derived key does not expose the
 * other's.
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { hkdfSync } from "node:crypto";

const HANDOFF_CONTEXT_LABEL = "lti-identity-link-handoff-v1";
export const IDENTITY_LINK_HANDOFF_TTL_SECONDS = 10 * 60; // 10 minutes

export type IdentityLinkHandoff = {
  existingUserId: string;
  canvasUserId: string;
  platformId: string;
  derivedRole: "STUDENT" | "LECTURER";
};

function deriveHandoffKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("Missing required environment variable: AUTH_SECRET");
  }
  // HKDF-SHA256, 32-byte output — a standard KDF for exactly this
  // "derive an independent subkey from one root secret" use case, never
  // exposing or reusing AUTH_SECRET directly as a signing key.
  return new Uint8Array(
    hkdfSync("sha256", secret, "", HANDOFF_CONTEXT_LABEL, 32),
  );
}

export async function createIdentityLinkHandoff(payload: IdentityLinkHandoff): Promise<string> {
  const key = deriveHandoffKey();
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${IDENTITY_LINK_HANDOFF_TTL_SECONDS}s`)
    .sign(key);
}

function isIdentityLinkHandoffPayload(payload: JWTPayload): payload is JWTPayload & IdentityLinkHandoff {
  return (
    typeof payload.existingUserId === "string" &&
    typeof payload.canvasUserId === "string" &&
    typeof payload.platformId === "string" &&
    (payload.derivedRole === "STUDENT" || payload.derivedRole === "LECTURER")
  );
}

/** Returns the verified payload, or null for any invalid/tampered/expired token — never throws. */
export async function verifyIdentityLinkHandoff(token: string): Promise<IdentityLinkHandoff | null> {
  try {
    const key = deriveHandoffKey();
    const { payload } = await jwtVerify(token, key);
    if (!isIdentityLinkHandoffPayload(payload)) return null;
    return {
      existingUserId: payload.existingUserId,
      canvasUserId: payload.canvasUserId,
      platformId: payload.platformId,
      derivedRole: payload.derivedRole,
    };
  } catch {
    return null;
  }
}
