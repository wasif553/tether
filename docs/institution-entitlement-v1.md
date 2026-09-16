# Institution Entitlement & Access Control v1

Server-side control over whether an institution may use Tether, independent of billing (which stays manual/external). This is **not** payment integration — no Stripe, no invoices, no card details, no webhooks.

## Critical commercial principle

Downloading Tether Secure Browser does **not** grant paid-product access. Entitlement belongs to the **institution**, decided server-side, at the moment of new commercial activity (creating/publishing an exam, starting a new attempt, adding a candidate, using a licensed feature). The Secure Browser installer remains freely downloadable and ungated by this feature (section 18).

```
invoice / Stripe / manual contract
             |
     Tether entitlement  (InstitutionEntitlement + src/lib/institutionEntitlement.ts)
             |
     institution access
```

## Data model

`InstitutionAccessType`: `INTERNAL | TRIAL | FREE | PAID` — describes *why* an institution has access, never *whether*.

`InstitutionEntitlementStatus`: `ACTIVE | SUSPENDED | EXPIRED | GRACE` — the stored, admin-set status.

`InstitutionEntitlement` (1:1 with `Institution`, `@unique institutionId`):
- `startsAt` / `endsAt` / `graceEndsAt` — `null` means unrestricted/no expiry, never a magic sentinel.
- `candidateLimit` / `attemptLimit` — `null` means unlimited.
- `secureBrowserEnabled` / `aiBrainstormingEnabled` / `aiMarkingEnabled` / `analyticsEnabled` / `advancedReportingEnabled` — licensed capabilities, independent of `status`.
- `internalNotes` — Platform-Admin-only; stripped from every non-admin response.

`Institution.plan` / `Institution.active` are **not removed**. They remain the legacy fields; every actual access decision now goes through `InstitutionEntitlement` instead. See "Legacy field handling" below.

## Effective status derivation (src/lib/institutionEntitlement.ts)

`evaluateInstitutionEntitlement(entitlement, now)` is the ONE place effective status is computed — no cron job, no scheduled job this correctness depends on; it's derived fresh on every request.

1. No row at all → `ACTIVE` (migration-safety fallback — see "Migration & backfill").
2. `status === SUSPENDED` → `SUSPENDED`, unconditionally (an explicit admin action always wins over dates).
3. `startsAt` in the future → `NOT_STARTED`.
4. `status === GRACE` → `GRACE`, unless `graceEndsAt` has passed (then `EXPIRED` — grace is not indefinite).
5. `endsAt` has passed → `EXPIRED`, even if the stored status still says `ACTIVE`.
6. stored `status === EXPIRED` → `EXPIRED` (an admin can mark this directly).
7. otherwise → `ACTIVE`.

Worked examples (section 2/3 of the original spec):
- `PAID + SUSPENDED` → no new delivery access (rule 2 dominates).
- `FREE + ACTIVE + endsAt: null` → allowed indefinitely.
- `TRIAL + ACTIVE` + valid dates → allowed.
- `GRACE` → historical access preserved, no new attempts, Platform Admin can reactivate.

## Actions and features

Two independent axes, deliberately never conflated (section 2/5):

- **`InstitutionEntitlementAction`** (`CREATE_EXAM`, `PUBLISH_EXAM`, `START_ATTEMPT`, `ADD_CANDIDATE`, `INVITE_LECTURER`) — gated by `canInstitutionDeliverAssessments` (general status/date) plus, for `ADD_CANDIDATE`/`START_ATTEMPT`, the relevant usage limit.
- **`InstitutionFeature`** (`SECURE_BROWSER`, `AI_BRAINSTORMING`, `AI_MARKING`, `ANALYTICS`, `ADVANCED_REPORTING`) — gated by `canInstitutionUseFeature`, which reads ONLY the boolean flag, never `status`.

