# Auth and Token Abuse Protection v1

Addresses the next P1 gate from the Australian cyber/privacy release
audit: login brute-force/credential-stuffing resistance, password-reset
token abuse resistance, standalone-exam invitation/access-code guessing
resistance, Tether Course invitation/token guessing resistance, and
forgot-password source abuse protection.

**MFA is explicitly out of scope and deferred** — nothing here requires,
implements, or nudges toward a second factor. This is defense-in-depth
around the existing single-factor Credentials flow.

## Architecture

A single generic, durable, PostgreSQL-backed rate limiter
(`src/lib/security/rateLimiter.ts`), backed by one additive table
(`SecurityRateLimitBucket`, migration ledger row 23 — **not applied in
this pass**), shared by every surface below. Never an in-process
Map/counter — Tether runs as stateless, multi-instance Vercel serverless
functions, so only a durable, shared store is a real security boundary.

### Fixed-window counter

A bucket tracks `(scope, keyHash) -> (windowStart, count)`. A request
either falls inside the current window (count compared against the
caller's `maxAttempts`) or the window has fully elapsed (treated as an
entirely fresh window). Deliberately simple — no sliding-window
smoothing.

### Concurrency safety

`consumeRateLimit()` performs its check-then-increment inside one
`prisma.$transaction` guarded by a transaction-scoped Postgres advisory
lock (`pg_advisory_xact_lock`) — the exact same convention already
established by `src/lib/passwordReset.ts`'s per-account cooldown and the
submission-scoped runners (`secureClientRunner.ts`, `aiAssistanceRunner.ts`,
`answerSaveRunner.ts`). This is what makes "concurrent requests cannot
bypass the limit" a provable guarantee: N simultaneous callers for the
same `(scope, keyHash)` serialize through the lock one at a time, so a
bucket's final count after any burst is bounded by `maxAttempts`, never
by N.

### Privacy-preserving key derivation

`src/lib/security/rateLimitKey.ts` derives a dedicated HMAC-SHA256 key
from `AUTH_SECRET` via HKDF, with a context label
(`tether-security-rate-limit-v1`) independent of every other HKDF-derived
key in this codebase (e.g. the LTI identity-link handoff key) — a leak of
one derived key never exposes another, and neither ever exposes
`AUTH_SECRET` itself. HMAC (not plain SHA-256) is deliberate: rate-limit
identifiers are built from predictable inputs (an email, an IP, an
invitation id) — a plain hash of a predictable value is dictionary-
attackable; keying it with a secret the attacker doesn't have makes every
stored `keyHash` opaque. **`AUTH_SECRET` rotation resetting every bucket's
effective identity is an accepted, deliberate tradeoff** — a bucket's
`keyHash` simply changes, so a post-rotation request starts a fresh
window under a new key. Never a raw password, token, access code, email,
or IP address is stored anywhere in this table.

### Client source address

`src/lib/security/clientSource.ts` — the ONE place every limiter gets its
"which caller is this" string from. Trusts `x-forwarded-for` (Vercel's
edge network sets this itself on every request; an ordinary caller cannot
override it), never a client-supplied JSON/query field. Deliberately
isolated in its own module (separate from `src/lib/networkEvidence.ts`'s
own, differently-purposed IP extraction — that module's semantics are
unchanged by this feature) so the trust assumption can be revisited in
one place if Tether ever changes hosting providers.

## Scopes, thresholds, and campus-NAT reasoning

All constants live in `src/lib/security/rateLimitScopes.ts`. Every
threshold is sized for a shared institutional NAT — many legitimate
students can share one public IP, so no control here is a small global
per-IP quota.

| Scope | Key | Max | Window | Notes |
|---|---|---|---|---|
| `auth.login.source_account` | source+normalized-email | 5 | 5 min | Primary control — narrow, one account from one source. |
| `auth.login.source_failures` | source only | 200 | 5 min | Safety net, reserved before verification — see v2 note below. |
| `auth.forgot_password.source` | source only | 30 | 10 min | Layered on top of the existing unchanged per-account 60s cooldown. |
| `auth.reset_password.source` | source only | 30 | 5 min | Only invalid-token outcomes count; reserved before verification. |
| `auth.course_invitation.source_invitation` | source+invitationId | 10 | 5 min | Not a global quota — different invitations from one NAT are independent. |
| `auth.standalone_invite.source_student_exam` | source+studentId+examId | 10 | 5 min | Per-student — see v2 note below. |
| `auth.exam_access_code.source_student_exam` | source+studentId+examId | 10 | 5 min | Per-student — see v2 note below. Separate bucket from the invite-token one above. |

### Security review v2 changes

An independent security review of the first pass found two classes of
defect, fixed as follows:

