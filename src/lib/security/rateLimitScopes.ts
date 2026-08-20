/**
 * Auth and Token Abuse Protection v1 - see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * Every rate-limit scope name and its exact threshold/window in one
 * place, so the actual numbers a security review needs to check are
 * never scattered across route files. Every threshold is deliberately
 * conservative for a shared institutional NAT/campus network - see each
 * constant's own comment for the specific reasoning.
 *
 * Security review v2: several thresholds and identities below changed
 * from the first pass - see each constant's comment for why.
 */

// -- Login (Credentials authorize()) -----------------------------------------

/**
 * Primary control: source + normalized-account identifier. Limits
 * repeated password guesses against ONE account from ONE source. Small
 * on purpose - this is the narrow, account-specific budget, not the
 * campus-wide one. Reserved atomically before bcrypt; released (exactly
 * one slot) only on a confirmed correct password for that exact request.
 */
export const LOGIN_SOURCE_ACCOUNT_SCOPE = "auth.login.source_account";
export const LOGIN_SOURCE_ACCOUNT_MAX_ATTEMPTS = 5;
export const LOGIN_SOURCE_ACCOUNT_WINDOW_SECONDS = 5 * 60; // 5 minutes

/**
 * Safety-net control: source-wide FAILED-login count, across every
 * account attempted from that source. Only confirmed authentication
 * FAILURES leave a reservation permanently consumed; a confirmed success
 * releases exactly its own one reservation (see loginAttempt.ts).
 *
 * Security review v2: this bucket is now reserved ATOMICALLY BEFORE
 * credential verification runs (closing the concurrent-burst bypass the
 * old peek-then-consume-on-failure pattern allowed), which means EVERY
 * concurrent attempt - successful or not - transiently occupies one slot
 * for the few milliseconds between reservation and its bcrypt-driven
 * resolution, not just permanent failures. The threshold must therefore
 * comfortably exceed the largest realistic concurrent BURST of
 * simultaneous login attempts behind one shared institutional NAT (e.g.
 * a large lecture hall or exam cohort all opening the login page within
 * the same second), not merely the total failure volume across a whole
 * five-minute window. 200 provides wide headroom above any plausible
 * concurrent legitimate burst (low hundreds at most, each resolving and
 * releasing within a bcrypt-compare's worth of milliseconds) while
 * remaining far below what a real distributed credential-stuffing
 * campaign needs to be effective - especially since the per-account
 * bucket above still caps any single account at 5 guesses regardless.
 */
export const LOGIN_SOURCE_FAILURES_SCOPE = "auth.login.source_failures";
export const LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS = 200;
export const LOGIN_SOURCE_FAILURES_WINDOW_SECONDS = 5 * 60; // 5 minutes

// -- Forgot password ----------------------------------------------------------

/**
 * Source-level spray protection - separate from, and layered on top of,
 * the existing PER-ACCOUNT 60-second cooldown
 * (PASSWORD_RESET_REQUEST_COOLDOWN_MS in src/lib/passwordResetToken.ts,
 * unchanged by this feature). This bucket exists to stop one caller from
 * requesting resets across MANY different accounts in a short window
 * (email-bombing / account-existence probing at scale), which the
 * per-account cooldown alone cannot do. Every call consumes this bucket
 * regardless of outcome (there is no "release" for it) - that is what
 * stops probing across many different, possibly nonexistent, accounts.
 *
 * Security review v2: raised from 10 to 30 per 10 minutes - 10 was too
 * easily exhausted by a legitimate cohort (e.g. a shared computer lab or
 * dorm during onboarding week, where a couple dozen students genuinely
 * forget their password within the same 10-minute span). 30 remains well
 * below what an automated spray needs to probe a meaningful number of
 * distinct accounts, while comfortably covering realistic legitimate
 * concurrent institutional demand.
 */
export const FORGOT_PASSWORD_SOURCE_SCOPE = "auth.forgot_password.source";
export const FORGOT_PASSWORD_SOURCE_MAX_ATTEMPTS = 30;
export const FORGOT_PASSWORD_SOURCE_WINDOW_SECONDS = 10 * 60; // 10 minutes

// -- Reset password (token guessing) -----------------------------------------

/**
 * Source-level protection against high-volume bogus-token submission to
 * POST /api/auth/reset-password. The token itself is already 256-bit
 * entropy and hash-only in storage (unchanged by this feature) - this
 * bucket is defense-in-depth against automated guessing volume/resource
 * abuse, not a redesign of token security. Reserved atomically before the
 * token-hash lookup; only INVALID outcomes leave the reservation
 * consumed - a genuinely valid reset releases its own one reservation.
 *
 * Security review v2: raised from 10 to 30 per 5 minutes. This bucket is
 * source-wide (necessarily - a bogus token carries no account identity to
 * key on more narrowly), so a low threshold risked one person's bad
 * guesses trivially locking password reset for an ENTIRE shared
 * institutional NAT for the whole window. 30 keeps automated bogus-token
 * volume meaningfully capped while making that campus-wide lockout far
 * less likely from ordinary human error.
 */
export const RESET_PASSWORD_SOURCE_SCOPE = "auth.reset_password.source";
export const RESET_PASSWORD_SOURCE_MAX_ATTEMPTS = 30;
export const RESET_PASSWORD_SOURCE_WINDOW_SECONDS = 5 * 60; // 5 minutes

