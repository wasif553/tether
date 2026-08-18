# Canvas/LTI Identity Collision Hardening v1

**Feature:** Canvas/LTI Identity Collision Hardening v1
**Status:** Ready for Preview

---

## The defect

`POST /api/lti/launch` looks up an existing Tether `User` by
`(institutionId, canvasUserId)`. When no mapping exists, it used to call
`prisma.user.create({data: {email, ...}})` unconditionally. If Canvas
supplied an email that already belonged to an existing Tether `User`
(most commonly a self-service account created via
`docs/self-service-account-onboarding-v1.md`), that `create` collided
with `User.email`'s unique constraint and crashed with an unhandled
P2002.

## Fixed decisions (not redesigned, not reopened)

- Email alone never links accounts. Self-service emails aren't verified
  strongly enough to be a safe identity-binding signal.
- A second `User` is never created for an email that already belongs to
  someone.
- Ownership must be proven: the Canvas launch is already cryptographically
  verified; a live, authenticated Tether session for the exact matching
  account proves the human controls it. Both together, on the same
  request, are the only accepted proof.
- No second password is ever collected or transmitted through Canvas.
- A no-email Canvas launch keeps the existing synthetic-identity
  behavior unchanged — see "No-email Canvas users" below.
- `User.institutionId` only ever moves `null -> platform.institutionId`,
  never institution A -> institution B.
- STUDENT/LECTURER role is never silently changed because Canvas reports
  a different one.
- Exam launch, AGS/grade passback, `LtiExamLink` resolution,
  nonce/replay protection, and existing course/standalone access are all
  unchanged.

## No schema change

Nothing here needed a new table or column. The two facts required —
"does an existing Tether User share this email" and "is the current
browser authenticated as that exact User" — are answerable from existing
state (`User.email`, unique) plus a short-lived signed token carried
entirely in the URL/request body (see "Browser-flow hardening" below).
No migration was prepared or applied for this pass.

## Collision resolution algorithm

**Step A** (unchanged): look up `User` by `(institutionId, canvasUserId)`
— or by `canvasUserId` alone if the platform has no `institutionId` yet.
A mapped user always takes this path; it is never routed through
collision linking.

**Step B** (revised — see "Browser-flow hardening"): only reached when
Step A finds no mapping AND Canvas supplied a real email (not the
synthetic fallback).

- No existing `User` with that email → unchanged: create a new `User`
  exactly as before.
- An existing `User` with that email → the launch route no longer tries
  to resolve the collision itself. It issues a short-lived signed
  handoff token and redirects the browser to `/lti/identity-link`, a
  normal same-site Tether page. That launch is finished: `LtiSession` is
  already consumed (see "LTI session/replay safety" below), no session
  cookie is set, no `LtiLaunch` row is created, and no exam launch
  happens from this request.
- The actual resolution — `src/lib/lti/identityCollision.ts`'s
  `resolveLtiEmailCollision` (unchanged in its own logic; see below) — now
  runs inside `POST /api/lti/identity-link/confirm`, a same-site request
  triggered by the user clicking "Connect Canvas identity" on that page:
  1. `session.user.id !== handoff.existingUserId` → `wrong_account`
     (this subsumes the old "no session at all" case too — an
     unauthenticated confirm attempt is rejected at the route's own
     auth() gate before this comparison is even reached).
  2. Session matches — ownership confirmed. Then, inside one transaction
     (`resolveLtiEmailCollision`, logic unchanged from the original
     pass):
     - Reject (`role_mismatch`) if the existing account's role doesn't
       match Canvas's derived role.
     - Reject (`canvas_id_taken`) if this `canvasUserId` (scoped to the
       platform's institution, or globally if the platform has none) is
       already bound to a *different* `User`.
     - Reject (`different_institution`) if the existing account already
       belongs to a different, non-null institution than the platform's.
     - If the existing account's `institutionId` is `null` and the
       platform's is known, atomically claim it (see "Atomic linking"
       below).
     - If the platform's `institutionId` is itself `null`: preserve
       existing compatibility — the pre-existing mapped-user path
       already runs with zero institution enforcement in that case, so
       this pass doesn't invent institution membership either;
       `institutionId` is left exactly as it was, whatever value it
       held.
     - Bind `canvasUserId` to the existing account.
  3. Any outcome other than `linked` → `{ok: false, reason: <outcome>}`,
     a `lti.identity_link_blocked` audit entry, no database write beyond
     that.
  4. `linked` → `{ok: true}`, a `lti.identity_linked` audit entry. The
     student returns to Canvas and opens the assessment again — that
     brand-new LTI login/launch hits Step A directly (the mapping now
     exists) and proceeds through the completely normal, unchanged
     launch flow. No auth() dependency, no collision logic, involved in
     that second launch at all.