1. **Concurrent-burst bypass.** Several call sites followed a
   `peek (read-only) → verify secret → consume only on invalid` pattern.
   Peeking is non-atomic, so a burst of concurrent requests could all
   observe "not yet blocked" before any of them committed a later
   consume — the burst could exceed the intended threshold. Fixed by
   replacing every such call site with **reserve/release**:
   `reserveRateLimitSlot()` atomically reserves a slot *before* any
   sensitive verification runs (bcrypt compare, token-hash lookup,
   access-code compare); `safeReleaseRateLimitSlot()` releases *exactly
   one* reservation (never a bulk reset) for outcomes that must not count
   (a correct password, a valid token, a correct access code). The
   read-only `peekRateLimitBlocked` primitive that enabled this pattern
   has been removed entirely. This affected: the login source-wide
   safety bucket, reset-password, course-invitation, standalone-invite,
   and exam-access-code. Forgot-password was already reserve-only
   (consumes unconditionally, first, before any lookup) and needed no
   concurrency change.
2. **Campus-NAT lockout via shared identity.** Standalone-invite and
   exam-access-code were keyed on `source+examId` only, so every student
   behind one shared institutional NAT accessing the same exam shared one
   small bucket — a handful of wrong guesses by any one student could
   lock out the whole room, including a student about to enter the
   correct value. Fixed by adding the **authenticated student's id**
   (always from the verified session, never client-supplied) to both
   scopes' keys, giving each student an independent budget. Course
   invitations needed no change here — `invitationId` is already bound to
   one specific student at creation.

The login source-wide safety bucket's threshold was also raised (50 →
200): under reserve-before-verify, every concurrent attempt — successful
or not — transiently occupies a slot until it resolves and (if
successful) releases, not just permanent failures as before. See
`rateLimitScopes.ts`'s own comment on `LOGIN_SOURCE_FAILURES_MAX_ATTEMPTS`
for the full reasoning, and `loginAttempt.test.ts` for a test proving a
substantial concurrent cohort of legitimate logins is not falsely
rejected. Forgot-password and reset-password thresholds were also raised
(10 → 30) — see their own scope comments.

## Per-surface behavior

### Login (`src/auth.ts`, `src/lib/security/loginAttempt.ts`)

The Credentials `authorize()` logic was extracted into
`attemptCredentialsLogin()` — directly unit-testable without NextAuth's
internal request pipeline, mirroring how `passwordReset.ts` was extracted
from its routes. Flow:

1. Atomic reserve of the source-wide failure bucket (`reserveRateLimitSlot`)
   — BEFORE any lookup/bcrypt work. Blocked or an infrastructure error →
   `null` immediately, no bcrypt.
2. Atomic reserve of the source+account bucket — the call that makes the
   concurrency guarantee provable. Blocked or an infrastructure error →
   `null`, no bcrypt.
3. Existing, unchanged lookup + bcrypt compare. A nonexistent user still
   short-circuits before bcrypt exactly as before this feature (same
   timing characteristic).
4. Failure (no user OR wrong password) → both reservations stay
   consumed → `null`.
5. Success → release exactly ONE slot from EACH bucket (never a bulk
   reset) — this can never erase failures recorded against OTHER
   accounts sharing the source-wide bucket, or concurrent guesses in
   flight against this SAME account from another request.

A rate-limited attempt returns exactly the same `null` NextAuth already
returned for a wrong password — no new "too many attempts"/"account
locked" message, no enumeration signal. `email` is normalized via the
existing `normalizeIdentityEmail` convention **only** for the rate-limit
key — the actual account lookup is untouched.

### Forgot password (`src/lib/passwordReset.ts`)

A source-only bucket is consumed **first** (unconditionally, on every
call — no release, unlike the surfaces below), before any account
lookup — a source that has already sprayed too many requests is rejected
before the function does anything else: no user lookup, no cooldown
check, no token, no email. An `infrastructure_error` from the reservation
is treated identically to "blocked" — same silent no-op. The existing
per-account 60-second cooldown is completely unchanged. The route
(`forgot-password/route.ts`) always returns the same generic 200 response
regardless of which layer (source limiter, limiter infrastructure
failure, per-account cooldown, or genuine success) actually happened.

### Reset password (`src/lib/passwordReset.ts`)

A source-only bucket guards `POST /api/auth/reset-password`, reserved
**atomically before** the token-hash lookup; the reservation is
**released** only when the outcome is genuinely `"ok"` — every invalid
outcome (unknown, expired, consumed token) leaves it consumed. Blocked →
a distinct `429` with `Retry-After` (`{ ok: false, error: "rate_limited"
}`) — safe here specifically because it reveals nothing about whether any
particular token/account exists, only that this source has made too many
bad guesses. An `infrastructure_error` from the reservation returns
`"unavailable"` → the route returns a generic, sanitized `503` **without
ever looking up or verifying the supplied token** — a limiter outage can
never become a token-validity oracle. A genuinely bad token still returns
the existing, unchanged `400 { ok: false, error: "invalid" }`.