**Hardening pass correction (section 3): READ EXISTING DATA vs GENERATE NEW LICENSED ACTIVITY.** A plain feature-only check (`requireInstitutionFeature`) is correct ONLY for reading/using something already generated — marking already-submitted work's EXISTING draft, viewing an already-computed report — where a `SUSPENDED`/`EXPIRED`/`GRACE` institution's feature flags staying independently true/false is exactly what section 7's "PRESERVE where safe" requires. It is NOT correct for a route that GENERATES something new: `requireInstitutionEntitlementAndFeature` covers that case instead, requiring BOTH the general status to be `ACTIVE` AND the feature flag enabled — a `SUSPENDED`/`EXPIRED`/`GRACE` institution can no longer run new AI marking, new analytics, or new advanced-report generation merely because nobody has flipped the feature flag off. `START_ATTEMPT`'s own `AI_BRAINSTORMING`/`SECURE_BROWSER` feature checks (below) don't need this combinator — the general `START_ATTEMPT` gate they sit right after already guarantees `ACTIVE` for that exact request, so a feature-only check there is already correct by construction.

## Where access is enforced

Audited per section 7; not every route is gated — see the "explicitly considered and NOT gated" list.

| Boundary | File | Gate |
|---|---|---|
| A. Create exam | `src/app/api/exams/route.ts` (`POST`) | `CREATE_EXAM` |
| B. Publish exam | `src/app/api/exams/[id]/route.ts` (`PATCH`) | `PUBLISH_EXAM`, only on the draft→published transition; plus `AI_BRAINSTORMING` feature check when the exam has `aiAssistanceMode: BRAINSTORM_ONLY`, plus `SECURE_BROWSER` feature check when it resolves to `TETHER_CLIENT_REQUIRED` (hardening pass, section 1) |
| C. Assign candidates | covered by exam creation (assignment happens at creation) + invite-student + **standalone-invite acceptance** (below — hardening pass, section 6) | — |
| D. Start a NEW attempt | `src/app/api/exams/[id]/start/route.ts` (`POST`) | `START_ATTEMPT` (general status + attempt-limit, transactionally reserved — see "Attempt limit definition"), ONLY for the new-attempt branch — never the existing-IN_PROGRESS resume branch; PLUS, still new-attempt-only, `AI_BRAINSTORMING` feature check when the exam's CURRENT `aiAssistanceMode` is `BRAINSTORM_ONLY` and `SECURE_BROWSER` feature check when the exam's CURRENT effective delivery mode is `TETHER_CLIENT_REQUIRED` (hardening pass, sections 1/2 — read live, never a frozen per-attempt snapshot, so a feature disabled AFTER publish still correctly denies the next new attempt) |
| — Add a candidate (institution member) | `src/app/api/platform/institutions/[id]/invite-student/route.ts` | `ADD_CANDIDATE` (candidateLimit enforced here) |
| — Add a candidate (standalone, no institution membership) | `src/app/api/exams/[id]/standalone-invite/accept/route.ts` | `ADD_CANDIDATE`-equivalent check, only when `isExistingCandidateForInstitution` says this student isn't already counted (hardening pass, section 6 — closes the bypass where a standalone student never gets `institutionId` set) |
| — Invite a lecturer | `src/app/api/platform/institutions/[id]/invite-lecturer/route.ts` | `INVITE_LECTURER` (general gate only — lecturers never count against candidateLimit) |
| G. AI-assisted marking (bulk "missing only", bulk "regenerate", and single-answer) | `.../ai-mark-essays/route.ts`, `.../ai-mark-essays/regenerate/route.ts`, `.../submissions/[id]/answers/[questionId]/ai-mark/route.ts` | `requireInstitutionEntitlementAndFeature(AI_MARKING)` — status AND feature (hardening pass, section 3); all three generate a NEW draft, so all three needed the same correction |
| H. Analytics | `src/app/api/lecturer/exams/[examId]/analytics/route.ts` | `requireInstitutionEntitlementAndFeature(ANALYTICS)` — status AND feature |
| I. Advanced reporting | `src/app/api/lecturer/exams/[examId]/similarity-analysis/route.ts` (`POST`) AND `.../collusion-analysis/route.ts` (`POST`) — the full V1 boundary, see "Advanced reporting boundary" below | `requireInstitutionEntitlementAndFeature(ADVANCED_REPORTING)` — status AND feature |