## Browser-flow hardening: why the launch route can't read the session

Auth.js's session cookie uses the `SameSite=Lax` default — unchanged,
deliberately (see "Important — cookie policy" below). A Canvas LTI
launch is a cross-site `POST` from Canvas to Tether; browsers do not
attach `SameSite=Lax` cookies to a cross-site `POST`. The first version
of this feature called `auth()` inside `POST /api/lti/launch` to check
for an existing Tether session — that call could never reliably see it,
which would have produced an infinite `requires_login` loop even for a
student who was, in fact, already signed in.

The fix moves ownership confirmation to a same-site request:

1. `src/lib/lti/identityLinkHandoff.ts` — `createIdentityLinkHandoff`
   signs a compact JWT (`{existingUserId, canvasUserId, platformId,
   derivedRole}`, jose `HS256`) with a 10-minute expiry
   (`IDENTITY_LINK_HANDOFF_TTL_SECONDS`). The signing key is HKDF-SHA256
   derived from `AUTH_SECRET` with a dedicated context label
   (`"lti-identity-link-handoff-v1"`) — never `AUTH_SECRET` itself, so a
   leak of this derived key can't be used to forge a NextAuth session
   token or vice versa. `verifyIdentityLinkHandoff` never throws — any
   tampered/expired/malformed token returns `null`.
2. The launch route redirects to `/lti/identity-link?handoff=<token>`
   (a normal, same-origin browser navigation — no cookie-attachment
   concerns here, this isn't a cross-site request).
3. If the browser isn't authenticated, the page's own "Sign in to
   Tether" link preserves the exact same page (handoff included) as the
   post-login `callbackUrl`, guarded by the new
   `isSafeLtiIdentityLinkCallbackUrl` (see "Callback safety" below) — so
   after login the user lands right back here, same handoff, ready to
   confirm. It never attempts to return to the already-consumed Canvas
   launch.
4. Once authenticated, clicking "Connect Canvas identity" performs an
   ordinary same-site `fetch("/api/lti/identity-link/confirm", {method:
   "POST", body: {handoff}})` — a normal same-origin request, so the
   session cookie is attached exactly like any other authenticated
   action in this app.

The handoff alone is never sufficient to link an account — forwarding
the `/lti/identity-link?handoff=...` URL to someone else does nothing,
because the confirmation endpoint still requires
`session.user.id === handoff.existingUserId`.

## Callback safety

`isSafeLtiIdentityLinkCallbackUrl` (`src/lib/safeCallbackUrl.ts`) is a
narrow, hardcoded special case for exactly one fixed path
(`/lti/identity-link`): an exact match, or that exact path followed by
`?` and a restrictive character class (`[A-Za-z0-9_=&.%-]*` — no `/`,
`#`, `:`, or `@`, so it can never smuggle a new path, fragment, or
authority). The query string itself is never parsed or treated as a
redirect target — it's opaque data (the signed, separately-verified
handoff) consumed entirely by the fixed destination page. This is
deliberately **not** a general query-string-aware allowlist; every other
guard in that file stays purely path-based for the same reason stated in
their own doc comments.

## Atomic linking (race safety)

Both writes inside `resolveLtiEmailCollision` are race-safe:

- **`institutionId` claim** — a conditional `updateMany({where: {id,
  institutionId: null}, ...})`, mirroring Tether Course Invitation +
  Acceptance v1's own User-row claim
  (`src/app/api/course-invitations/[invitationId]/[token]/accept/route.ts`).
  Two concurrent collisions for two *different* institutions on the same
  null-institution account can never both succeed — Postgres row-level
  locking on the `User` row means the loser's conditional update matches
  zero rows once the winner has committed.
- **`canvasUserId` bind** — an upfront ownership check (fast path) plus
  a try/catch around the actual `update` that turns any unique-constraint
  violation on `(institutionId, canvasUserId)` into a clean rejection.
  Because this write happens *after* the institution claim in the same
  transaction, a conflict here **throws** (not returns) so the whole
  transaction — including any institution claim already made — rolls
  back atomically. Two concurrent launches can never bind one Canvas
  identity to two different Tether accounts.

## Email-update hardening for already-mapped users