### Course invitation (`/api/course-invitations/[invitationId]/[token]` GET and `.../accept` POST)

`src/lib/security/courseInvitationRateLimit.ts` — keyed on
source+invitationId, never a global quota, so many students behind one
NAT using their own different invitations stay independent (no
additional per-student key component is needed — `invitationId` is
already bound to one specific student at creation). Both routes reserve
atomically before doing any invitation lookup (429 + Retry-After if
blocked; a generic `503` on an infrastructure error, without ever looking
up the invitation), and release the reservation for every outcome except
the collapsed `"invalid"` reason (unknown invitation or bad token) —
including `wrong_account`/`already_accepted`/`revoked`/`expired`, which
are existing, legitimate denials this feature does not start counting as
abuse. Token verification, single-use/acceptance semantics, and the
cross-institution race protection are completely unchanged.

### Standalone Exam Link (`/api/exams/[id]/standalone-invite/accept`)

`src/lib/security/standaloneInviteRateLimit.ts` — keyed on
source+**authenticated studentId**+examId (the student id always comes
from `session.user.id`, never request JSON/query). Reserved atomically
before any exam/token lookup (429 + Retry-After if blocked; a generic
`503` on an infrastructure error, without ever verifying the token);
released only on a genuine accept — every `invalidInvite()` outcome
(bad/missing token, exam not published, not STANDALONE, invite disabled)
leaves it consumed. Entitlement/`ExamAssignment` semantics unchanged.

### Exam access code (`/api/exams/[id]/start`)

