/**
 * Password Reset v1 — see docs/password-reset-v1.md.
 *
 * Business logic behind POST /api/auth/forgot-password and POST
 * /api/auth/reset-password, kept out of the route handlers themselves
 * (same convention as src/lib/lti/identityCollision.ts) so it is directly
 * unit-testable and the routes stay thin translation layers.
 *
 * One flow for every credential-based Tether user — STUDENT and LECTURER
 * alike; nothing here branches on role.
 */
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { normalizeIdentityEmail } from "@/lib/identityEmail";
import { resolveTrustedExternalOrigin } from "@/lib/appOrigin";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { sendPasswordResetEmail } from "@/lib/mail/sendPasswordResetEmail";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  buildPasswordResetUrl,
  PASSWORD_RESET_TOKEN_TTL_MS,
  PASSWORD_RESET_REQUEST_COOLDOWN_MS,
} from "@/lib/passwordResetToken";
import { reserveRateLimitSlot, safeReleaseRateLimitSlot } from "@/lib/security/rateLimiter";
import {
  FORGOT_PASSWORD_SOURCE_SCOPE,
  FORGOT_PASSWORD_SOURCE_MAX_ATTEMPTS,
  FORGOT_PASSWORD_SOURCE_WINDOW_SECONDS,
  RESET_PASSWORD_SOURCE_SCOPE,
  RESET_PASSWORD_SOURCE_MAX_ATTEMPTS,
  RESET_PASSWORD_SOURCE_WINDOW_SECONDS,
} from "@/lib/security/rateLimitScopes";

/**
 * Always resolves (never rejects) — every branch below (no such account,
 * per-account cooldown, missing trusted origin, provider send failure) is
 * a silent no-op from the caller's point of view. The API route therefore
 * always returns the exact same generic public response regardless of
 * what happened here; this function's return value deliberately carries
 * no information a route could use to make the response distinguishable.
 *
 * Concurrency-safe cooldown (correctness pass — independent review found
 * the original `findFirst` -> `create` sequence raced: two simultaneous
 * requests for the same user could both observe no recent token and both
 * issue one). The cooldown re-check and the token INSERT now happen
 * inside one transaction guarded by a transaction-scoped Postgres
 * advisory lock keyed on the user id (`pg_advisory_xact_lock(hashtext(...))`,
 * released automatically at commit/rollback) — the same convention
 * already used for submission-scoped locks in
 * src/lib/secureClientRunner.ts, src/lib/aiAssistanceRunner.ts, and
 * src/lib/answerSaveRunner.ts. Two concurrent requests for the same user
 * serialize on this lock; the second to acquire it re-reads the cooldown
 * and correctly sees the first request's now-committed token, so at most
 * one token/email is ever issued per cooldown window. Two requests for
 * DIFFERENT users hash to different lock keys (for all practical
 * purposes — a `hashtext()` collision is astronomically unlikely and, if
 * it ever happened, would only cost the two an unnecessary brief wait,
 * never an incorrect result) and are not serialized against each other.
 *
 * Order of operations: the token row is created BEFORE the email is
 * sent — a reset link must never be mailed before its own DB row exists
 * to validate against. Email delivery deliberately happens OUTSIDE the
 * transaction (and therefore after the advisory lock has already been
 * released at commit) — a call to an external provider must never hold a
 * database transaction/connection open. If the send then fails, the
 * just-created row is deleted on a best-effort basis so a real,
 * correctly-hashed token is not left silently undeliverable in the
 * database (an orphaned token nobody received but that would still work
 * if somehow guessed — astronomically unlikely given its entropy, but
 * avoided anyway "if practical" per the product spec). The email send and
 * the compensating delete are not, and cannot be, one atomic transaction
 * with each other (the send is a network call to an external provider) —
 * this is a best-effort cleanup, not a correctness guarantee the way the
 * token table's own consumedAt handling is.
 *
 * Auth and Token Abuse Protection v1 — a source-level bucket (keyed on
 * `sourceIp` alone, independent of any account) is consumed FIRST, before
 * any account lookup — a source that has already sprayed too many
 * forgot-password requests (regardless of which emails, real or fake,
 * it targeted) is rejected before this function does anything else: no
 * user lookup, no per-user cooldown check, no token, no email. This is
 * layered on top of, and does not replace or weaken, the existing
 * per-account 60-second cooldown below. Deliberately a plain "consume,
 * never release" bucket (unlike the login limiter) — every call from a
 * source counts toward its spray budget regardless of outcome, which is
 * exactly what stops one caller from probing/emailing many different
 * accounts.
 *
 * Security review v2: a rate-limiter infrastructure failure while
 * reserving this bucket (`infrastructure_error`) is treated exactly like
 * "blocked" — a silent no-op, no token, no email. This route's caller
 * (POST /api/auth/forgot-password) always returns the identical generic
 * 200 response regardless of what happened here, so this fail-closed
 * choice is invisible externally and never becomes a token/account
 * existence oracle.
 */