The existing mapped-user path could previously write a changed Canvas
email straight onto the matched `User` row. Since `User.email` is
globally unique, a later Canvas email change that happens to collide
with a *different* existing `User` would crash the same way. Now: if the
new email is already owned by someone else, the update is skipped (never
overwritten, never merged) and the launch continues using the safely
mapped `canvasUserId` identity. The conflict is logged
(`console.error`, matching the existing institution-mismatch logging
convention on the line above it) — not treated as fatal.

## No-email Canvas users

If Canvas supplies no email at all, the existing synthetic identity
(`lti-<canvasUserId>@safe-exam-system.local`) is used exactly as before.
This pass never attempts to reconcile a no-email launch with a
pre-existing self-service account by name, course, or any other guessed
signal — a synthetic identity is safer than an incorrect account merge.
**This is a known, accepted v1 limitation**: a Canvas platform configured
to withhold email cannot be automatically reconciled with a pre-existing
self-service Tether identity.

## LTI session/replay safety

Unchanged: `LtiSession` is marked `consumed` immediately after the
launch's `id_token` is verified (nonce checked, signature/issuer/
audience verified), regardless of what happens afterward — including a
collision. A collision launch's `LtiSession` is just as consumed as any
other; the old `id_token`/launch is never stored for replay, and nothing
in the confirmation flow re-reads or re-validates it. Completing the
connection requires returning to Canvas and starting a genuinely new LTI
login/launch, which mints a new `LtiSession`/nonce/`id_token` the normal
way.

## Important — cookie policy unchanged

This pass does **not** change Auth.js's session cookie from its default
`SameSite=Lax`, does **not** create a second/duplicate session cookie for
LTI, and does **not** weaken any CSRF/session-cookie protection. The fix
is entirely about *when* `auth()` is called (a same-site confirmation
request) rather than *how* the cookie itself behaves.

## UX

`/lti/identity-link?handoff=<token>` — one small page, driven by
`useSession()` client-side, no technical jargon (no "P2002",
"canvasUserId", "institutionId", "JWT", "nonce", or internal IDs
anywhere in the copy):

- No handoff in the URL → generic "connection link is no longer valid,
  return to Canvas" message.
- Not signed in → "Existing account found" + a "Sign in to Tether" link
  that preserves this same page as the post-login callback.
- Signed in, not yet confirmed → "You are signed in to Tether" +
  "Connect Canvas identity" button (a deliberate, explicit confirmation
  click — nothing links automatically on page load).
- Confirmation succeeds → "Canvas identity connected" + "Return to
  Canvas and open the assessment again."
- Confirmation fails (`wrong_account`, `role_mismatch`,
  `different_institution`, `canvas_id_taken`, `invalid`) → a safe,
  non-diagnostic message; `wrong_account` gets its own slightly more
  specific copy, the rest share one generic "contact your institution's
  Tether administrator" message.

## Audit

Two `PlatformAuditLog` actions, written by
`POST /api/lti/identity-link/confirm` (not the launch route, which no
longer determines any outcome), both with safe metadata only
(`platformId`, and — for a blocked attempt — the reason code):
`lti.identity_linked`, `lti.identity_link_blocked`. Never logs a
password, `id_token`, full launch JWT, session cookie, handoff token, or
`AUTH_SECRET`.

## Explicitly unchanged

Nonce/replay protection, `id_token` signature/issuer/audience
verification, `LtiSession` consumed semantics, `LtiExamLink` resolution,
AGS/grade passback, the unlinked-assignment friendly route, Auth.js's
`SameSite=Lax` session-cookie policy, and every other Canvas/course/
Standalone Exam Link/Tether Course Invitation/self-service behavior.

## Tests

- `src/lib/lti/ltiLaunchIdentityCollision.test.ts` — the original pass's
  suite: real signed-JWT launches covering normal provisioning, mapped
  launches, no-email synthetic identity, mapped-user email-update
  hardening, and nonce/replay/signature/`LtiExamLink`/AGS-adjacent
  regression coverage. Updated only where the collision outcome moved
  from the launch response to a handoff redirect.
- `src/lib/lti/ltiIdentityLinkHandoff.test.ts` — the browser-flow
  hardening suite: a collision launch never depends on an Auth.js
  session cookie and never creates a duplicate `User`; handoff signing/
  tampering/expiry; the confirmation endpoint's auth gate, ownership
  check, and every `resolveLtiEmailCollision` outcome (institution
  claim, cross-institution rejection, role mismatch, canvasUserId
  collision, concurrent confirmation); that a successful confirmation
  never creates an `LtiLaunch` row and never revives the original
  (already-consumed) `LtiSession`; and the full end-to-end path of a
  second, brand-new LTI launch finding the Step A mapping and proceeding
  completely normally after confirmation.