`src/lib/security/examAccessCodeRateLimit.ts` — keyed on
source+**authenticated studentId**+examId, a **separate** bucket from the
standalone-invite one above (an exam's `accessCode` and its standalone
invite token answer different questions and may both be set on the same
exam — see the schema's own comment). This was the most important
campus-NAT fix in the v2 review pass — see the scopes-table note above.
The change to this route is deliberately the smallest possible: a reserve
immediately inside the existing `if (exam.accessCodeRequired)` block,
before the bcrypt comparison (429 + Retry-After if blocked; a generic
`503` on an infrastructure error, without ever comparing the supplied
code), and a release only in a genuinely correct-code branch, before the
request continues into the rest of exam start. No other line in this
route is touched — every other exam-start concern (secure client,
attestation, time accommodations, question delivery, etc.) is completely
untouched.

## Failure-mode policy

**Security review v2 changed this from fail-open to fail-closed for
enforcement.** The first pass's `safeConsumeRateLimit`/
`safePeekRateLimitBlocked` wrappers failed OPEN on an unexpected
database/infrastructure error — the exact failure mode an earlier session
in this project actually hit (a broken advisory-lock query silently
turned the entire limiter into a no-op). Independent review rejected
that policy for enforcement.

Two distinct categories now exist:

- **Critical enforcement (`reserveRateLimitSlot`)** — fails **CLOSED**.
  On an unexpected DB error it logs a distinct, greppable message and
  returns `infrastructure_error`; every call site treats this as "do not
  proceed with the sensitive verification" and returns its own generic,
  safe response (see each surface's section above — never a raw error,
  never a distinguishable oracle). Login returns the same `null` as an
  ordinary wrong password; forgot-password performs the same silent
  no-op as being source-blocked; reset-password/course-invitation/
  standalone-invite/exam-access-code return a generic sanitized `503`
  without ever touching the secret being verified.
- **Best-effort (`safeReleaseRateLimitSlot`, opportunistic cleanup)** —
  remains fail-open/best-effort, logged but swallowed. A failed release
  only leaves a reservation consumed (strictly MORE conservative, never
  less); a failed cleanup only means a stale bucket persists a bit
  longer. Neither can ever weaken a security boundary, so neither is
  worth turning into an outage.

## Expiry / cleanup

`cleanupExpiredRateLimitBuckets()` deletes a small, bounded batch (200
rows) of buckets whose window closed more than 24 hours ago (comfortably
past every scope's own window above). Deliberately **not** a cron job —
out of scope for this pass, matching the task's explicit instruction. It
is safe to call opportunistically because deleting a stale bucket can
only ever make a future check MORE permissive (a fresh window), never
less — it can never affect authentication/verification correctness.

**Race safety (security review v2 fix):** the delete step re-checks
`windowStart < cutoff` directly in its own `deleteMany` WHERE clause,
not merely "id was in an earlier SELECT's result list" — Postgres
evaluates a DELETE's WHERE clause against each row's current committed
state at execution time, so a bucket a real concurrent request refreshed
in the gap between the SELECT and the DELETE survives instead of being
incorrectly deleted as stale.

**Production wiring (security review v2 fix):** the first pass defined
and tested this function but never actually called it from a real
request path. It is now invoked from `reserveRateLimitSlot` — the single
choke point every enforcement call site already passes through — with
low probability (1-in-500) and always **awaited to completion**, never
fire-and-forget, since a serverless function is not guaranteed to keep
running unawaited work after its response is sent. Any failure here is
caught, logged, and swallowed (see "Failure-mode policy" above).

## Storage cardinality

Row growth for this table is bounded by the combination of: (1)
opportunistic cleanup above, now actually wired into production traffic;
(2) every scope's own `maxAttempts` ceiling — a single source can create
at most `maxAttempts` worth of NEW (scope, identifier) rows per window
before its own bucket(s) start blocking further attempts from that
source; and (3) for the resource-scoped surfaces (course invitation,
standalone invite, exam access code), the resource-identifier component
of the key (`invitationId`/`examId`) is a real, DB-backed entity id, not
an attacker-controlled arbitrary string — an attacker cannot multiply
row count by inventing new identifiers, only by targeting real existing
resources, each of which is itself independently capped by its own
bucket's `maxAttempts`. No additional subsystem (Redis/Upstash, a
separate quota table, etc.) was introduced to bound this further — the
existing per-scope thresholds plus cleanup are sufficient for this
pass's scale.

## Privacy / logging

No password, token, access code, raw email, or raw IP address is ever
logged or persisted by this feature. The only persisted material is an
HMAC-SHA256 `keyHash` (opaque, non-reversible without `AUTH_SECRET`).
Operational logging is limited to rate-limiter infrastructure failures
(see "Failure-mode policy" above) — there is no per-request logging for
ordinary allowed/blocked outcomes.

## Migration

`docs/auth-token-abuse-protection-v1-migration.sql` — one additive table,
no foreign keys, no column added to any existing table. **Not applied in
this pass** — ledger row 23 is recorded as `NOT APPLIED / PENDING
SECURITY REVIEW` and must remain that way until an independent review of
this feature's code diff explicitly authorizes applying it. Row 22
(`PasswordResetToken`) remains already-applied and is untouched by this
row.

## Tests

- `src/lib/security/rateLimiter.test.ts` — core primitive: allow/block
  transitions, window expiry, concurrency (`Promise.all`), reset,
  independence across different scopes/identifiers, plus (security review
  v2) `releaseRateLimitSlot`'s exactly-one/never-underflow/never-erases-
  concurrent-reservations behavior, `reserveRateLimitSlot`'s fail-closed
  `infrastructure_error` path and its opportunistic-cleanup wiring, and
  the cleanup race-condition fix.
- `src/lib/security/rateLimitKey.test.ts` — HMAC opacity (same input →
  same hash; different scope → different hash; not a plain SHA-256 of
  the raw identifier).
- `src/lib/security/loginAttempt.test.ts` — the full login checklist:
  correct/wrong password, source+email limiting, normalization can't
  bypass it, source/email independence, a success releases exactly one
  slot from its own bucket (not a bulk reset), concurrency, no
  enumeration signal, plus (security review v2) a concurrent spray burst
  across many distinct accounts cannot exceed the source-wide threshold,
  a substantial legitimate concurrent login cohort is never falsely
  rejected, and a rate-limiter infrastructure failure fails closed.
- `src/lib/security/examAccessCodeRateLimit.test.ts` — the dedicated
  reserve/release helper (see its own doc comment for why this surface is
  tested at the helper boundary rather than through the large, protected
  exam-start route), including (security review v2) per-student
  independence and concurrency.
- `src/lib/passwordReset.routes.test.ts` (extended) — forgot-password
  source spray protection with the generic response preserved, and
  reset-password source-guessing protection with the existing token
  semantics unchanged, plus (security review v2) a legitimate cohort test
  at the new higher thresholds, a concurrent bogus-token burst, and
  infrastructure-failure fail-closed behavior for both routes.
- `src/lib/courseInvitationAcceptance.routes.test.ts` (extended) —
  invitation-scoped guessing protection and campus-NAT independence
  across different invitations, plus (security review v2) a concurrent
  invalid-guess burst.
- `src/lib/standaloneExamLink.routes.test.ts` (extended) — invite-token
  guessing protection and independence across different exams, plus
  (security review v2) per-student independence on the SAME exam+source
  and a concurrent invalid-guess burst by one student.