**Explicitly considered and NOT gated** (section 7's "do not mechanically block every route"):
- E. Secure-client activation (`POST /api/submissions/[id]/activate`) — operates on an already-created, already-gated submission; gating it again would risk interrupting an active attempt (section 8) for no additional protection.
- The live in-exam AI Brainstorming route (`POST /api/submissions/[id]/questions/[questionId]/ai-assistance`) — frozen logic, and mid-exam; gating this specifically would risk disrupting an active attempt exactly like section 8 forbids. The licensing check instead happens twice, at moments that are never mid-attempt: once at publish time (can this exam even go live with brainstorming configured) and once at new-attempt-start time (is it STILL licensed right now) — never inside the live route itself.
- `GET /api/exams/[id]/submissions`, `GET /api/submissions/[id]`, marks/evidence/export routes not listed above — basic historical record access, preserved unconditionally per section 7.
- `similarity-analysis`/`collusion-analysis`'s own `GET` handlers (viewing an already-computed analysis) — an existing result stays a preserved historical record; only the `POST` (running a NEW analysis) is gated on either route.

## In-progress exams (section 8)

The boundary is exact: `POST /api/exams/[id]/start`'s existing-`IN_PROGRESS` resume branch returns unconditionally, well before the entitlement check is ever reached. A student already sitting an exam when their institution's entitlement lapses (suspended, expires, enters grace) can:
- resume normally,
- autosave,
- submit,
- have integrity evidence captured,
- use secure-client recovery,

exactly as if nothing had changed. Only a **new** attempt on a **different or the same exam, after the current one ends**, is gated. Covered by the regression test "an existing IN_PROGRESS attempt is never interrupted..." in `institutionEntitlement.routes.test.ts`.

## Candidate limit definition (section 9; hardening pass section 6)

V1 (revised): a distinct `STUDENT` user counts as a candidate for an institution if EITHER:
1. they formally belong to it (`User.institutionId` matches), OR
2. they hold at least one `ExamAssignment` against one of the institution's exams — even with `institutionId: null`.

`getInstitutionCandidateUsage` computes this as a single `UNION` SQL query (de-duplicates automatically). Condition 2 exists specifically because of the **standalone exam invite** flow: `POST /api/exams/[id]/standalone-invite/accept` is documented as "never sets User.institutionId" — without condition 2, a student could take a real, institution-owned exam via a standalone link and never once count against `candidateLimit`. Selected-student assignment also uses `ExamAssignment`, so it's covered by condition 2 too, though in practice those students are always already course-enrolled institution members (`assertStudentsInCourse` requires it) and so are already covered by condition 1 — condition 2 costs nothing extra there, it just closes the standalone gap. Never counts `LECTURER`/`PLATFORM_ADMIN`.

**Enforcement points**: `POST /api/platform/institutions/[id]/invite-student` (the point a new institution-member candidate is created) and `POST /api/exams/[id]/standalone-invite/accept` (the point a new standalone candidate gains real exam access) — the latter only runs the check when `isExistingCandidateForInstitution` says this student doesn't already count, so a returning standalone candidate accepting a second invite from the same institution is never blocked by a limit they already (rightfully) count against. The standalone route maps a denial into its own established opaque `{ok:false, reason:"unavailable"}` response shape (never the standard `{error,code}` shape) to preserve its existing information-hiding contract (see that route's own module doc comment on why it never reveals *why* an invite failed).

## Attempt limit definition (section 10; hardening pass section 7)

V1 (revised): the count of **non-`VOIDED`** `Submission` rows — `IN_PROGRESS`, `SUBMITTED`, or `GRADED` — across every exam belonging to the institution (`getInstitutionAttemptUsage`, `status: { not: "VOIDED" }`). This deliberately now counts `IN_PROGRESS` too (the original V1 definition counted only `SUBMITTED`/`GRADED`, which let unboundedly many simultaneous active attempts run under a low `attemptLimit` and only discover the oversubscription once they finished). This is a DIFFERENT definition from `ACADEMIC_ATTEMPT_STATUSES` (`SUBMITTED`/`GRADED` only — still exactly what `isAcademicAttempt`/`countsTowardAttemptLimit` use for the per-student `maxAttempts` limit) on purpose: "is this a real result to grade/analyse" is a different question from "is this currently consuming institution-wide commercial allowance." A `VOIDED` attempt never consumes either kind of allowance.