// -- Course invitation token guessing ----------------------------------------

/**
 * Context: source + invitationId - NOT a small global IP quota. This
 * lets many students behind the same institutional NAT keep using their
 * own, DIFFERENT, legitimate invitations without affecting each other,
 * while still stopping repeated guessing against any ONE invitation's
 * token from one source. Covers both the read-only preview (GET) and
 * the accepting POST - both verify the same token against the same
 * invitation. Reserved atomically before invitation/token lookup;
 * released (exactly one slot) for every outcome except a genuinely
 * invalid invitation/token (see courseInvitationRateLimit.ts).
 *
 * No studentId component is needed here (unlike standalone-invite and
 * exam-access-code below): invitationId already uniquely identifies one
 * specific student's own invitation (CourseEnrollmentInvitation.studentId
 * is fixed at creation), so this bucket can never be shared across two
 * different students' guessing in the first place.
 */
export const COURSE_INVITATION_SOURCE_SCOPE = "auth.course_invitation.source_invitation";
export const COURSE_INVITATION_SOURCE_MAX_ATTEMPTS = 10;
export const COURSE_INVITATION_SOURCE_WINDOW_SECONDS = 5 * 60; // 5 minutes

// -- Standalone Exam Link - invitation token ---------------------------------

/**
 * Context: source + authenticated studentId - deliberately NOT
 * + examId. Reserved atomically BEFORE the exam lookup even happens;
 * released (exactly one slot, via its own window identity) only on a
 * genuinely valid, accepted invite.
 *
 * Security review v2: the first pass keyed this on source + examId only,
 * which meant every student behind one campus NAT accessing the SAME
 * standalone exam shared one small bucket - ten wrong-token attempts by
 * any one student could lock out every other student on that network for
 * the same exam. Adding the authenticated student's own id (always taken
 * from the verified session, never from request JSON/query) gave each
 * student their own independent budget for a given exam.
 *
 * Security review v4: dropping examId from the key entirely (v2 still
 * included it) fixes two more defects that keying on source+studentId+
 * examId left behind:
 *   1. Information oracle - reserving only AFTER confirming the exam id
 *      was real and eligible meant a nonexistent/ineligible exam id
 *      never rate-limited (always the same invalid_invite, forever),
 *      while a real eligible exam's wrong-token guesses eventually
 *      surfaced 429 - letting a caller distinguish "this id is a real
 *      standalone exam" from "it isn't" purely by whether rate limiting
 *      ever kicks in, without needing the actual token.
 *   2. Unbounded DB lookups - arbitrary/nonexistent exam ids could still
 *      trigger unlimited exam lookups, never touching the rate limiter at
 *      all.
 * Keying on source+studentId ONLY, reserved before the exam lookup, means
 * every request from a given student+source - real exam, wrong token,
 * nonexistent exam, ineligible exam - draws from the exact same budget
 * and returns the identical invalid_invite response up to the threshold,
 * then the identical 429 after it, regardless of whether the requested
 * exam id was ever real. The tradeoff (one student's guessing against
 * ONE exam now also constrains their own attempts against a DIFFERENT
 * exam from the same source) is intentional and necessary to close the
 * oracle; it does not affect a DIFFERENT student's budget, so campus-NAT
 * independence between students is preserved.
 */
export const STANDALONE_INVITE_SOURCE_SCOPE = "auth.standalone_invite.source_student";
export const STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS = 10;
export const STANDALONE_INVITE_SOURCE_WINDOW_SECONDS = 5 * 60; // 5 minutes

// -- Exam access code (POST /api/exams/[id]/start) ---------------------------

/**
 * Context: source + authenticated studentId + examId. A separate scope
 * from the standalone-invite token bucket above (see
 * prisma/schema.prisma's Exam model comment - accessCode and the
 * standalone invite token answer different questions and may both be set
 * on the same exam), even though both now key on the same
 * (source, studentId, examId) shape.
 *
 * Security review v2: this was the most important campus-NAT fix in this
 * pass. The first pass keyed this on source + examId only: ten wrong
 * access-code entries across DIFFERENT students behind one shared exam-
 * room NAT could lock out the entire room, including a student who was
 * about to enter the CORRECT code. Keying on the authenticated student's
 * own id (from the verified session only, never client-supplied) means
 * one student exhausting their own guesses never affects any other
 * student's ability to start the same exam from the same network.
 * Reserved atomically before the bcrypt access-code comparison; released
 * (exactly one slot) only on a genuinely correct code, before the
 * request continues into the rest of exam start.
 */
export const EXAM_ACCESS_CODE_SOURCE_SCOPE = "auth.exam_access_code.source_student_exam";
export const EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS = 10;
export const EXAM_ACCESS_CODE_SOURCE_WINDOW_SECONDS = 5 * 60; // 5 minutes

// -- Opportunistic cleanup -----------------------------------------------------

/**
 * A bucket whose window closed this long ago is retained no longer than
 * necessary - see cleanupExpiredRateLimitBuckets in rateLimiter.ts, now
 * wired into every real enforcement call via reserveRateLimitSlot. Wide
 * margin past the largest window above purely so cleanup never races a
 * bucket that's still operationally relevant.
 */
export const RATE_LIMIT_BUCKET_STALE_AFTER_SECONDS = 24 * 60 * 60; // 24 hours
