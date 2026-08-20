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
| `auth.login.source_failures` | source only | 50 | 5 min | Safety net — **only failures count**; successful logins never touch it. |
| `auth.forgot_password.source` | source only | 10 | 10 min | Layered on top of the existing unchanged per-account 60s cooldown. |
| `auth.reset_password.source` | source only | 10 | 5 min | Only invalid-token outcomes count. |
| `auth.course_invitation.source_invitation` | source+invitationId | 10 | 5 min | Not a global quota — different invitations from one NAT are independent. |
| `auth.standalone_invite.source_exam` | source+examId | 10 | 5 min | Same NAT reasoning, keyed on exam instead of invitation. |
| `auth.exam_access_code.source_exam` | source+examId | 10 | 5 min | Separate bucket from the invite-token one above, same key shape. |

## Per-surface behavior

### Login (`src/auth.ts`, `src/lib/security/loginAttempt.ts`)

The Credentials `authorize()` logic was extracted into
`attemptCredentialsLogin()` — directly unit-testable without NextAuth's
internal request pipeline, mirroring how `passwordReset.ts` was extracted
from its routes. Flow:

1. Fast-path: read-only peek of the source-wide failure bucket. Blocked →
   `null` immediately, no bcrypt.
2. Atomic reserve of the source+account bucket (`consumeRateLimit`) —
   this single call is what makes the concurrency guarantee provable.
   Blocked → `null`, no bcrypt.
3. Existing, unchanged lookup + bcrypt compare. A nonexistent user still
   short-circuits before bcrypt exactly as before this feature (same
   timing characteristic).
4. Failure (no user OR wrong password) → consume the source-wide bucket
   (this is the ONLY place that bucket is ever incremented) → `null`.
5. Success → reset (clear) the source+account bucket only — never the
   source-wide bucket, and never any other account's own bucket sharing
   the same source.

A rate-limited attempt returns exactly the same `null` NextAuth already
returned for a wrong password — no new "too many attempts"/"account
locked" message, no enumeration signal. `email` is normalized via the
existing `normalizeIdentityEmail` convention **only** for the rate-limit
key — the actual account lookup is untouched.

### Forgot password (`src/lib/passwordReset.ts`)

A source-only bucket is consumed **first**, before any account lookup —
a source that has already sprayed too many requests is rejected before
the function does anything else: no user lookup, no cooldown check, no
token, no email. The existing per-account 60-second cooldown is
completely unchanged. The route (`forgot-password/route.ts`) always
returns the same generic 200 response regardless of which layer (source
limiter, per-account cooldown, or genuine success) actually happened.

### Reset password (`src/lib/passwordReset.ts`)

A source-only bucket guards `POST /api/auth/reset-password`. A cheap
read-only peek runs before the token-hash lookup; the bucket is only
**consumed** when the outcome is genuinely `"invalid"` (unknown, expired,
consumed, or now rate-limited-and-rejected token) — a valid reset never
counts against it. Unlike login/forgot-password, this surface DOES
surface a distinct `429` with `Retry-After` when source-rate-limited
(`{ ok: false, error: "rate_limited" }`) — safe here specifically because
it reveals nothing about whether any particular token/account exists,
only that this source has made too many bad guesses. A genuinely bad
token still returns the existing, unchanged `400 { ok: false, error:
"invalid" }` — the two remain indistinguishable from each other in every
way except the rate-limit case, which is about the caller's own traffic,
not any target's existence.

### Course invitation (`/api/course-invitations/[invitationId]/[token]` GET and `.../accept` POST)

`src/lib/security/courseInvitationRateLimit.ts` — keyed on
source+invitationId, never a global quota, so many students behind one
NAT using their own different invitations stay independent. Both routes
peek before doing any invitation lookup (429 + Retry-After if blocked),
and record an invalid guess only when the outcome is the collapsed
`"invalid"` reason (unknown invitation or bad token) — never for
`wrong_account`/`already_accepted`/`revoked`/`expired`, which aren't
secret-guessing outcomes. Token verification, single-use/acceptance
semantics, and the cross-institution race protection are completely
unchanged.

### Standalone Exam Link (`/api/exams/[id]/standalone-invite/accept`)

`src/lib/security/standaloneInviteRateLimit.ts` — keyed on
source+examId. Peeked before any exam/token lookup; recorded on every
`invalidInvite()` outcome (bad/missing token, exam not published, not
STANDALONE, invite disabled). Entitlement/`ExamAssignment` semantics
unchanged.

### Exam access code (`/api/exams/[id]/start`)

`src/lib/security/examAccessCodeRateLimit.ts` — keyed on source+examId,
a **separate** bucket from the standalone-invite one above (an exam's
`accessCode` and its standalone invite token answer different questions
and may both be set on the same exam — see the schema's own comment).
The change to this route is deliberately the smallest possible: a peek
immediately inside the existing `if (exam.accessCodeRequired)` block
(429 + Retry-After if already blocked), and a single recorded guess only
in the existing `if (!valid)` branch. No other line in this route is
touched — every other exam-start concern (secure client, attestation,
time accommodations, question delivery, etc.) is completely untouched.

## Failure-mode policy

Every enforcement call site uses the `safe*` wrappers in
`rateLimiter.ts`, which **fail open with a distinct, greppable log line**
on an unexpected database/infrastructure error — never silently
swallowed, never pretending the check ran and passed without a trace.
This is a deliberate availability-over-defense-in-depth tradeoff for this
one supplementary control: the actual security boundary for every
surface it guards (bcrypt comparison, token-hash comparison, access-code
comparison) is completely independent of this table, so a transient
failure here must never turn into a platform-wide authentication/reset/
invitation/exam-start outage layered on top of whatever infrastructure
problem already exists. Cleanup failures (`safeResetRateLimitBucket`) are
logged with a distinctly-worded, explicitly non-fatal message — a failed
reset simply means that bucket expires naturally on its own window
instead of being cleared early; it can never leave a caller more blocked
than before.

## Expiry / cleanup

`cleanupExpiredRateLimitBuckets()` deletes a small, bounded batch (200
rows) of buckets whose window closed more than 24 hours ago (comfortably
past every scope's own window above). Deliberately **not** a cron job —
out of scope for this pass, matching the task's explicit instruction. It
is safe to call opportunistically because deleting a stale bucket can
only ever make a future check MORE permissive (a fresh window), never
less — it can never affect authentication/verification correctness. Not
wired into any automatic trigger in this pass; calling it is a deliberate
operator action, consistent with this codebase's existing
`npm run evidence:retention` precedent for opportunistic, non-cron
cleanup.

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
  independence across different scopes/identifiers.
- `src/lib/security/rateLimitKey.test.ts` — HMAC opacity (same input →
  same hash; different scope → different hash; not a plain SHA-256 of
  the raw identifier).
- `src/lib/security/loginAttempt.test.ts` — the full login checklist:
  correct/wrong password, source+email limiting, normalization can't
  bypass it, source/email independence, success resets only its own
  bucket, concurrency, no enumeration signal.
- `src/lib/passwordReset.routes.test.ts` (extended) — forgot-password
  source spray protection with the generic response preserved, and
  reset-password source-guessing protection with the existing token
  semantics unchanged.
- `src/lib/courseInvitationAcceptance.routes.test.ts` (extended) —
  invitation-scoped guessing protection and campus-NAT independence
  across different invitations.
- `src/lib/standaloneExamLink.routes.test.ts` (extended) — invite-token
  guessing protection and independence across different exams.
- A focused addition to the exam-start route's own test coverage for the
  access-code guessing protection.