**Concurrency safety**: a plain read-count-then-create has an inherent race — many simultaneous new-attempt requests for the same institution could each read a count below the limit and all pass. `reserveInstitutionAttemptAllowance(tx, institutionId, attemptLimit)` closes this: called INSIDE the same `prisma.$transaction` that creates the new `Submission` row, it first takes a Postgres advisory transaction lock (`pg_advisory_xact_lock(hashtext(institutionId))` — the same pattern `finalizeSubmission` already uses for a single submission's finalization in `submissionFinalization.ts`), THEN counts, THEN throws `InstitutionAttemptLimitReachedError` if the limit is already reached. The lock serializes concurrent new-attempt-creation for the SAME institution around this count-then-create sequence; it is skipped entirely when `attemptLimit` is `null` (unlimited — the common case), so unlimited institutions pay no locking overhead. `POST /api/exams/[id]/start` therefore has two layers: a cheap, non-transactional pre-check via `requireInstitutionEntitlement({action: "START_ATTEMPT"})` (fails fast with a clear response before any of the route's snapshot-building work), and this transactional, race-safe final check immediately before the row is actually created.

**Resume never double-counts**: `/start`'s existing-`IN_PROGRESS` branch returns before ever creating a second `Submission` row for the same attempt, so there is only ever one row per real attempt regardless of how the counting definition changes.

A unit test (`ACADEMIC_ATTEMPT_STATUSES stays in sync with isAcademicAttempt`) guards the OTHER (academic, per-student) definition against silently diverging from `isAcademicAttempt`.

## Migration & backfill (section 4; hardening pass section 5 — corrected)

