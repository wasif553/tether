/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * The credential-verification logic behind src/auth.ts's Credentials
 * `authorize()`, extracted into its own directly-testable module — same
 * convention as src/lib/passwordReset.ts being extracted from its route
 * handlers. NextAuth's internal request-handling pipeline is not
 * practical to exercise directly in a unit test; this function needs
 * only a source-address string, not a real Request/NextAuth context.
 *
 * Preserves the EXISTING lookup/bcrypt/anti-enumeration behavior exactly
 * — this feature adds abuse protection on top, it does not change how a
 * credential is verified or what a caller can distinguish. In
 * particular: the account lookup still uses the raw, un-normalized
 * `email` exactly as before (normalization here is used ONLY to build
 * rate-limit keys, per this feature's explicit scope); a nonexistent
 * user still short-circuits before bcrypt exactly as before (so bcrypt's
 * cost is paid only for a real account, unchanged timing characteristic
 * from before this feature).
 */
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { normalizeIdentityEmail } from "@/lib/identityEmail";
import { safeConsumeRateLimit, safePeekRateLimitBlocked, safeResetRateLimitBucket } from "./rateLimiter";
import {
  LOGIN_SOURCE_ACCOUNT_SCOPE,
  LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS,
  LOGIN_SOURCE_ACCOUNT_WINDOW_SECONDS,
  LOGIN_SOURCE_FAILURES_SCOPE,
  LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS,
  LOGIN_SOURCE_FAILURES_WINDOW_SECONDS,
} from "./rateLimitScopes";

export type AuthorizedLoginUser = {
  id: string;
  name: string;
  email: string;
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN";
  institutionId: string | null;
};

/**
 * Returns the authorized user on a genuinely valid credential pair, or
 * `null` for every other case — missing input, nonexistent account,
 * wrong password, OR a rate-limited attempt. All of these are
 * deliberately the SAME `null` outcome: a rate-limited attempt must
 * remain externally indistinguishable from an ordinary wrong-password
 * failure (no "too many attempts" / "account locked" response, which
 * would itself become an enumeration or abuse-detection oracle).
 */
export async function attemptCredentialsLogin(params: {
  email: string | undefined;
  password: string | undefined;
  sourceIp: string;
}): Promise<AuthorizedLoginUser | null> {
  const { email, password, sourceIp } = params;
  if (!email || !password) return null;

  // Normalized ONLY for the rate-limit key — the lookup below is
  // intentionally untouched. The limiter must operate identically
  // whether the supplied email exists, doesn't exist, or differs only in
  // case/whitespace, which normalizing the KEY (not the lookup)
  // achieves without changing any existing matching behavior.
  const normalizedEmail = normalizeIdentityEmail(email);
  const accountIdentifier = `${sourceIp}|${normalizedEmail}`;

  // Fast-path: a source already spraying failures across many accounts
  // is rejected before touching this specific account's bucket or
  // running bcrypt at all.
  const sourcePeek = await safePeekRateLimitBlocked({
    scope: LOGIN_SOURCE_FAILURES_SCOPE,
    identifier: sourceIp,
    maxAttempts: LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS,
    windowSeconds: LOGIN_SOURCE_FAILURES_WINDOW_SECONDS,
  });
  if (sourcePeek.blocked) return null;

  // Atomic reserve on the primary (source+account) bucket — the single
  // call that makes "concurrent attempts cannot bypass the limit" a
  // provable guarantee (see consumeRateLimit's own doc comment).
  // Released below on a confirmed successful login; left in place
  // (i.e. counted as a used slot) on any failure.
  const accountGate = await safeConsumeRateLimit({
    scope: LOGIN_SOURCE_ACCOUNT_SCOPE,
    identifier: accountIdentifier,
    maxAttempts: LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS,
    windowSeconds: LOGIN_SOURCE_ACCOUNT_WINDOW_SECONDS,
  });
  if (!accountGate.allowed) return null;

  const user = await prisma.user.findUnique({ where: { email } });
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!user || !valid) {
    // Confirmed failure — only now does the source-wide safety bucket
    // count it. A nonexistent account and a wrong password are
    // deliberately indistinguishable here (both simply "not valid"),
    // matching this function's single `null` return either way.
    await safeConsumeRateLimit({
      scope: LOGIN_SOURCE_FAILURES_SCOPE,
      identifier: sourceIp,
      maxAttempts: LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS,
      windowSeconds: LOGIN_SOURCE_FAILURES_WINDOW_SECONDS,
    });
    return null;
  }

  // Confirmed success — release the reservation on the narrow
  // source+account bucket ONLY. Never touches the source-wide failure
  // bucket (a successful login must never erase failures recorded
  // against OTHER accounts sharing this same source), and never touches
  // any other account's own source+account bucket.
  await safeResetRateLimitBucket({ scope: LOGIN_SOURCE_ACCOUNT_SCOPE, identifier: accountIdentifier });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    institutionId: user.institutionId,
  };
}