export async function requestPasswordReset(rawEmail: string, sourceIp: string): Promise<void> {
  const sourceReservation = await reserveRateLimitSlot({
    scope: FORGOT_PASSWORD_SOURCE_SCOPE,
    identifier: sourceIp,
    maxAttempts: FORGOT_PASSWORD_SOURCE_MAX_ATTEMPTS,
    windowSeconds: FORGOT_PASSWORD_SOURCE_WINDOW_SECONDS,
  });
  if (sourceReservation.status !== "reserved") return; // source-limited or limiter unavailable — silent no-op; caller still returns the generic response

  const email = normalizeIdentityEmail(rawEmail);

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) return;

  const origin = resolveTrustedExternalOrigin();
  if (!origin) {
    console.error("Password reset: no trusted app origin available (APP_URL and VERCEL_URL both missing)");
    return;
  }

  const claim = await prisma.$transaction(async (tx) => {
    // MUST be the first statement in this transaction — see the runners
    // referenced above for why the lock only serializes concurrent
    // writers when held for the duration of a real transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;

    // Bounded per-account throttle — no DB row is ever created for an
    // email that doesn't correspond to a real account (see the early
    // return above), so this only ever runs for a genuine existing user.
    // Deliberately a DB-backed check (a recent PasswordResetToken row),
    // not an in-memory counter — this app runs as stateless Vercel
    // serverless functions with no shared in-process memory across
    // invocations, so an in-memory rate limiter would not actually bound
    // anything in production.
    const recent = await tx.passwordResetToken.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - PASSWORD_RESET_REQUEST_COOLDOWN_MS) } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (recent) return null;

    const plaintextToken = generatePasswordResetToken();
    const tokenRow = await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken(plaintextToken),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
      },
      select: { id: true },
    });

    return { tokenId: tokenRow.id, plaintextToken };
  });

  if (!claim) return; // cooldown active — silent no-op, same generic response

  const resetUrl = buildPasswordResetUrl(origin, claim.plaintextToken);

  try {
    await sendPasswordResetEmail({ to: user.email, resetUrl });
  } catch (err) {
    // Sanitized, operational-only log — never the token, the URL
    // containing it, or the provider's raw response body.
    console.error(
      "Password reset: failed to send reset email",
      err instanceof Error ? err.message : "unknown send error",
    );
    await prisma.passwordResetToken.delete({ where: { id: claim.tokenId } }).catch(() => {});
  }
}

export type ResetPasswordOutcome = "ok" | "invalid" | "rate_limited" | "unavailable";
export type ResetPasswordResult = { outcome: ResetPasswordOutcome; retryAfterSeconds?: number };