This repository has no `prisma/migrations` directory. Schema changes are applied via `prisma db push` ONLY against the disposable local test database used by `npm run release:validate` (see `scripts/releaseValidation/disposableSchema.ts`'s own doc comment) — **Preview/Production schema changes are applied manually**, via a hand-extracted SQL file under `docs/*-migration.sql`, run through the Supabase SQL Editor (`docs/migration-ledger.md`, "Migration convention"). An earlier version of this document incorrectly implied `prisma/seed.ts` was the production backfill mechanism; it is not, and this section (and `docs/institution-entitlement-v1-migration.sql` itself) has been corrected.

**The real production migration** is `docs/institution-entitlement-v1-migration.sql`, which now contains BOTH the additive `CREATE TYPE`/`CREATE TABLE`/index/FK statements AND a SQL backfill (`INSERT ... SELECT ... WHERE e."id" IS NULL`), applied together as one script — verified against a disposable database (correct mapping for `pilot`/other `plan` × `active`/inactive, and idempotent: a second run of the backfill block inserts zero additional rows). The mapping is identical to the application-level one (`mapLegacyInstitutionToEntitlementInput` in `src/lib/institutionEntitlement.ts`, used only for local/dev seeding now — see below):

- `plan = 'pilot'` (the schema default, and the overwhelmingly common existing value) → `accessType TRIAL`; any other `plan` string → `PAID` (never guessed more specifically — the least likely mapping to under-grant access).
- `active = true` → `status ACTIVE`; `active = false` → `status SUSPENDED` (preserves exactly what the old boolean already meant for the two routes — invite-student/invite-lecturer — that used to check it).
- `startsAt`/`endsAt`/`graceEndsAt`: always `NULL` — never invents an expiry for a pre-existing institution.
- `candidateLimit`/`attemptLimit`: always `NULL` — never retroactively caps an existing customer.
- Every feature flag: `true` — preserves current pilot behaviour exactly.

**Never overwrites** an already-migrated or Platform-Admin-edited row — the `LEFT JOIN "InstitutionEntitlement" e ... WHERE e."id" IS NULL` guard means the `INSERT` only ever targets an institution that doesn't already have one.

**`prisma/seed.ts`'s own entitlement backfill is retained, but explicitly demoted to local/dev-only** — it is never automatically run against Preview/Production the way `db push` + seed is for the disposable release-validate database. It remains useful for any fresh local/dev database seeded from scratch, and is harmless to run even after the SQL backfill has already run elsewhere (same idempotent `where: { entitlement: null }` guard).

**What happens under each real-world scenario** (mirrored, with the exact same wording, in the SQL file's own trailing comment):
1. **The whole migration file applied** (schema + backfill, as one script — the normal case): every existing institution has an explicit row the instant the script finishes. No gap, regardless of how soon application code starts reading it.
2. **Only the DDL applied, backfill not yet run**: the table exists but is empty. The fail-open fallback (below) treats every institution as fully active/unlimited/all-features-on in the interim — never an outage, though a genuinely `SUSPENDED` institution would incorrectly still work until the backfill runs, so this gap should be kept as brief as possible.
3. **Migration applied, `prisma/seed.ts` NOT run, application starts immediately**: no different from scenario 1 — the SQL file's own backfill block already did `prisma/seed.ts`'s job for every real institution. `prisma/seed.ts` is not, and was never meant to be, the production backfill mechanism.

**Fail-open fallback for the interim**: `evaluateInstitutionEntitlement(null, now)` returns `ACTIVE`/unrestricted. An institution with no row yet is treated as fully active — the deliberate choice that makes it impossible for shipping this feature to retroactively lock out an existing customer. Once the backfill runs, every real institution has an explicit row and this fallback becomes dead code for them in practice; it remains load-bearing for local/disposable test databases (see "Testing" below).

## Legacy field handling (hardening pass section 4 — dual-authority conflict resolved)

`Institution.plan` / `Institution.active` are kept as-is at the data level (not removed), but **the Platform Admin UI no longer offers an independent way to edit `active`** — the "Activate"/"Deactivate" button and its `handleToggleActive` handler have been removed from `src/app/platform/institutions/page.tsx` entirely (option A from the hardening spec: "remove independent editing of legacy active/plan from Platform Admin UI, while retaining fields internally"). The institution card's top-right status badge, which used to be driven by `inst.active`, has been removed too — the entitlement summary row (access type + effective status, already present) is now the ONE status indicator shown, so there is no second, independently-toggleable badge that could silently disagree with it. The `plan` value is still shown, relabelled "legacy plan label... informational only — superseded by entitlement below."

`PATCH /api/platform/institutions/[id]` still *accepts* `active`/`plan` in its request body (so existing callers/tests and any genuinely-needed legacy-data correction keep working), but this is now purely storage — neither field is read by any access decision anywhere in the codebase. This is documented directly in that route's own schema comment. The result: `Institution.active = false` while `InstitutionEntitlement.status = ACTIVE` can no longer arise from the UI at all (there is no UI path left that writes `active` independently), and even if written via direct API/data correction, it has zero effect on actual access — it can never again "appear administratively disabled but remain usable" the other way around either, since nothing reads it. Removing the legacy fields from the schema entirely remains out of scope (the spec explicitly says not to, absent an exhaustive audit proving nothing depends on them) — deferred.

## Default entitlement for new institutions (section 20)

`POST /api/platform/institutions` creates a default `InstitutionEntitlement` row in the same request (`defaultInstitutionEntitlementInput()`): `TRIAL`/`ACTIVE`, no expiry (Platform Admin sets one explicitly), unlimited candidate/attempt limits, every feature enabled. Never blocks institution creation if the entitlement write itself fails (best-effort, logged).

## Platform Admin UI (sections 11-13, 21)

`src/app/platform/institutions/page.tsx`:
- Each institution card shows a one-line summary: access type, effective status (color-coded), expiry (or "No expiry"), candidate usage/limit, attempt usage/limit.
- "Manage entitlement" expands an inline editor: access type, status, start/end/grace dates (empty = no expiry/no restriction), candidate/attempt limits (empty = unlimited), the five feature checkboxes, and internal notes (labelled "never shown to institution users"). One "Save entitlement" action, `PUT /api/platform/institutions/[id]/entitlement`.
- No billing UI of any kind.

## Grace period (section 14)

A simple, manually-managed V1 state: `status: GRACE` blocks `START_ATTEMPT`/`CREATE_EXAM`/`PUBLISH_EXAM` (via `ENTITLEMENT_GRACE_PERIOD`) but never touches feature flags or historical-record routes. Platform Admin reactivates by changing `status` back to `ACTIVE` (or converts to any other state) through the same entitlement editor. `graceEndsAt` is optional; if it passes, the effective status becomes `EXPIRED` automatically (grace is not indefinite) — still no cron job, derived at request time.

## Audit logging (section 15)

Every `PUT /api/platform/institutions/[id]/entitlement` call writes a `PlatformAuditLog` row with the full previous/new entitlement values (`internalNotes` included — this endpoint and the audit-log viewer are both `PLATFORM_ADMIN`-only). The action name is chosen by comparing previous/new `status`:
- no previous row → `INSTITUTION_ENTITLEMENT_CREATED`
- `SUSPENDED` → something else → `INSTITUTION_ENTITLEMENT_REACTIVATED`
- something else → `SUSPENDED` → `INSTITUTION_ENTITLEMENT_SUSPENDED`
- otherwise → `INSTITUTION_ENTITLEMENT_UPDATED`

## Student/lecturer UX (sections 16-17)

- Student-facing denial (`requireInstitutionEntitlement({..., audience: "STUDENT"})`, used only at `START_ATTEMPT`): always the single neutral sentence *"This assessment cannot be started at this time. Please contact your institution."* — never a reason code's specific wording, never "hasn't paid."
- Staff-facing denial (the default `audience: "STAFF"`): a specific-but-still-neutral sentence per reason (e.g. *"Your institution's Tether access is currently suspended. Contact Tether support."*) — still never internal notes/contract terms.
- `institutionAccessStatusMessage(evaluated)` — a small helper producing the section-16 banner text ("Trial access. Access active until 30 Nov 2026." / "Institution access is currently inactive. Contact your institution administrator or Tether support.") for a future lecturer/admin-facing banner. **Not yet wired into a specific lecturer page** — see "Deferred" below.

## Advanced reporting boundary (hardening pass section 8)

**Decision: option A** — a coherent V1 boundary exists and is now fully gated, rather than removing the feature. `advancedReportingEnabled` covers exactly the cohort-level integrity ANALYSIS-GENERATION capability: `POST /api/lecturer/exams/[examId]/similarity-analysis` (answer similarity) and `POST /api/lecturer/exams/[examId]/collusion-analysis` (cohort collusion graph) — both real, well-defined, already-implemented cohort-analysis engines, distinct from ordinary per-exam marks/results. Both `POST` routes (the only two places a NEW such analysis is generated) are gated with `requireInstitutionEntitlementAndFeature(ADVANCED_REPORTING)`; both routes' `GET` handlers (viewing an already-computed analysis) stay ungated — an existing result is a preserved historical record, not new licensed activity.

**Deliberately excluded from this boundary**: marks-export, `analytics/export.csv`, and other basic CSV/record exports — these are ordinary institutional record-keeping (section 7's "PRESERVE where safe... reports/results required for records"), not a premium add-on, and gating them would risk blocking legitimate historical access the spec explicitly protects.

## Entitlement validation rules (hardening pass section 9)

`validateEntitlementInput` (pure function, `src/lib/institutionEntitlement.ts`) runs server-side in `PUT /api/platform/institutions/[id]/entitlement`, in addition to (never instead of) the route's zod type/shape validation — HTML form validation on the client is never trusted as the only gate. Returns every violation found, not just the first:

- `endsAt` earlier than `startsAt` → rejected.
- `status: GRACE` with no `graceEndsAt` → rejected ("A grace period requires a grace end date — grace is a temporary state, never indefinite").
- `graceEndsAt` earlier than `endsAt` (when both set) → rejected.
- `candidateLimit` / `attemptLimit` ≤ 0 → rejected (also independently enforced by the zod schema's `.positive()`, which excludes both negative values and zero — this is a second, testable layer with its own clear message, not a redundant no-op).

The route returns `400` with `{ error: "Invalid entitlement values", validationErrors: [...] }` (each `{ field, message }`) when any rule fails — checked AFTER zod parsing succeeds, so a caller always sees type errors before logical ones.

## Secure Browser download (section 18)

Untouched by this feature entirely — `/api/tether/release-metadata` and every download-related route have no dependency on `InstitutionEntitlement`. Verified: neither imports `institutionEntitlement.ts`, and the regression test run (see the implementation report) included no failures anywhere near the release/download surface.

## No payment provider (section 19)

Confirmed nowhere in this feature: no Stripe/PayPal SDK, no webhook route, no card/payment field on `InstitutionEntitlement`, no checkout flow. `internalNotes` is a free-text field for Platform Admin's own commercial bookkeeping, never machine-read by anything.

## Testing

- `src/lib/institutionEntitlement.unit.test.ts` — pure-function coverage (status/date derivation, feature independence, migration mapping, default entitlement, internalNotes sanitization, the `ACADEMIC_ATTEMPT_STATUSES`/`isAcademicAttempt` sync guard, `validateEntitlementInput`'s logical validation rules). Mocks `@/lib/prisma` so it runs under plain `npm test`, no disposable database required.
- `src/lib/institutionEntitlement.routes.test.ts` — DB-backed route coverage (create/publish/start gating, in-progress-exam safety, candidate/attempt limits, Platform Admin CRUD + authorization + audit logging + internalNotes non-leakage, migrated-institution fallback, historical-record access after expiry). Run exclusively via `npm run release:validate`.
- `src/lib/institutionEntitlementHardening.routes.test.ts` — DB-backed coverage specifically for the hardening pass corrections: Secure Browser new-attempt gating (publish-time and start-time, active-exam continuity), AI Brainstorming re-evaluation at the new-attempt boundary after a post-publication feature change, status+feature AND logic for AI marking/analytics/advanced reporting (including that a SUSPENDED/EXPIRED institution is blocked even with the feature flag on, and that existing AI-mark drafts stay readable), legacy `Institution.active` vs entitlement non-conflict in both directions, the standalone candidate-limit bypass closure (denied for a genuinely new candidate, never blocked for a returning one), attempt-limit IN_PROGRESS counting/resume-non-double-counting/VOIDED-exclusion/last-slot-succeeds-next-denied, the full two-route advanced-reporting boundary, and route-level (not just unit-level) validation-error rejection. Run exclusively via `npm run release:validate`.
- `src/lib/testInstitution.ts`'s `getOrCreateTestInstitution` creates (never overwrites) a fully-permissive `InstitutionEntitlement` row, so the hundreds of existing DB-backed tests across the repo exercise the real entitlement-evaluation code path with an explicit row rather than only the migration-safety fallback.
- The raw SQL migration/backfill file (`docs/institution-entitlement-v1-migration.sql`) was verified directly against a disposable Postgres database as part of this hardening pass: applied from scratch (DDL + backfill) against four seeded legacy institutions covering every `plan`×`active` combination, confirmed each mapped correctly, and confirmed the backfill block alone is idempotent (a second run inserts zero additional rows). This is SQL/DDL correctness, not application logic, so it is verified this way rather than as a vitest test.

## Deferred (explicitly out of scope for this pass)

- A lecturer/institution-admin-facing UI banner using `institutionAccessStatusMessage` — the helper function exists and is unit-tested, but is not yet wired into a specific lecturer page.
- Removing `Institution.plan`/`Institution.active` from the schema entirely — kept per the spec's explicit instruction, pending a future exhaustive audit; the hardening pass instead removed the UI's ability to edit them independently (see "Legacy field handling").
- Any UI to bulk-migrate or bulk-edit entitlements across many institutions at once — out of scope; one institution at a time via the existing Platform Admin page.
- Gating basic marks/results/evidence exports under any feature flag — deliberately excluded from the advanced-reporting boundary; see that section.
