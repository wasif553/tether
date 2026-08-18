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

Nothing here needed a new table or column. The only two facts required —
"does an existing Tether User share this email" and "is the current
browser authenticated as that exact User" — are both already answerable
from existing state: `User.email` (unique) and the incoming request's
own Auth.js session cookie, read via `auth()` exactly like every other
route in this app. No migration was prepared or applied for this pass.

## Collision resolution algorithm

**Step A** (unchanged): look up `User` by `(institutionId, canvasUserId)`
— or by `canvasUserId` alone if the platform has no `institutionId` yet.
A mapped user always takes this path; it is never routed through
collision linking.

**Step B** (new): only reached when Step A finds no mapping AND Canvas
supplied a real email (not the synthetic fallback).

- No existing `User` with that email → unchanged: create a new `User`
  exactly as before.
- An existing `User` with that email → `src/lib/lti/identityCollision.ts`'s
  `resolveLtiEmailCollision`:
  1. No current Tether session → `requires_login`.
  2. Current session belongs to a *different* `User.id` → `wrong_account`.
  3. Current session belongs to the *exact* matching `User.id` —
     ownership confirmed. Then, inside one transaction:
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
  4. Any outcome other than `linked` → the launch redirects to
     `/lti/identity-link?reason=<outcome>` (a small, non-technical page)
     and does **not** set a session cookie, create an `LtiLaunch` row, or
     proceed to exam launch. A `lti.identity_link_blocked` audit entry is
     recorded.
  5. `linked` → the launch continues through the exact existing flow
     (session cookie, `LtiLaunch` creation, exam redirect) using the
     now-linked account. A `lti.identity_linked` audit entry is recorded.

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

## UX

`/lti/identity-link?reason=<reason>` — one small page, five reason
branches, no technical jargon (no "P2002", "canvasUserId",
"institutionId", "JWT", or "nonce" anywhere in the copy):

- `requires_login` — "Existing account found" + a plain sign-in link.
- `wrong_account` — a sign-out button + instructions to sign back in with
  the right account.
- `role_mismatch` / `different_institution` / `canvas_id_taken` — a
  single generic "contact your institution's Tether administrator"
  message; these are support-review situations without a self-service
  fix, and none of them reveal *why* internally.

## Audit

Two new `PlatformAuditLog` actions, both with safe metadata only
(`platformId`, and — for a blocked attempt — the reason code):
`lti.identity_linked`, `lti.identity_link_blocked`. Never logs a
password, `id_token`, full launch JWT, session cookie, or `AUTH_SECRET`.

## Explicitly unchanged

Nonce/replay protection, `id_token` signature/issuer/audience
verification, `LtiSession` consumed semantics, `LtiExamLink` resolution,
AGS/grade passback, the unlinked-assignment friendly route, and every
other Canvas/course/Standalone Exam Link/Tether Course
Invitation/self-service behavior.

## Tests

`src/lib/lti/ltiLaunchIdentityCollision.test.ts` — exercises the real
`/api/lti/launch` route end-to-end with genuinely signed JWTs (a
test-generated RSA keypair, `findPlatformJwk`'s underlying `fetch` call
mocked to return the corresponding public JWK), covering: normal new-user
provisioning, existing canvasUserId-mapped launches, the email collision
in all its outcomes (no session / wrong session / matching session,
including institution-claim, cross-institution-rejection, role-mismatch,
and canvasUserId-taken cases), both identified races, mapped-user email
updates (safe and conflicting), the no-email synthetic path, and
regression coverage confirming nonce/replay/signature verification,
`LtiExamLink` resolution, STUDENT/LECTURER launch redirects, and the
unlinked-assignment fallback are all unchanged.
