# Password Reset v1

Self-service "Forgot password / Reset password" for every credential-based
Tether user — STUDENT and LECTURER alike. One flow, no role branching
anywhere in this feature. Does not touch Canvas/LTI, `apps/lockdown`,
secure-exam/integrity behavior, submissions, exam access, course
invitations, Standalone Exam Link, or Controlled AI.

## Flow

1. `GET /forgot-password` — user enters their email.
2. `POST /api/auth/forgot-password` — looks up the account (normalized
   email), and if found and not rate-limited, creates a
   `PasswordResetToken` row and emails a reset link. The public response
   is **always** the same generic message, regardless of what actually
   happened server-side (see "Anti-enumeration" below).
3. User clicks the emailed link → `GET /reset-password?token=...`.
4. `POST /api/auth/reset-password` — validates the token, sets a new
   `passwordHash`, and atomically invalidates every outstanding reset
   token for that user.

## Data model

`PasswordResetToken` (additive — see `docs/password-reset-v1-migration.sql`
and `prisma/schema.prisma`):

```
PasswordResetToken
- id
- userId      -> User.id (CASCADE)
- tokenHash   UNIQUE, SHA-256 hex digest — plaintext is never stored
- expiresAt   createdAt + 30 minutes
- consumedAt  nullable; set exactly once
- createdAt
```

Indexes: `userId` (general lookup), `(userId, createdAt)` (the per-account
cooldown check).

## Token

`src/lib/passwordResetToken.ts` — 256-bit (`randomBytes(32)`) token,
base64url-encoded for the emailed URL, SHA-256-hashed for storage,
`timingSafeEqual` comparison helper (unused by the actual reset flow,
which looks the row up by its unique hash instead — kept for parity with
`courseInvitationToken.ts`'s shape and available for any future caller
that needs a compare-only check). TTL is fixed at 30 minutes
(`PASSWORD_RESET_TOKEN_TTL_MS`).

Same reasoning as `src/lib/courseInvitationToken.ts` / `src/lib/standaloneInvite.ts`
for SHA-256 over bcrypt: bcrypt's slow cost factor defends against
brute-forcing a low-entropy, human-chosen secret; it adds nothing (and
costs real CPU) for an already-unguessable 256-bit server-generated
token, and unlike a login password this value is never intended to be
memorized or reused.

## Anti-enumeration

`POST /api/auth/forgot-password` always returns:

```json
{ "message": "If an account exists for that email, we've sent password reset instructions." }
```

`src/lib/passwordReset.ts`'s `requestPasswordReset` never throws and
never returns anything the route could branch on — a nonexistent
account, a rate-limited account, a missing trusted origin, and a mail
provider outage are all silent no-ops from the route's point of view.
`POST /api/auth/reset-password` similarly collapses "unknown token",
"expired token", and "already-consumed token" into the same generic
`{ ok: false, error: "invalid" }` response — see the UI section below.

## Abuse control

A bounded per-account cooldown (`PASSWORD_RESET_REQUEST_COOLDOWN_MS`, 60
seconds): if a `PasswordResetToken` row was created for this user within
the last 60 seconds, a new request is a silent no-op (still returns the
generic response). This is DB-backed, not in-memory — Vercel serverless
functions do not share process memory across invocations, so an
in-memory limiter would not actually bound anything in production. No
row is ever created for a nonexistent email, so this never leaks
existence, and no broader IP-based/WAF anti-abuse subsystem is
implemented in this pass — that can be layered on later at the
infrastructure level without any change here.

## Email delivery

`src/lib/mail/sendPasswordResetEmail.ts` — a small Resend adapter behind
a provider-independent `sendPasswordResetEmail({ to, resetUrl })`
signature. Requires `RESEND_API_KEY` and `PASSWORD_RESET_FROM_EMAIL`;
fails closed (throws, before any network call) if either is missing —
the app still deploys and serves every other route without them, but no
reset email can be sent until both are set. Never logs the token, the
reset URL, or the API key. Subject: "Reset your Tether password"; both
HTML and plain-text bodies; never includes a password or unrelated
account information.

**Order of operations** (`requestPasswordReset`): the `PasswordResetToken`
row is created *before* the email is sent — a link must never be mailed
before its own DB row exists to validate against. If the send then
fails, the just-created row is deleted on a best-effort basis (the send
and the compensating delete cannot be one atomic transaction with each
other, since the send is a call to an external provider) so a
real-but-undeliverable token isn't left sitting in the database. The
public response is identical either way.

## Trusted reset URL

