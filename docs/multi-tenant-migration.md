# Multi-Tenant Architecture v1

## What this is

SES is now multi-tenant: institutions are isolated from each other, while
every existing single-institution pilot keeps working unchanged (all
pre-existing data lands in one "default" institution after the migration
runs).

## Schema

- New `Institution` model: `id`, `name`, `slug` (unique), `domain`,
  `plan` (default `"pilot"`), `active` (default `true`), timestamps.
- `User`, `Exam`, `LtiPlatform` each get a nullable `institutionId` +
  relation + `@@index([institutionId])`.
- `User.canvasUserId` changed from a global `@unique` to
  `@@unique([institutionId, canvasUserId])` — a self-hosted Canvas
  instance at a different institution could otherwise collide with
  another institution's Canvas user id.
- New `Role` enum value: `PLATFORM_ADMIN`.
- `Submission`, `Answer`, `IntegrityEvent`, `CanvasGradePassback`,
  `LtiLaunch`, `LtiExamLink` deliberately do **not** get their own
  `institutionId` column — they are scoped by joining to their parent
  (`exam.institutionId` or `platform.institutionId`). This avoids a
  duplicated, driftable scoping column on every dependent table.
- `institutionId` is nullable at the database level everywhere.
  Application code treats it as required via
  `src/lib/institutionScope.ts`, which fails loudly (not silently) when
  it's missing.
- Schema changes were applied with `prisma db push` (this project does
  not use `prisma migrate`).

## Institution scoping helpers (`src/lib/institutionScope.ts`)

- `DEFAULT_INSTITUTION_SLUG` — the slug used for the pilot-backfill
  institution (`"default"`).
- `getSessionInstitutionId(session)` — returns the session's
  institutionId or `null`, never throws.
- `isPlatformAdmin(session)` — the single choke point for the
  `PLATFORM_ADMIN` bypass. Never inline a role check against
  `"PLATFORM_ADMIN"` anywhere else.
- `requireInstitutionId(session)` — throws `MissingInstitutionError` if
  absent. Used at the top of any route that must not proceed with
  ambiguous tenancy.
- `institutionWhere(session)` — a Prisma `where` fragment: `{}` for a
  `PLATFORM_ADMIN`, `{ institutionId }` otherwise.
- `assertSameInstitution(session, institutionId)` — throws
  `InstitutionAccessError` on a mismatch, bypassed for
  `PLATFORM_ADMIN`. Always resolves the session's institutionId via
  `requireInstitutionId` first, so a session with no institutionId
  always fails loudly rather than ever matching `null === null` against
  an unbackfilled resource.
- `scopedExamFetch` / `scopedSubmissionFetch` — fetch-and-assert
  convenience wrappers.
- `institutionErrorResponse(err)` — maps the two errors above to a
  `NextResponse` (401 "please log in again" / 403 "Not found"), or
  returns `null` for any other error so the caller can rethrow.

## Session

`src/auth.ts`'s JWT and session callbacks carry `institutionId` through
the token. **Anyone logged in before this deploy has a JWT without
institutionId and must log out and back in** — `requireInstitutionId`
throws on their next scoped request, which the routes map to a 401 with
a "please log in again" message.

## Routes scoped

- `GET /api/exams/available` — was completely unscoped (the highest
  -risk gap found in the design audit); now filtered by
  `institutionWhere`.
- `GET /api/exams`, `POST /api/exams` (list + create, stamps
  `institutionId` on create).
- `GET/PATCH/DELETE /api/exams/[id]`, questions sub-routes, `submissions`
  list, `start`.
- `PATCH /api/submissions/[id]/answers`, `POST .../submit` — left
  unscoped beyond their existing `studentId === session.user.id` check,
  since that check is already strictly tighter than an institution
  check (a user belongs to exactly one institution).
- `PATCH /api/submissions/[id]/grade`, `approve-ai-grade`, `push-grade`.
- `GET /api/lecturer/exams/[examId]/analytics` (+ CSV),
  `integrity-events` (+ CSV), `POST .../resolve`.
- `POST /api/lecturer/exams/[examId]/generate-questions`,
  `ai-mark-essays`.
- `POST/DELETE /api/lecturer/exams/[examId]/lti-links[/[linkId]]`.
- `GET /api/lecturer/lti/unmatched-launches` — scoped via
  `platform.institutionId` (required adding a previously-missing
  `LtiLaunch.platform` relation field; additive, no new column).
- `GET /api/lecturer/pilot-readiness` — all counts (platforms, linked
  resources, recent launch, unmatched count, most-recent-SENT passback)
  scoped to the caller's institution; these were previously unscoped
  global counts, a real cross-tenant leak.
- `POST /api/lti/launch` — new users get `institutionId` from the
  launching platform; if an *existing* matched user's institutionId
  differs from the platform's, this is logged as a warning and **never**
  silently reassigned — it's flagged as a potential cross-tenant
  identity issue for manual review.
- `src/lib/evidenceReport.ts`'s `buildEvidenceReport()` is the single
  choke point for evidence access — both the JSON and CSV evidence
  routes call it, so the institution check lives there once.
- `QuestionBank` routes were deliberately left unscoped at the
  institution level: they are already filtered by direct
  `lecturerId === session.user.id` ownership, which is strictly tighter
  than an institution check.

## Platform admin v1

`GET /api/platform/institutions` — `PLATFORM_ADMIN` only, returns
`id, name, slug, plan, active, createdAt, _count { users, exams }` for
every institution. No passwords, secrets, or other sensitive user data.

Institution onboarding (create/update institutions, invite lecturers, an
audit log) was originally deferred here to "Multi-Tenant Admin v2" — see
docs/platform-admin-onboarding.md, which documents that it has since
shipped.

## Signup

`POST /api/signup` assigns every new self-signup user to the default
institution (looked up by `DEFAULT_INSTITUTION_SLUG`). No
institution-code or invite flow in v1 — out of scope for the pilot.

## Production migration steps

1. Run `prisma/seed.ts` against production (creates the default
   institution, backfills every null-`institutionId` row, creates the
   `PLATFORM_ADMIN` account).
2. Verify zero null-`institutionId` rows remain (the seed script prints
   this count).
3. **All existing users must log out and back in after this deploy** —
   their old JWTs lack `institutionId` and will be rejected by
   `requireInstitutionId` with a "please log in again" message.
4. Push the commits.
5. Vercel auto-deploys.
6. Run the smoke test script.
7. Verify an existing lecturer can log in and see their existing exams.
8. Verify an existing student can log in and see their existing exams.

## Known test-only discrepancy

The original test-writing instructions for this feature referenced
`POST /api/platform/institutions` and an invite-lecturer route in two of
the route-level tests. Those routes were explicitly out of scope for v1
(see "Platform admin v1" above), so those two tests were written against
the actual `GET /api/platform/institutions` route's authorization
behavior instead.
