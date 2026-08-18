# Self-Service Account Onboarding v1

**Feature:** Self-Service Account Onboarding v1
**Status:** Ready for Preview

---

## What this feature adds

Public self-signup (`POST /api/signup`) previously accepted either role
and stamped the new user into one shared `DEFAULT_INSTITUTION_SLUG`
institution — meaning any two strangers who both self-signed-up as
lecturers landed in the same institution and could, in principle, see
each other's exam-adjacent data via institution-wide legacy visibility
(`courseId: null`, see `docs/tether-onboarding-and-strict-course-access-architecture-inspection` findings from the prior architecture pass).

This feature replaces that with a role-specific model:

- **Account creation does not grant exam access.** This is an account
  identity boundary only — course/exam entitlement is a separate concern
  that a later pass connects via Canvas/LTI, Tether Course enrolment, or
  a Standalone Exam Link. None of those connection mechanisms are
  implemented here.
- **STUDENT self-signup** creates a `User` with `institutionId: null` — a
  valid, loginable, global Tether identity with zero exam visibility
  until later given access by some other mechanism. It is never
  auto-joined to `DEFAULT_INSTITUTION_SLUG` or any other institution.
- **LECTURER self-signup** atomically creates a brand-new `Institution`
  ("workspace") and a `LECTURER` `User` belonging to it, in one Prisma
  transaction. It can never join, select, or claim an existing
  institution — joining an existing institution still only happens
  through that institution's own platform-admin invite flow
  (`docs/platform-admin-onboarding.md`), unchanged by this feature.

## Non-negotiable security rule (enforced by the request schema itself)

Public signup can never allow a caller to:

- specify an arbitrary `institutionId`
- select or join an existing institution
- create `PLATFORM_ADMIN`
- have a `STUDENT` or `LECTURER` land in `DEFAULT_INSTITUTION_SLUG`

This is enforced structurally, not by a runtime check that could be
forgotten: `src/lib/selfServiceSignup.ts`'s `selfServiceSignupSchema` is a
zod **discriminated union** on `role` with exactly two branches
(`STUDENT`, `LECTURER`), each `.strict()`. A `role` of anything else
(including `PLATFORM_ADMIN`) matches neither branch and is rejected by
the schema itself — there is no separate `if (role === "PLATFORM_ADMIN")`
check to accidentally remove later. `.strict()` on each branch means an
`institutionId`, `slug`, `plan`, or (on the student branch)
`organisationName` present in the body fails as an "unrecognized key"
rather than being silently ignored.

## Request shapes

```
STUDENT:  { name, email, password, role: "STUDENT" }
LECTURER: { name, email, password, role: "LECTURER", organisationName }
```

`name` is trimmed; `email` is trimmed and lowercased; `password` remains
a minimum of 8 characters (unchanged); `organisationName` is required and
trimmed for `LECTURER`, and rejected outright if present for `STUDENT`.
bcrypt cost stays 12, matching the invite-lecturer/invite-student routes
and the previous signup route. The response never includes the password
or its hash.

## Lecturer workspace creation and slug strategy

`Institution.slug` is generated server-side from `organisationName` via
`sanitizeInstitutionSlug()` (reused from `src/lib/platformAdmin.ts`, the
same normalization already used for platform-admin-created institutions)
— never caller-supplied. Collisions are expected and handled without
error: attempt 0 uses the sanitized base slug; each retry appends a
short, random, server-generated 8-character hex suffix
(`generateInstitutionSlugCandidate()` in `src/lib/selfServiceSignup.ts`),
bounded at `MAX_SLUG_ATTEMPTS = 6`. Two different lecturers signing up
with the same or similarly-named organisation always get two distinct
institutions — the slug collision handling exists purely to avoid a
raw-string primary-key clash, never to merge or share tenancy.

Institution + Lecturer + audit-log rows are created inside one
`prisma.$transaction` — never an institution without its lecturer, or
vice versa. A P2002 unique-constraint violation inside the transaction is
resolved by re-querying whether the email now exists (an email race) —
if so, 409; otherwise it's treated as a slug collision and retried with a
new candidate. This avoids depending on Prisma/Postgres error-shape
internals for the distinction.

## Auditability

Self-service lecturer workspace creation writes one `PlatformAuditLog`
row, in the same transaction as the institution/user rows:

```
action: "institution.self_service_create"
actorId: <the new lecturer's own user id — no admin performed this>
targetType: "Institution"
targetId: <new institution id>
institutionId: <new institution id>
metadata: { name, slug }   // never password/passwordHash
```

Student self-signup does not currently write an audit log (optional per
the task spec; deferred — `institutionId: null` makes a
per-institution-scoped audit entry awkward, and there is no cross-
institution "global" audit surface in this codebase to attach it to
instead).

## Unaffiliated student dashboard behavior

`src/lib/institutionScope.ts`'s `requireInstitutionId()`/`institutionWhere()`
global rule — "a session with no `institutionId` is an error, never a
silent bypass" — is intentionally **not weakened**. Instead,
`GET /api/exams/available` (`src/app/api/exams/available/route.ts`)
explicitly short-circuits: if `session.user.institutionId == null`, it
returns `200 []` immediately, before any exam/course query runs. This is
a deliberate "valid account, no entitlements yet" state, not an
authorization bypass and not an error — it never falls back to
`DEFAULT_INSTITUTION_SLUG` or any other institution's exams. Existing
institution-linked students are unaffected (verified by regression test).

The `/student` dashboard's empty state now reads: *"No exams available
right now. Exams will appear here when you are given access."* — worded
to be equally correct for a brand-new unaffiliated account and an
institution-linked student who simply has nothing current.

## Deep-link graceful failure (no code change required)

`GET /api/exams/[id]/access-check` and `POST /api/exams/[id]/start`
already handled a session with no `institutionId` correctly, before this
feature: both call `assertSameInstitution(session, exam.institutionId)`,
which calls `requireInstitutionId(session)` first and throws
`MissingInstitutionError` for a null-institution session — caught and
mapped by each route. `access-check` converts this into the same generic
`{ ok: false, reason: "no_access" }` shape used for every other denial
reason (never a raw 401/500, never exam metadata), which
`/student/exams/join/[examId]` already renders as *"You do not have
access to this exam."* This was verified directly by reading both routes
and is now covered by a regression test rather than a code change.

## What this feature deliberately does NOT do

Per the task's explicit scope boundary — these are for a later pass:

- Canvas/LTI roster connection
- Tether Course enrolment for a self-service student
- Standalone Exam Link entitlement (deep links remain convenience links
  only, not authorization tokens)
- `ExamAssignment` schema/semantics changes
- Course roster bulk import
- Removing the pre-existing `courseId: null` institution-wide legacy
  visibility rule for already-institution-linked users
- Email verification (a later commercial-hardening item — this pass
  intentionally does not add fake/placeholder verification)

## Schema / migration

**None.** `User.institutionId` was already nullable; `Institution`
already existed. No Prisma schema change, no migration file, no
`prisma db push` against any shared database.

## Known limitations / residual risks

- No email verification — a self-service account is usable immediately
  with an unverified email address, same as the previous flow.
- A self-service lecturer's brand-new institution has no seeded content,
  courses, or students — by design, this is account creation only; the
  lecturer must use existing Tether functionality (course creation,
  question banks, exam creation) to build out their workspace from an
  empty state.
- Student self-signup has no audit trail (see "Auditability" above) —
  acceptable for v1 given `institutionId: null` has no institution to
  scope an audit entry to; worth reconsidering if a global/cross-tenant
  audit surface is ever added.