/**
 * Concurrency-safe by construction: the only write that can flip a
 * token's `consumedAt` from null is a conditional `updateMany` guarded on
 * `consumedAt: null` AND `expiresAt` still in the future. Two simultaneous
 * calls with the same token both read a not-yet-consumed row, but only
 * one `updateMany` call can actually match (Postgres serializes the two
 * UPDATEs); the loser sees `count !== 1` and returns "invalid" without
 * ever touching `User.passwordHash`. The password update, the winning
 * token's consumption, and invalidating every other outstanding token for
 * the same user all happen inside that one transaction, so a reader can
 * never observe a state where the password changed but an old token is
 * still usable (or vice versa).
 *
 * Correctness pass — independent review: expiry must be enforced at THIS
 * atomic write, not only by the fast pre-check below. bcrypt hashing the
 * new password (deliberately slow — see the cost factor below) takes
 * long enough that a token could legitimately expire in the gap between
 * the pre-check and this transaction; without an `expiresAt` condition
 * here too, that race would let an expired token still successfully
 * reset a password. The pre-check is kept only as a cheap fast path (skip
 * the bcrypt cost entirely for an obviously-expired token) — it is never
 * the sole enforcement. `now` is captured once, immediately before the
 * transaction, and reused for both the WHERE comparison and the
 * `consumedAt`/other-tokens write below, so every write in this
 * transaction agrees on exactly the same instant.
 *
 * Auth and Token Abuse Protection v1 — a source-level bucket (keyed on
 * `sourceIp` alone) guards against high-volume bogus-token submission.
 * Reserved ATOMICALLY before the token-hash lookup below (security review
 * v2 — the first pass used a non-atomic peek here, which a concurrent
 * burst of bogus-token requests could bypass; see rateLimiter.ts's module
 * doc comment). A genuinely valid reset releases its own one reservation;
 * an invalid outcome leaves it consumed. Distinct from "invalid": the
 * route surfaces exhaustion as a conventional 429 with Retry-After, which
 * is safe here specifically because it reveals nothing about whether any
 * particular token/account exists — only that this source has made too
 * many bad guesses.
 *
 * Security review v2 — failure mode: if reserving this bucket reports
 * `infrastructure_error`, this function fails CLOSED — returns
 * "unavailable" WITHOUT ever calling resetPasswordWithTokenCore. The
 * supplied token is never looked up or verified in this case, so a
 * limiter outage can never become a token-validity oracle; the route
 * surfaces this as a generic, sanitized 503.
 */
export async function resetPasswordWithToken(
  rawToken: string,
  newPassword: string,
  sourceIp: string,
): Promise<ResetPasswordResult> {
  const sourceReservation = await reserveRateLimitSlot({
    scope: RESET_PASSWORD_SOURCE_SCOPE,
    identifier: sourceIp,
    maxAttempts: RESET_PASSWORD_SOURCE_MAX_ATTEMPTS,
    windowSeconds: RESET_PASSWORD_SOURCE_WINDOW_SECONDS,
  });
  if (sourceReservation.status === "blocked") {
    return { outcome: "rate_limited", retryAfterSeconds: sourceReservation.retryAfterSeconds };
  }
  if (sourceReservation.status === "infrastructure_error") {
    return { outcome: "unavailable" };
  }

  const result = await resetPasswordWithTokenCore(rawToken, newPassword);

  if (result === "ok") {
    await safeReleaseRateLimitSlot({
      scope: RESET_PASSWORD_SOURCE_SCOPE,
      identifier: sourceIp,
      windowStartMs: sourceReservation.windowStartMs,
    });
  }

  return { outcome: result };
}

async function resetPasswordWithTokenCore(rawToken: string, newPassword: string): Promise<"ok" | "invalid"> {
  const tokenHash = hashPasswordResetToken(rawToken);
  const tokenRow = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!tokenRow) return "invalid";
  if (tokenRow.consumedAt) return "invalid";
  if (tokenRow.expiresAt.getTime() <= Date.now()) return "invalid";

  const passwordHash = await bcrypt.hash(newPassword, 12);
  const now = new Date();

  const outcome = await prisma.$transaction(async (tx) => {
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: tokenRow.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return "invalid" as const;

    await tx.user.update({ where: { id: tokenRow.userId }, data: { passwordHash } });

    // One successful reset invalidates every OTHER outstanding token for
    // this user too — an old, unused reset email can never be used after
    // this point.
    await tx.passwordResetToken.updateMany({
      where: { userId: tokenRow.userId, consumedAt: null },
      data: { consumedAt: now },
    });

    return "ok" as const;
  });

  if (outcome === "ok") {
    // Minimal, non-secret audit event — actor is the reset user
    // themselves (same "self as actor" convention as self-service
    // lecturer workspace creation in src/app/api/signup/route.ts). Never
    // blocks or fails the reset itself.
    await createPlatformAuditLog({
      actorId: tokenRow.userId,
      action: "auth.password_reset_completed",
      targetType: "User",
      targetId: tokenRow.userId,
    }).catch(() => {});
  }

  return outcome;
}