`src/lib/appOrigin.ts`'s `resolveTrustedExternalOrigin()` — APP_URL when
configured (production, stable, matches what's operationally
authoritative for this app), else `VERCEL_URL` normalized to `https://`
(Preview). Never derived from the incoming request's Host/
X-Forwarded-Host headers — `/api/auth/forgot-password` is unauthenticated,
so trusting those would let a crafted request steer a real reset link at
an arbitrary origin. This is a deliberately separate function from
`resolveLtiToolOrigin` (same precedence, same reasoning) rather than a
reuse of it, so this feature never has to touch — or risk destabilizing —
any LTI code path. `resolveInternalRedirectOrigin` (derived from the
current request's own origin) is not used here: that function's whole
point is following whatever origin is *currently serving this request*,
which is exactly wrong for a link that must remain valid when clicked
later, from an email client, against a specific registered origin.

If no trusted origin is configured, `requestPasswordReset` fails closed:
no token is created, no email is attempted, and the public response
stays generic (a sanitized error is logged server-side).

## Reset API concurrency

`resetPasswordWithToken` (`src/lib/passwordReset.ts`) guarantees one-time
use: the only write that can flip `consumedAt` from `null` is a
conditional `updateMany` guarded on `consumedAt: null`, inside a
transaction that also updates `User.passwordHash` and invalidates every
other outstanding token for the same user. Two concurrent requests
against the same token both read a not-yet-consumed row, but only one
`updateMany` can actually match; the loser sees `count !== 1` and returns
`"invalid"` without ever touching the password.

## Active JWT session security review

Tether uses JWT sessions (`src/auth.ts`, `session: { strategy: "jwt" }`).
A password reset updates `User.passwordHash` but does **not** revoke any
already-issued JWT session — a browser that was already logged in before
the reset stays logged in, because the JWT itself (not a DB row) is what
authenticates subsequent requests, and nothing about this feature reads
the database on an ordinary authenticated request.

A narrow "session version" / `passwordChangedAt`-comparison mechanism was
considered and deliberately **not** implemented: making it actually
revoke existing sessions would require comparing each request's token
against a live DB value (`User.passwordChangedAt` or similar) on every
authenticated request — i.e. exactly the DB-lookup-per-request and
performance-regression risk this task explicitly rules out, and a risk to
`apps/lockdown`/secure-exam session continuity this task explicitly
protects. There is no cheaper mechanism available under a pure-JWT
strategy that still provides genuine revocation (a token-side "version"
claim is only checked by re-reading the current version from the
database — there's no way to invalidate an already-issued, self-contained
JWT purely client-side).

**Residual behavior:** password reset changes future credential
authentication but previously issued JWT sessions remain valid until
their normal expiry.

**Classification: acceptable for pilot, not a blocker.** Rationale: (1)
implementing genuine revocation under this architecture would require
either a DB lookup on every request (explicitly out of scope, and a risk
to exam-session continuity) or a Vercel-wide session-store migration
(a redesign explicitly out of scope for this feature); (2) the primary
threat this feature defends against — an attacker who has learned or
guessed a password — is still fully mitigated, since the attacker's
future login attempts with the old password fail immediately; (3) the
residual risk is narrow (an attacker who already had a live, valid
session token before the legitimate user reset their password) and is a
standard, well-understood tradeoff of JWT-based auth, not unique to this
feature. If full session revocation becomes a hard requirement later, it
would need its own dedicated design pass (e.g. a session-store migration
or an explicit, narrowly-scoped `passwordChangedAt` check added only to
the specific request paths that can tolerate the extra DB read) — out of
scope here.

## Password minimum

`src/lib/selfServiceSignup.ts`'s `passwordSchema` (min 8 characters) is
now exported and reused directly by `POST /api/auth/reset-password` —
one source of truth, so the reset flow can never drift from the signup
minimum.

## Audit

`PlatformAuditLog` action `auth.password_reset_completed`, written only
on a successful reset (never on a request, so requesting a reset never
exposes account existence through audit/query surfaces). `actorId` is the
reset user themselves — the same "self as actor" convention already used
by self-service lecturer workspace creation
(`src/app/api/signup/route.ts`). Metadata carries no secret (no password,
no hash, no token).

## UI

- `/forgot-password` — email field; after submit, always shows "Check
  your email" / the generic message, regardless of the fetch outcome.
- `/reset-password?token=...` — new password + confirm fields;
  client-side length (≥8) and match checks; missing/unknown/expired/
  consumed token all show the same "This password reset link is invalid
  or has expired." with a "Request a new reset link" action; success
  shows "Password reset" / "Your password has been updated." with a "Log
  in" action. The plaintext token is never rendered.
- `/login` — a "Forgot password?" link next to the password field
  (`src/app/(auth)/login/page.tsx`); everything else on that page is
  unchanged.

## Environment variables

- `RESEND_API_KEY` — Resend API key. Optional at deploy time; required
  for reset emails to actually send.
- `PASSWORD_RESET_FROM_EMAIL` — verified from-address, e.g.
  `Tether <no-reply@your-verified-domain.com>`.

See `.env.example` for the full documented block.

## Tests

- `src/lib/passwordResetToken.test.ts` — token shape, entropy, hashing,
  TTL, URL builder (pure, no DB).
- `src/lib/mail/sendPasswordResetEmail.test.ts` — fails closed on missing
  configuration (pure, no network).
- `src/lib/passwordReset.routes.test.ts` — DB-backed: both routes,
  STUDENT/LECTURER parity, email normalization, anti-enumeration parity,
  token hash storage, cooldown, provider-failure cleanup, missing-origin
  fail-closed behavior, APP_URL/VERCEL_URL precedence, Host-header
  injection resistance, expiry/consumption/reuse/concurrency, password
  minimum, and the audit log.
- `src/app/(auth)/login/page.test.ts`,
  `src/app/(auth)/forgot-password/page.test.ts`,
  `src/app/(auth)/reset-password/page.test.ts` — source-text assertions,
  matching the existing convention in
  `src/app/(auth)/signup/page.test.ts` (no jsdom/RTL in this repo).
