/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Every rate-limit scope name and its exact threshold/window in one
 * place, so the actual numbers a security review needs to check are
 * never scattered across route files. Every threshold is deliberately
 * conservative for a shared institutional NAT/campus network — see each
 * constant's own comment for the specific reasoning.
 */

// ── Login (Credentials authorize()) ─────────────────────────────────────────

/**
 * Primary control: source + normalized-account identifier. Limits
 * repeated password guesses against ONE account from ONE source. Small
 * on purpose — this is the narrow, account-specific budget, not the
 * campus-wide one.
 */
export const LOGIN_SOURCE_ACCOUNT_SCOPE = "auth.login.source_account";
export const LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS = 5;
export const LOGIN_SOURCE_ACCOUNT_WINDOW_SECONDS = 5 * 60; // 5 minutes

/**
 * Safety-net control: source-wide FAILED-login count, across every
 * account attempted from that source. Deliberately much higher than the
 * per-account budget above — a large shared university NAT can easily
 * produce dozens of genuine password typos in a five-minute span during
 * an exam's start window; this threshold exists to catch sustained
 * automated spraying across many accounts, not ordinary human error.
 * Only confirmed authentication FAILURES ever increment this bucket —
 * see src/auth.ts for why a successful login never touches it.
 */
export const LOGIN_SOURCE_FAILURES_SCOPE = "auth.login.source_failures";
export const LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS = 50;
export const LOGIN_SOURCE_FAILURES_WINDOW_SECONDS = 5 * 60; // 5 minutes

// ── Forgot password ──────────────────────────────────────────────────────────

/**
 * Source-level spray protection — separate from, and layered on top of,
 * the existing PER-ACCOUNT 60-second cooldown
 * (PASSWORD_RESET_REQUEST_COOLDOWN_MS in src/lib/passwordResetToken.ts,
 * unchanged by this feature). This bucket exists to stop one caller from
 * requesting resets across MANY different accounts in a short window
 * (email-bombing / account-existence probing at scale), which the
 * per-account cooldown alone cannot do.
 */
export const FORGOT_PASSWORD_SOURCE_SCOPE = "auth.forgot_password.source";
export const FORGOT_PASSWORD_SOURCE_MAX_ATTEMPTS = 10;
export const FORGOT_PASSWORD_SOURCE_WINDOW_SECONDS = 10 * 60; // 10 minutes

// ── Reset password (token guessing) ─────────────────────────────────────────

/**
 * Source-level protection against high-volume bogus-token submission to
 * POST /api/auth/reset-password. The token itself is already 256-bit
 * entropy and hash-only in storage (unchanged by this feature) — this
 * bucket is defense-in-depth against automated guessing volume/resource
 * abuse, not a redesign of token security. Only INVALID outcomes
 * increment this bucket — a genuinely valid reset never does.
 */
export const RESET_PASSWORD_SOURCE_SCOPE = "auth.reset_password.source";
export const RESET_PASSWORD_SOURCE_MAX_ATTEMPTS = 10;
export const RESET_PASSWORD_SOURCE_WINDOW_SECONDS = 5 * 60; // 5 minutes

// ── Course invitation token guessing ────────────────────────────────────────

/**
 * Context: source + invitationId — NOT a small global IP quota. This
 * lets many students behind the same institutional NAT keep using their
 * own, DIFFERENT, legitimate invitations without affecting each other,
 * while still stopping repeated guessing against any ONE invitation's
 * token from one source. Covers both the read-only preview (GET) and
 * the accepting POST — both verify the same token against the same
 * invitation.
 */
export const COURSE_INVITATION_SOURCE_SCOPE = "auth.course_invitation.source_invitation";
export const COURSE_INVITATION_SOURCE_MAX_ATTEMPTS = 10;
export const COURSE_INVITATION_SOURCE_WINDOW_SECONDS = 5 * 60; // 5 minutes

// ── Standalone Exam Link — invitation token ─────────────────────────────────

/**
 * Context: source + examId. Same campus-NAT reasoning as course
 * invitations above — many students behind one NAT using different
 * exams' standalone links must not affect each other.
 */
export const STANDALONE_INVITE_SOURCE_SCOPE = "auth.standalone_invite.source_exam";
export const STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS = 10;
export const STANDALONE_INVITE_SOURCE_WINDOW_SECONDS = 5 * 60; // 5 minutes

// ── Exam access code (POST /api/exams/[id]/start) ───────────────────────────

/**
 * Context: source + examId. A separate scope/bucket from the standalone
 * invite token above (see prisma/schema.prisma's Exam model comment —
 * accessCode and the standalone invite token answer different
 * questions and may both be set on the same exam), even though both
 * happen to key on the same (source, examId) shape.
 */
export const EXAM_ACCESS_CODE_SOURCE_SCOPE = "auth.exam_access_code.source_exam";
export const EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS = 10;
export const EXAM_ACCESS_CODE_SOURCE_WINDOW_SECONDS = 5 * 60; // 5 minutes

// ── Opportunistic cleanup ────────────────────────────────────────────────────

/**
 * A bucket whose window closed this long ago is retained no longer than
 * necessary — see cleanupExpiredRateLimitBuckets in rateLimiter.ts. Wide
 * margin past the largest window above purely so cleanup never races a
 * bucket that's still operationally relevant.
 */
export const RATE_LIMIT_BUCKET_STALE_AFTER_SECONDS = 24 * 60 * 60; // 24 hours
