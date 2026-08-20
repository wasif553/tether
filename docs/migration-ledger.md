# Database Migration Ledger

This project does **not** use Prisma Migrate (`prisma/migrations` does not
exist, and never has — see "Migration convention" below). Every schema
change since the initial base schema has instead been a hand-extracted,
manually-applied SQL file under `docs/*-migration.sql`, generated from
`npx prisma migrate diff` and applied by a human via the Supabase SQL
Editor (or `psql`). This ledger tracks which of those files have actually
been applied to Preview and production, since nothing in this repository
or its CI automatically applies them — see docs/deployment-vercel-supabase.md
for the full deployment process.

**Preview/Production database topology note (as of the Screen-share
Evidence Mode v1 migration):** Preview and Production currently point at
the SAME Supabase database — they are not two separate databases that
each need this file applied to them. Any migration file whose header
doesn't explicitly say otherwise should still be treated as "apply once,
to the one shared database" unless/until Preview and Production are
split onto separate database instances. The two-step "apply to Preview,
then separately to production" procedures documented for earlier
migrations in this ledger were written before this was confirmed
explicitly — re-run the pre-check query for any of them before assuming
a second apply is actually needed.

**Confirmed applied — do not re-apply.** As of 2026-08-06, the following
nine migration files have each been applied exactly once to the one
shared Preview/Production Supabase database (project ref
`ugckdvbjzauvcovcqebw`; confirmed via the read-only verification queries
below returning the expected tables/columns/enum values):

- `docs/ai-brainstorming-assistance-migration.sql` — applied 2026-07-22.
- `docs/screen-share-evidence-migration.sql` — applied 2026-07-23.
- `docs/answer-similarity-migration.sql` — applied 2026-07-24.
- `docs/cohort-collusion-graph-v1-migration.sql` — applied 2026-07-24.
- `docs/answer-development-provenance-v1-migration.sql` — applied 2026-07-25.
- `docs/secure-client-foundation-seb-v1-migration.sql` — applied 2026-07-25.
- `docs/sql/add-tether-secure-resume-recovery.sql` — applied 2026-08-02.
- `docs/sql/add-tether-windows-lockdown-hardening.sql` — applied 2026-08-05.
- `docs/sql/repair-installation-attestation-foundation.sql` — applied 2026-08-06.

Because Preview and Production are the same database, there is no
separate "now apply it to the other environment" step for any of these
eight — that single application already covers both. **None of these
eight files should be run again against this database.** Re-running any
of them will error on `CREATE TABLE`/`ADD COLUMN` (see each file's own
idempotency note) at best, or silently duplicate rows at worst if a
statement happens to be re-runnable — always re-run the relevant
pre-check query first if there is ever any doubt.

## Migration convention

- **Base schema** (initial launch): applied with `npx prisma db push`, a
  one-time exception documented in docs/multi-tenant-migration.md ("this
  project does not use `prisma migrate`").
- **Every schema change since**: `npx prisma migrate diff --from-empty
  --to-schema prisma/schema.prisma --script`, hand-extracted to just the
  new/changed statements, saved as `docs/<feature>-migration.sql`,
  applied manually via the Supabase SQL Editor. **Never** `prisma db
  push` against Preview or production after the initial launch.
- There is no `_prisma_migrations` tracking table in this project's
  databases, and none is expected — Postgres/Supabase has no built-in
  memory of which of these hand-applied files have run, which is exactly
  why this ledger exists (see "Preview/staging verification queries"
  below for how to check drift directly against the live schema instead).
- Each file's own header states the exact `prisma migrate diff` command
  used to generate it and confirms it is additive-only (no existing
  table/column/enum value altered or removed).

## Preview/staging verification queries (read-only)

Run these in the Preview/staging Supabase SQL Editor to determine current
state before applying any migration file. All read-only — none of these
modify data or schema.

```sql
-- Does a Prisma-Migrate tracking table exist? (Expected: no rows —
-- confirms this project has never used `prisma migrate`.)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = '_prisma_migrations';

-- Any other migration-tracking-shaped table? (Expected: no rows.)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name ILIKE '%migration%';

-- Has the AI-assistance Submission column already been applied?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'Submission' AND column_name = 'aiAssistancePolicySnapshotJson';

-- Does AiAssistanceInteraction already exist?
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'AiAssistanceInteraction';

-- Do the five new IntegrityEventType enum values already exist?
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'IntegrityEventType'::regtype
  AND enumlabel IN (
    'AI_ASSISTANCE_USED',
    'AI_ASSISTANCE_REQUEST_BLOCKED',
    'AI_ASSISTANCE_LIMIT_REACHED',
    'AI_ASSISTANCE_RESPONSE_REGENERATED',
    'AI_ASSISTANCE_REQUEST_FAILED'
  );

-- Does the AiAssistanceInteraction.clientRequestId idempotency-key
-- unique index already exist (added during pre-Preview hardening)?
SELECT indexname FROM pg_indexes
WHERE tablename = 'AiAssistanceInteraction' AND indexname = 'AiAssistanceInteraction_clientRequestId_key';

-- Has the screen-share Submission column already been applied?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'Submission' AND column_name = 'screenSharePolicySnapshotJson';

-- Does IntegrityEvidenceAsset.clientRequestId already exist?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'IntegrityEvidenceAsset' AND column_name = 'clientRequestId';

-- Do the eight new screen-share IntegrityEventType enum values already exist?
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'IntegrityEventType'::regtype
  AND enumlabel LIKE 'SCREEN_SHARE_%';

-- Full current enum value list, for a manual diff against prisma/schema.prisma:
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'IntegrityEventType'::regtype
ORDER BY enumsortorder;
```

Interpretation:
- All targeted queries for a given migration file return no rows → that
  file has not been applied yet; safe to apply.
- The column/table/enum values already exist → it has already been
  applied; re-running the file would error on `CREATE TABLE`/`ADD COLUMN`
  (the `ALTER TYPE ... ADD VALUE IF NOT EXISTS` statements alone are safe
  to re-run, but the table/column/index/constraint statements are not —
  see that file's own note).
- A partial match (e.g. enum values present but the table doesn't exist)
  indicates a previous partial/failed application — investigate before
  re-applying; do not blindly re-run the whole file.

## Ledger

| # | File | Feature | Preview applied | Production applied | Notes |
|---|------|---------|-----------------|--------------------:|-------|
| — | (base schema) | Initial schema | `prisma db push` (pre-dates this ledger) | `prisma db push` (pre-dates this ledger) | One-time exception — see "Migration convention" above |
| 1 | `docs/answer-similarity-migration.sql` | Answer Similarity Review v1 | **Applied 2026-07-24** | **Applied 2026-07-24 (same shared database as Preview)** | Confirmed applied — do not re-apply. |
| 2 | `docs/answer-activity-telemetry-migration.sql` | Exam Session Binding + Time Anomaly Review v1 | not tracked (predates ledger) | not tracked (predates ledger) | Bundled in the repository's initial commit |
| 3 | `docs/exam-session-binding-migration.sql` | Exam Session Binding v1 | not tracked (predates ledger) | not tracked (predates ledger) | Bundled in the repository's initial commit |
| 4 | `docs/evidence-frame-migration.sql` | On-Device AI Camera Integrity Detection v1 — Evidence Frames | not tracked (predates ledger) | not tracked (predates ledger) | |
| 5 | `docs/one-question-delivery-migration.sql` | One-Question-At-A-Time Exam Delivery v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 6 | `docs/question-pools-migration.sql` | Question Pools v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 7 | `docs/ai-use-review-migration.sql` | AI-Use Answer Review v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 8 | `docs/exam-policy-evidence-review-migration.sql` | Exam Design Policy + Evidence Review v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 9 | `docs/question-navigator-migration.sql` | Question Navigator v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 10 | `docs/ai-brainstorming-assistance-migration.sql` | Controlled AI Brainstorming Assistance v1 | **Applied 2026-07-22** | **Applied 2026-07-22 (same shared database as Preview)** | Confirmed applied — do not re-apply. Revised in place during pre-Preview hardening (added `wasRegenerated`/`clientRequestId`/unique index + a fifth `AI_ASSISTANCE_REQUEST_FAILED` enum value) before it was ever applied to any environment — the version actually applied is the fully-hardened one. |
| 11 | `docs/screen-share-evidence-migration.sql` | Screen-share Evidence Mode v1 | **Applied 2026-07-23** | **Applied 2026-07-23 (same shared database as Preview)** | Confirmed applied — do not re-apply. No new table — additive columns on the existing `Submission` and `IntegrityEvidenceAsset` tables plus 8 new `IntegrityEventType` enum values. |
| 12 | `docs/cohort-collusion-graph-v1-migration.sql` | Cohort-Level Collusion Detection and Integrity Graph v1 | **Applied 2026-07-24** | **Applied 2026-07-24 (same shared database as Preview)** | Confirmed applied — do not re-apply. Five new tables (`CohortCollusionAnalysis`, `CollusionPairEdge`, `CollusionSignal`, `CollusionCluster`, `CollusionClusterMember`) — zero columns added to any existing table. |
| 13 | `docs/answer-development-provenance-v1-migration.sql` | Answer-Development Provenance v1 | **APPLIED ONCE — 2026-07-25** | **APPLIED ONCE — 2026-07-25 (same shared database as Preview)** | Confirmed applied — do not re-apply. See "Verification — answer-development provenance migration" below for the full read-only confirmation record. |
| 14 | `docs/secure-client-foundation-seb-v1-migration.sql` | Tether Secure Client Foundation + Safe Exam Browser Compatibility v1 | **APPLIED ONCE — 2026-07-25** | **APPLIED ONCE — 2026-07-25 (same shared database as Preview)** | Confirmed applied — do not re-apply. See "Verification — secure client foundation migration" below for the full read-only confirmation record. |
| 15 | `docs/sql/add-tether-secure-resume-recovery.sql` | Tether Secure Exam Recovery and Resilient Autosave v1 | **APPLIED ONCE — 2026-08-02** | **APPLIED ONCE — 2026-08-02 (same shared database as Preview)** | Confirmed applied — do not re-apply. Additive only — three new nullable/defaulted columns on `SecureClientSession`, four on `Submission` (one unique), two on `Answer`, plus one index and one self-referencing foreign key. See docs/tether-secure-resume-recovery-v1.md and "Verification — secure recovery migration" below for the full read-only confirmation record. |
| 16 | `docs/sql/add-tether-windows-lockdown-hardening.sql` | Tether Windows Lockdown Hardening v1 | **APPLIED ONCE — 2026-08-05** | **APPLIED ONCE — 2026-08-05 (same shared database as Preview)** | Confirmed applied — do not re-apply. Additive only — five new `IntegrityEventType` enum values (`REMOTE_CONTROL_SOFTWARE_DETECTED`, `SCREEN_CAPTURE_SOFTWARE_DETECTED`, `DEBUGGING_TOOL_DETECTED`, `PROHIBITED_APPLICATION_DETECTED`, `PROHIBITED_APPLICATION_CLOSED`) — no new table, no new column, no existing row modified. Every other lockdown fact is `PlatformAuditLog` only (its `action` column is a plain string, needing no schema change). See docs/tether-windows-lockdown-hardening-v1.md and "Verification — Windows lockdown hardening migration" below for the full read-only confirmation record. |
| 17 | `docs/sql/repair-installation-attestation-foundation.sql` | Production schema repair — complete installation-attestation foundation (supersedes the earlier, narrower SecureClientSession-only repair) | **APPLIED ONCE — 2026-08-06** | **APPLIED ONCE — 2026-08-06 (same shared database as Preview)** | Confirmed applied — do not re-apply. Repaired a confirmed production gap spanning FIVE previously untracked files, none of which had ever been applied: `docs/sql/add-tether-client-installation.sql`, `docs/sql/add-tether-installation-registration-challenge.sql`, `docs/sql/add-system-check-secure-client-verification.sql`, `docs/sql/add-tether-system-check-readiness.sql`, and `docs/sql/add-secure-client-session-installation-attestation.sql` (all written 2026-07-30 through 2026-08-01, "Secure Client Attestation v2" / "Tether System Check and Exam Readiness v1"). Live inspection had confirmed the whole rollout was missing: `SecureClientSession` lacked all six installation-attestation columns (causing Prisma error P2022), and `TetherClientInstallation`/`TetherInstallationRegistrationChallenge`/`SystemCheckSecureClientVerification`/`TetherSystemCheckRun` did not exist at all. Unrelated to, and not superseded by, row 15's 2026-08-02 migration, which never touched any of these objects. The production P2022 failure is resolved. See "Deployment procedure — repair-installation-attestation-foundation.sql" and "Verification — installation attestation foundation repair" below for the full dependency graph, audit, and read-only confirmation record. **This migration must not be applied again.** |
| 18 | `docs/tether-preflight-lifecycle-v1.7.4-migration.sql` | Tether v1.7.4 Pre-exam Readiness + Safe Lockdown Activation | **APPLIED ONCE — 2026-08-11** | **APPLIED ONCE — 2026-08-11 (same shared database as Preview)** | Confirmed applied — do not re-apply. One new nullable column on the existing `Submission` table (`activatedAt`), a one-time backfill UPDATE (`activatedAt = startedAt WHERE activatedAt IS NULL`), PLUS (for zero-downtime cutover safety) a database-level `DEFAULT CURRENT_TIMESTAMP` set only after the backfill — the first migration in this ledger to include both a data backfill AND a default set in a deliberately ordered 3-block sequence; see the SQL file's own extensive safety-analysis header (in particular "ZERO-DOWNTIME CUTOVER RACE" and "WHY BLOCK 3 MUST COME AFTER BLOCK 2"). Verified post-apply: zero `activatedAt IS NULL` rows immediately after the backfill; every existing row's `activatedAt` equals its own `startedAt`; `information_schema.columns.column_default` confirms `CURRENT_TIMESTAMP` is set on the column. Applied BEFORE the v1.7.4 application code deploy, per docs/tether-preflight-lifecycle-v1.7.4.md's "Production rollout order" step 1 — the application code itself has not yet been deployed. See docs/tether-preflight-lifecycle-v1.7.4.md and "Deployment procedure — tether-preflight-lifecycle-v1.7.4-migration.sql" below. |
| 19 | `docs/exam-time-accommodations-v1-migration.sql` | Individual Exam Timing & Accommodations v1 | **APPLIED — 2026-08-17** | **APPLIED — 2026-08-17 (same shared database as Preview)** | Written 2026-08-17, on branch `feature/exam-time-accommodations`. Preview and Production share ONE Supabase database (project ref `ugckdvbjzauvcovcqebw`) — this file was applied **once**, not once per environment, via an authorized expand-first rollout: only the new, currently-unused `ExamTimeAccommodation` table was created (zero columns added to any existing table — both new `Exam`/`User` relations are back-relations only). No new Prisma enum; `adjustmentMode` is a plain application-validated `TEXT` column. Applied via a single atomic transaction executing the file's exact 7 statements (1 `CREATE TABLE`, 3 `CREATE INDEX`, 3 `ALTER TABLE ADD CONSTRAINT`) — no `prisma db push`, `prisma migrate deploy/dev/resolve`, and no Supabase SQL Editor session; connected directly with the project's own `PrismaPg` adapter using the repository's existing `DATABASE_URL`. Post-apply verification (read-only) confirmed: all 8 columns present with the documented types/nullability/defaults; primary key on `id`; unique index on (`examId`, `studentId`); plain indexes on `examId` and `studentId`; all three foreign keys present with the documented `ON DELETE` behaviour (`examId`→`Exam` CASCADE, `studentId`→`User` CASCADE, `createdById`→`User` RESTRICT); the new table has 0 rows. `User`/`Exam`/`Institution` row counts were identical immediately before and after (293/124/186) — zero existing rows were added, removed, or modified. **The application feature itself (API routes, lecturer UI, POST /api/exams/[id]/start integration) is NOT yet deployed to production** — this row reflects only the additive schema expansion; the feature branch has not been merged to main as of this entry. See docs/exam-time-accommodations-v1.md for the feature. |
| 20 | `docs/standalone-exam-link-v1-migration.sql` | Standalone Exam Link v1 | **APPLIED ONCE — 2026-08-18** | **APPLIED ONCE — 2026-08-18 (same shared database as Preview)** | Written 2026-08-18, on branch `feature/standalone-exam-link-v1`. Preview and Production share ONE Supabase database (project ref `ugckdvbjzauvcovcqebw`, host `aws-1-ap-northeast-1.pooler.supabase.com`) — applied **once**. Fully additive: one new `ExamAssignmentMode` enum value (`STANDALONE`) plus two new columns on the existing `Exam` table (`standaloneInviteTokenHash TEXT`, nullable; `standaloneInviteEnabled BOOLEAN NOT NULL DEFAULT false`) — no new table, no column added to any other table, no existing row's `assignmentMode` changed. Connected directly with `pg`'s `Client` using the repository's existing `DATABASE_URL` — no `prisma db push`/`migrate`, no Supabase SQL Editor session. Pre-check (read-only) confirmed `ExamAssignmentMode` was `['COURSE', 'SELECTED_STUDENTS']` (no `STANDALONE`) and neither new column existed yet, on a table with 125 existing `Exam` rows. Applied the file's exact 3 statements (1 `ALTER TYPE ... ADD VALUE`, 2 `ALTER TABLE ... ADD COLUMN`) as separate auto-committed statements (deliberately not wrapped in one explicit transaction, since `ALTER TYPE ... ADD VALUE` cannot have its new value referenced within the same still-open transaction — this script never does). Post-apply verification (read-only) confirmed: `ExamAssignmentMode` now `['COURSE', 'SELECTED_STUDENTS', 'STANDALONE']`; both new columns present with the documented types/nullability/defaults; 0 of the 125 existing `Exam` rows have `assignmentMode = 'STANDALONE'`; all 125 have `standaloneInviteEnabled = false`; 0 have a non-null `standaloneInviteTokenHash`. Applied AFTER the feature's full focused test suite (`src/lib/standaloneExamLink.routes.test.ts`, 45+ cases) and a full `npm run release:validate` pass (2960/2960 tests, typecheck, lint, build) against the disposable local database — never against this shared database. See docs/standalone-exam-link-v1.md for the feature. |
| 21 | `docs/tether-course-invitation-acceptance-v1-migration.sql` | Tether Course Invitation + Acceptance v1 | **APPLIED ONCE — 2026-08-18** | **APPLIED ONCE — 2026-08-18 (same shared database as Preview)** | Written 2026-08-18, on branch `feature/tether-course-invitations-v1`. Preview and Production share ONE Supabase database (project ref `ugckdvbjzauvcovcqebw`, host `aws-1-ap-northeast-1.pooler.supabase.com`) — applied **once**. Fully additive: ONE new table, `CourseEnrollmentInvitation` (10 columns) — no column added to any existing table, no existing row modified. Connected directly with `pg`'s `Client` using the repository's existing `DATABASE_URL` — no `prisma db push`/`migrate`, no Supabase SQL Editor session. Pre-check (read-only) confirmed the table did not yet exist, on a database with 2 existing `Course` rows. Applied the file's exact statements (1 `CREATE TABLE`, 3 `CREATE INDEX`, 3 `ALTER TABLE ADD CONSTRAINT`). Post-apply verification (read-only) confirmed: all 10 columns present with the documented types/nullability/defaults (`tokenHash` nullable, `expiresAt` NOT NULL, `acceptedAt`/`revokedAt` nullable, `createdAt` defaults `CURRENT_TIMESTAMP`); primary key on `id`; unique index on (`courseId`, `studentId`); plain indexes on `studentId` and `invitedById`; all three foreign keys present with the documented `ON DELETE` behaviour (`courseId`→`Course` CASCADE, `studentId`→`User` CASCADE, `invitedById`→`User` RESTRICT); the new table has 0 rows; `Course` and `User` column counts unchanged (10 each). Applied AFTER the feature's full focused test suite (`src/lib/courseInvitationAcceptance.routes.test.ts`, 38 cases) and a full `npm run release:validate` pass (166/166 test files, 2998/2998 tests, typecheck, lint, build) against the disposable local database — never against this shared database. See docs/tether-course-invitation-acceptance-v1.md for the feature. |
| 22 | `docs/password-reset-v1-migration.sql` | Password Reset v1 | **APPLIED ONCE — 2026-08-20** | **APPLIED ONCE — 2026-08-20 (same shared database as Preview)** | Written 2026-08-20, on branch `feature/password-reset-v1`. Preview and Production share ONE Supabase database (project ref `ugckdvbjzauvcovcqebw`, host `aws-1-ap-northeast-1.pooler.supabase.com`) — applied **once**. Fully additive: ONE new table, `PasswordResetToken` (6 columns) — no column added to `User` or any other existing table, no existing row modified. Connected directly with `pg`'s `Client` using the repository's existing `DATABASE_URL` — no `prisma db push`/`migrate`, no Supabase SQL Editor session. Pre-check (read-only) confirmed the table did not yet exist, on a database with 297 existing `User` rows and `User` at 10 columns. Applied the file's exact statements (1 `CREATE TABLE`, 3 `CREATE INDEX`, 1 `ALTER TABLE ADD CONSTRAINT`) inside a single `BEGIN`/`COMMIT` transaction. Post-apply verification (read-only) confirmed: all 6 columns present with the documented types/nullability/defaults (`tokenHash` UNIQUE NOT NULL, `expiresAt` NOT NULL, `consumedAt` nullable, `createdAt` defaults `CURRENT_TIMESTAMP`); primary key on `id`; the unique index on `tokenHash` plus plain indexes on `userId` and `(userId, createdAt)`; the foreign key to `User` present with `ON DELETE CASCADE`; the new table has 0 rows; `User` column count unchanged (10) and row count unchanged (297). Applied AFTER the feature's full focused test suite (`src/lib/passwordReset.routes.test.ts`, `src/lib/passwordResetToken.test.ts`, `src/lib/mail/sendPasswordResetEmail.test.ts`) and a full `npm run release:validate` pass (178/178 test files, 3115/3115 tests, typecheck, lint, build) against the disposable local database — never against this shared database. See docs/password-reset-v1.md for the feature. |
| 23 | `docs/auth-token-abuse-protection-v1-migration.sql` | Auth and Token Abuse Protection v1 | **NOT APPLIED / PENDING SECURITY REVIEW** | **NOT APPLIED / PENDING SECURITY REVIEW** | Written 2026-08-20, on branch `feature/auth-token-abuse-protection-v1`. **DO NOT APPLY** until an independent security review of the accompanying application-code diff explicitly authorizes it — see this task's own closeout requirements. Fully additive when it is eventually applied: ONE new table, `SecurityRateLimitBucket` (7 columns, no foreign keys by design) — no column added to `User`, `Exam`, `PasswordResetToken`, `CourseEnrollmentInvitation`, or any other existing table, no existing row would be modified. Validated only against the disposable local database via `npm run release:validate` — **never applied to the shared Preview/Production Supabase database in this pass.** See docs/auth-token-abuse-protection-v1.md for the feature and the migration SQL file's own header for the exact pre-check/apply/verification procedure to follow once authorized. **Row 22 (PasswordResetToken) remains already-applied and must never be re-applied — unrelated to and unaffected by this row.** |

Rows 2-9 predate this ledger's creation, so their actual apply dates are
not recorded here — an operator who has applied them should backfill the
real dates. Row 1 and rows 10-12 have now been confirmed applied (see
"Confirmed applied — do not re-apply" above) and their dates are
recorded above; keep this accurate going forward for any future
migration file.

## Deployment procedure — `docs/ai-brainstorming-assistance-migration.sql`

**Already applied — 2026-07-22, to the one shared Preview/Production
database. Do not run this file again.** The steps below are kept as a
historical record of the procedure that was followed.

### Preview

1. Run the read-only verification queries above against the Preview
   database first, to confirm the migration has not already been
   partially applied.
2. Open the Preview Supabase project → SQL Editor.
3. Paste and run sections 1-3 of `docs/ai-brainstorming-assistance-migration.sql`
   (the `ALTER TYPE` statements, then `ALTER TABLE`, then `CREATE TABLE`/
   indexes/foreign keys) — the file is already in execution order.
4. Re-run the verification queries above to confirm all five now return
   the expected rows.
5. Run the file's own "Verification queries" section (bottom of the SQL
   file) — in particular query 6, which should return 0.
6. Record the date in the Ledger table above (row 10, "Preview applied").
7. Smoke-test: enable AI Brainstorming Assistance on a test exam in
   Preview and confirm a request round-trips successfully (see
   docs/pilot-readiness.md).

### Production

Only after Preview has been verified and (ideally) briefly pilot-tested:

1. Run the same read-only verification queries against **production**
   first.
2. Open the **production** Supabase project → SQL Editor (double-check
   you are pointed at production, not Preview).
3. Apply the same file, in the same order, the same way.
4. Re-run verification queries against production.
5. Record the date in the Ledger table above (row 10, "Production
   applied").
6. Do not enable `aiAssistanceMode` on any real exam until the
   institutional pilot-readiness checklist in docs/pilot-readiness.md is
   complete.

## Deployment procedure — `docs/screen-share-evidence-migration.sql`

**Already applied — 2026-07-23, to the one shared Preview/Production
database. Do not run this file again.** The steps below are kept as a
historical record of the procedure that was followed.

Preview and Production currently share ONE Supabase database — apply
this file **once**, not once per environment.

1. Run the pre-check query embedded at the top of
   `docs/screen-share-evidence-migration.sql` first, to confirm the
   migration has not already been applied.
2. Open the (shared) Supabase project → SQL Editor.
3. Paste and run sections 1-3 of the file (the `ALTER TYPE` statements,
   then the two `ALTER TABLE` statements, then the `CREATE UNIQUE INDEX`)
   — the file is already in execution order.
4. Run the file's own "Verification queries" section to confirm all
   changes landed and no existing camera-evidence row was altered.
5. Record the date in the Ledger table above (row 11) — a single date is
   sufficient given the shared database; leave the second cell blank or
   mark it "same database as Preview."
6. Do not set `screenShareMode: "REQUIRED"` on any real exam until the
   institutional pilot-readiness checklist in docs/pilot-readiness.md is
   complete and the manual Preview validation checklist in
   docs/screen-share-evidence-v1.md has been run end-to-end at least once.

## Deployment procedure — `docs/cohort-collusion-graph-v1-migration.sql`

**Already applied — 2026-07-24, to the one shared Preview/Production
database. Do not run this file again.** The steps below are kept as a
historical record of the procedure that was followed.

Preview and Production currently share ONE Supabase database — apply
this file **once**, not once per environment.

1. Take a pre-migration backup of the shared database (Supabase project
   → Database → Backups, or a manual `pg_dump`) before applying anything.
2. Run the pre-check query embedded at the top of
   `docs/cohort-collusion-graph-v1-migration.sql` first, to confirm the
   migration has not already been applied.
3. Open the (shared) Supabase project → SQL Editor.
4. Paste and run sections 1-7 of the file (the five `CREATE TABLE`
   statements, then indexes, then foreign keys) — the file is already in
   execution order.
5. Run the file's own "Verification queries" section to confirm all five
   tables, their indexes, and their foreign keys landed, and that no
   existing table's columns changed.
6. Record the date in the Ledger table above (row 12) — a single date is
   sufficient given the shared database.
7. Do not run the manual Preview smoke test in
   docs/cohort-collusion-graph-v1.md against Production.
8. Do not apply this file a second time — re-running it after a
   successful apply will error.

### Rollback — `docs/cohort-collusion-graph-v1-migration.sql`

Additive-only, and touches no existing table, column, or row's data at
all:

- **All five new tables**: safe to drop, in child-to-parent order, if the
  feature must be fully removed —
  `DROP TABLE "CollusionClusterMember"; DROP TABLE "CollusionCluster"; DROP TABLE "CollusionSignal"; DROP TABLE "CollusionPairEdge"; DROP TABLE "CohortCollusionAnalysis";`
  — no other table has a foreign key pointing at any of these five (they
  only have OUTGOING foreign keys to `Exam`/`Submission`/`User`), so
  dropping them cannot cascade into unrelated data loss. This would
  permanently delete any recorded analyses, edges, signals, clusters, and
  lecturer review decisions on those clusters — export/audit first if
  that data must be retained.
- **Preferred approach in practice**: since no exam has this feature
  enabled unless a lecturer explicitly clicks "Run cohort integrity
  analysis" for it, the practical "rollback" for almost any issue is
  simply not running the analysis for any exam, rather than reverting the
  schema — the five new tables sitting empty/unused in the database have
  no functional effect on any other feature (SubmissionSimilarityAnalysis,
  TimingAnalysis, ExamAttemptSession/SessionIntegritySignal,
  NetworkEvidence, OralVerification all continue exactly as before).

## Rollback / forward-fix strategy

This migration is additive-only (new enum values, one new nullable
column, one new table) — nothing existing is dropped, renamed, or
constrained more tightly, so a full rollback is rarely necessary. If a
rollback is genuinely required:

- **New enum values** (`AI_ASSISTANCE_*`): Postgres cannot remove an enum
  value once added, even if unused. Rolling back the enum itself is not
  practical — leaving the unused values in place is safe (the application
  code simply never writes them if the feature is disabled) and is the
  recommended forward-fix over attempting an enum rebuild.
- **`Submission.aiAssistancePolicySnapshotJson`**: safe to drop
  (`ALTER TABLE "Submission" DROP COLUMN "aiAssistancePolicySnapshotJson";`)
  if the column must be removed — every application code path treats a
  missing/null value as DISABLED, so no other column depends on it.
- **`AiAssistanceInteraction`**: safe to drop
  (`DROP TABLE "AiAssistanceInteraction";`) — no other table has a
  foreign key pointing at it (it only has outgoing foreign keys to
  `Submission`/`Question`/`User`), so dropping it cannot cascade into
  unrelated data loss. This would permanently delete any recorded
  assistance interactions — export/audit first if that data must be
  retained.
- **Preferred approach in practice**: since the feature is disabled by
  default (`aiAssistanceMode: "DISABLED"` unless a lecturer explicitly
  opts in), the safer "rollback" for almost any issue is simply ensuring
  no exam has the feature enabled, rather than reverting the schema —
  the new column/table/enum values sitting unused in the database has no
  functional effect on any other feature.

### Rollback — `docs/screen-share-evidence-migration.sql`

Also additive-only, and touches no existing column/row's data:

- **New enum values** (`SCREEN_SHARE_*`): same as above — cannot be
  removed once added; leaving them unused is the recommended forward-fix.
- **`Submission.screenSharePolicySnapshotJson`**: safe to drop
  (`ALTER TABLE "Submission" DROP COLUMN "screenSharePolicySnapshotJson";`)
  — every application code path treats a missing/null value as OFF.
- **`IntegrityEvidenceAsset.clientRequestId`**: safe to drop
  (`DROP INDEX "IntegrityEvidenceAsset_clientRequestId_key"; ALTER TABLE "IntegrityEvidenceAsset" DROP COLUMN "clientRequestId";`)
  — every EXISTING camera evidence row already has this column NULL, and
  no application code reads it for camera evidence at all, so dropping it
  only affects the screen-share idempotency guarantee, not any stored
  data.
- Dropping either column does NOT remove any `IntegrityEvidenceAsset` rows
  already created with `kind = 'SCREEN_SHARE_EVIDENCE_FRAME'` — those
  would need a separate, explicit decision (and, if evidence frames must
  be deleted, corresponding calls to the storage adapter's `delete()` for
  each `storageKey`, not just a DB row delete, to avoid orphaned objects
  in the private evidence bucket).
- **Preferred approach in practice**: identical reasoning to the
  AI-assistance rollback above — since the feature defaults to
  `screenShareMode: "OFF"`, ensuring no exam has it enabled is the
  practical "rollback" for almost any issue, rather than reverting the
  schema.

## Deployment procedure — `docs/answer-development-provenance-v1-migration.sql`

**Already applied — 2026-07-25, to the one shared Preview/Production
database. Do not run this file again.** The steps below are kept as a
historical record of the procedure that was followed. See "Verification
— answer-development provenance migration" further below for the full
read-only confirmation record.

Preview and Production currently share ONE Supabase database — apply
this file **once**, not once per environment.

1. Take a pre-migration backup of the shared database (Supabase project
   → Database → Backups, or a manual `pg_dump`) before applying anything.
2. Run the pre-check query embedded at the top of
   `docs/answer-development-provenance-v1-migration.sql` first, to
   confirm the migration has not already been applied.
3. Open the (shared) Supabase project → SQL Editor.
4. Paste and run sections 1-8 of the file (the `ALTER TABLE` on
   `Submission`, then the five `CREATE TABLE` statements, then indexes,
   then foreign keys) — the file is already in execution order.
5. Run the file's own "Verification queries" section to confirm the new
   column, all five tables, their indexes, and their foreign keys
   landed, and that every existing `Submission` row's new column is NULL.
6. Record the date in the Ledger table above (row 13) — a single date is
   sufficient given the shared database.
7. Do not run the manual Preview smoke test in
   docs/answer-development-provenance-v1.md against Production — only
   against a disposable Preview/test database, per that document's own
   note (Preview and Production currently share one database).
8. Do not apply this file a second time — re-running it after a
   successful apply will error.

### Verification — answer-development provenance migration

Confirmed via read-only queries against the shared database on
2026-07-25, immediately after this migration was applied:

- All five Answer-Development Provenance tables exist:
  `AnswerDevelopmentVersion`, `AnswerDevelopmentEvent`,
  `AnswerDevelopmentArtifact`, `AnswerDevelopmentArtifactVersion`,
  `CodeExecutionEvent`.
- `Submission.answerProvenancePolicySnapshotJson` exists as a nullable
  `jsonb` column (`information_schema.columns`: `data_type = jsonb`,
  `is_nullable = YES`).
- Both partial unique indexes on `AnswerDevelopmentArtifact` exist with
  their correct `WHERE` clauses (confirmed via `pg_indexes.indexdef`,
  not just `indexname`, so they are genuinely partial, not plain,
  indexes):
  - `AnswerDevelopmentArtifact_answer_type_key` —
    `("answerId", "artifactType") WHERE ("answerId" IS NOT NULL)`.
  - `AnswerDevelopmentArtifact_submission_type_key` —
    `("submissionId", "artifactType") WHERE ("answerId" IS NULL)`.
- All five new tables contained **zero rows** immediately after
  migration — expected, since nothing writes to them until a student
  attempt actually enables and uses this feature.
- Every existing `Submission` row had
  `answerProvenancePolicySnapshotJson IS NULL` immediately after
  migration (`count(*) WHERE ... IS NOT NULL` returned 0) — no existing
  submission was retroactively affected; the feature remains OFF for
  every attempt until a lecturer explicitly enables it on a new attempt.

**This migration must not be applied again.**

### Rollback — `docs/answer-development-provenance-v1-migration.sql`

Additive-only, and touches no existing table's data at all beyond adding
one new nullable column:

- **All five new tables**: safe to drop, in child-to-parent order, if the
  feature must be fully removed —
  `DROP TABLE "AnswerDevelopmentArtifactVersion"; DROP TABLE "AnswerDevelopmentArtifact"; DROP TABLE "AnswerDevelopmentEvent"; DROP TABLE "AnswerDevelopmentVersion"; DROP TABLE "CodeExecutionEvent";`
  — no other table has a foreign key pointing at any of these five (they
  only have OUTGOING foreign keys to `Submission`/`Answer`/`Question`/
  `ExamAttemptSession`), so dropping them cannot cascade into unrelated
  data loss. This would permanently delete any recorded checkpoints,
  events, artifacts, and code-execution requests — export/audit first if
  that data must be retained.
- **`Submission.answerProvenancePolicySnapshotJson`**: safe to drop
  (`ALTER TABLE "Submission" DROP COLUMN "answerProvenancePolicySnapshotJson";`)
  — every application code path treats a missing/null value as OFF.
- **Preferred approach in practice**: since the feature defaults to
  `answerProvenanceMode: "OFF"`, ensuring no exam has it enabled is the
  practical "rollback" for almost any issue, rather than reverting the
  schema.

## Deployment procedure — `docs/secure-client-foundation-seb-v1-migration.sql`

**Already applied — 2026-07-25, to the one shared Preview/Production
database. Do not run this file again.** The steps below are kept as a
historical record of the procedure that was followed. See "Verification
— secure client foundation migration" further below for the full
read-only confirmation record.

Preview and Production currently share ONE Supabase database — this file
was applied **once**, not once per environment; there is no separate
Production application still pending, and it must not be applied a
second time to either environment.

1. Take a pre-migration backup of the shared database (Supabase project
   → Database → Backups, or a manual `pg_dump`) before applying anything.
2. Run the pre-check query embedded at the top of
   `docs/secure-client-foundation-seb-v1-migration.sql` first, to confirm
   the migration has not already been applied.
3. Open the (shared) Supabase project → SQL Editor.
4. Paste and run sections 1-10 of the file (the `ALTER TABLE` on
   `Submission`, then the seven `CREATE TABLE` statements, then indexes
   — including the two partial unique indexes — then foreign keys) — the
   file is already in execution order.
5. Run the file's own "Verification queries" section to confirm the new
   column, all seven tables, their indexes (including both partial
   unique indexes, confirmed via `pg_indexes.indexdef` showing their own
   `WHERE` clause), and their foreign keys landed, and that every
   existing `Submission` row's new column is NULL.
6. Record the date in the Ledger table above (row 14) — a single date is
   sufficient given the shared database.
7. Do not run the manual Preview smoke-test checklist in
   docs/secure-client-foundation-seb-v1.md against Production — only
   against a disposable Preview/test database or an isolated test
   institution, per that document's own note.
8. Do not enable Safe Exam Browser requirements, the mock Tether client
   simulator, or any non-default delivery mode on any real exam until the
   institutional pilot-readiness checklist in docs/pilot-readiness.md is
   complete.
9. Do not apply this file a second time — re-running it after a
   successful apply will error.

### Verification — secure client foundation migration

Confirmed via read-only queries against the shared database on
2026-07-25, immediately after this migration was applied. **Preview and
Production point at this same shared Supabase database — this migration
has now been applied to that one database and must not be applied
again, in either environment.**

- `Submission.secureClientPolicySnapshotJson` exists as a nullable
  `jsonb` column (`information_schema.columns`: `data_type = jsonb`,
  `is_nullable = YES`).
- All seven new secure-client tables exist: `SecureClientConfiguration`,
  `SebAllowedExamKey`, `SecureClientLaunchManifest`,
  `SecureClientSession`, `SecureClientAttestation`, `SecureClientEvent`,
  `SecureClientRecoveryGrant`.
- The active-configuration partial unique index exists with its correct
  `WHERE` clause (confirmed via `pg_indexes.indexdef`, not just
  `indexname`, so it is genuinely partial, not plain):
  `SecureClientConfiguration_exam_provider_active_key` —
  `("examId", provider) WHERE (status = 'ACTIVE'::text)`.
- The non-terminal-session partial unique index exists with its correct
  `WHERE` clause: `SecureClientSession_submission_nonterminal_key` —
  `("submissionId") WHERE (status <> ALL (ARRAY['ENDED'::text, 'REJECTED'::text]))`.
- `SebAllowedExamKey`'s encrypted-key columns match
  `prisma/schema.prisma` exactly — a single nullable `rawKeyCiphertext`
  `text` column (plus `keyHash text NOT NULL` for lookup), consistent
  with the packed-string format (`scv1:<keyId>:<ivHex>:<authTagHex>:<ciphertextHex>`)
  used by `src/lib/secureClient/sebKeyEncryption.ts` — no separate
  encryption-key-id/version column was needed in the schema itself.
- All seven new tables contained **zero rows** immediately after
  migration — expected, since nothing writes to them until a lecturer
  configures secure-client delivery and a student launches.
- Every existing `Submission` row had
  `secureClientPolicySnapshotJson IS NULL` immediately after migration
  (`count(*) WHERE ... IS NOT NULL` returned 0) — no existing submission
  was retroactively affected; every attempt remains STANDARD_WEB/disabled
  until a lecturer explicitly enables a stronger delivery mode on a new
  attempt.
- Foreign keys were verified: all 18 expected `FOREIGN KEY` constraints
  across the seven new tables exist with the documented
  `ON DELETE`/`ON UPDATE` behaviour (`CASCADE` from `Exam`/`Submission`,
  `RESTRICT`/`SET NULL` from `User` depending on nullability) — confirmed
  via `pg_constraint`/`pg_get_constraintdef`, matching
  `docs/secure-client-foundation-seb-v1-migration.sql` section 10
  exactly.

**This migration must not be applied again.**

### Rollback — `docs/secure-client-foundation-seb-v1-migration.sql`

Additive-only, and touches no existing table's data at all beyond adding
one new nullable column:

- **All seven new tables**: safe to drop, in child-to-parent order, if
  the feature must be fully removed —
  `DROP TABLE "SecureClientRecoveryGrant"; DROP TABLE "SecureClientEvent"; DROP TABLE "SecureClientAttestation"; DROP TABLE "SecureClientSession"; DROP TABLE "SecureClientLaunchManifest"; DROP TABLE "SebAllowedExamKey"; DROP TABLE "SecureClientConfiguration";`
  — no other table has a foreign key pointing at any of these seven (they
  only have OUTGOING foreign keys to `Exam`/`Submission`/`User`), so
  dropping them cannot cascade into unrelated data loss. This would
  permanently delete any recorded configurations, keys, launch
  manifests, sessions, attestations, events, and recovery grants —
  export/audit first if that data must be retained.
- **`Submission.secureClientPolicySnapshotJson`**: safe to drop
  (`ALTER TABLE "Submission" DROP COLUMN "secureClientPolicySnapshotJson";`)
  — every application code path treats a missing/null value as
  STANDARD_WEB / disabled.
- **Preferred approach in practice**: since the feature defaults to
  `deliveryMode: "STANDARD_WEB"` for every exam, ensuring no exam is
  switched to a SEB/Tether-required delivery mode is the practical
  "rollback" for almost any issue, rather than reverting the schema.

## Deployment procedure — `docs/sql/add-tether-secure-resume-recovery.sql`

**Already applied — 2026-08-02, to the one shared Preview/Production
Supabase database (project ref `ugckdvbjzauvcovcqebw`). Do not run this
file again.** The steps below are kept as a historical record of the
procedure that was followed. See "Verification — secure recovery
migration" further below for the full read-only confirmation record.

Preview and Production share ONE Supabase database — this file was
applied **once**, not once per environment; there is no separate
Production application still pending, and it must not be applied a
second time to either environment.

1. Took a pre-migration backup of the shared database (Supabase project
   → Database → Backups) before applying anything.
2. Ran the pre-check queries embedded at the top of
   `docs/sql/add-tether-secure-resume-recovery.sql` first, confirming the
   migration had not already been applied.
3. Confirmed row 14 (`docs/secure-client-foundation-seb-v1-migration.sql`)
   shows as applied above — this file's `recoveryOfSessionId` foreign key
   targets the `SecureClientSession` table that migration creates.
4. Opened the (shared) Supabase project → SQL Editor.
5. Pasted and ran the file's single `BEGIN` ... `COMMIT` block once — it
   is already in execution order (`SecureClientSession` columns + index +
   FK, then `Submission` columns + unique constraint, then `Answer`
   columns). No `prisma db push`, `prisma migrate dev`, `prisma migrate
   deploy`, or `prisma migrate resolve` command was used at any point —
   applied manually through the Supabase SQL Editor only, per this
   project's migration convention.
6. Ran the file's own "Post-application verification" queries to confirm
   all nine new columns, the index, and both constraints landed, and that
   every existing row's new columns are NULL/default (never
   retroactively populated).
7. Recorded the date in the Ledger table above (row 15) — a single date
   is sufficient given the shared database.
8. Do not enable/rely on any resume-recovery behaviour for a real exam
   until the institutional pilot-readiness checklist in
   docs/pilot-readiness.md is complete.
9. Do not apply this file a second time — re-running it after a
   successful apply is idempotent (every statement uses
   `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` guards) but is not expected
   to be necessary and should not be done deliberately.

### Verification — secure recovery migration

Confirmed via read-only queries against the shared Supabase database
(project ref `ugckdvbjzauvcovcqebw`) on 2026-08-02, immediately after
this migration was applied. **Preview and Production point at this same
shared Supabase database — this migration has now been applied to that
one database and must not be applied again, in either environment.**

- A full database backup was taken and confirmed completed before the
  migration was applied.
- The pre-application checks embedded at the top of
  `docs/sql/add-tether-secure-resume-recovery.sql` were run first and
  confirmed the migration had not already been applied (all pre-check
  queries returned zero rows).
- The migration was applied exactly once, manually, through the Supabase
  SQL Editor — the file's single `BEGIN` ... `COMMIT` block, run as one
  statement. No `prisma migrate` command and no `prisma db push` was run
  against this database at any point in this rollout.
- All nine new columns were verified present with the expected
  types/nullability/defaults (`information_schema.columns`):
  - `SecureClientSession`: `closedAt` (nullable `timestamp`),
    `closeReason` (nullable `text`), `recoveryOfSessionId` (nullable
    `text`).
  - `Submission`: `resumeCount` (`integer`, `NOT NULL`, default `0`),
    `lastResumedAt` (nullable `timestamp`),
    `lastAutosaveAcknowledgedAt` (nullable `timestamp`),
    `finalSubmissionRequestId` (nullable `text`).
  - `Answer`: `lastClientRequestId` (nullable `text`), `clientRevision`
    (nullable `integer`).
- The index was verified: `SecureClientSession_recoveryOfSessionId_idx`
  exists on `SecureClientSession("recoveryOfSessionId")`
  (`pg_indexes`).
- The self-referencing foreign key was verified:
  `SecureClientSession_recoveryOfSessionId_fkey` exists
  (`SecureClientSession."recoveryOfSessionId"` →
  `SecureClientSession."id"`, `ON DELETE SET NULL ON UPDATE CASCADE`)
  (`pg_constraint`).
- The unique constraint was verified:
  `Submission_finalSubmissionRequestId_key` exists on
  `Submission("finalSubmissionRequestId")` (`pg_constraint`).
- Every existing row's new columns were confirmed NULL/default
  immediately after migration (the file's own "Existing rows never
  retroactively populated" queries all returned `0`) — no existing
  `SecureClientSession`, `Submission`, or `Answer` row was retroactively
  affected, and row counts on all three tables were unchanged
  before/after.

**This migration must not be applied again.**

### Rollback — `docs/sql/add-tether-secure-resume-recovery.sql`

See the SQL file's own embedded "Rollback" section for the exact
`DROP COLUMN`/`DROP CONSTRAINT`/`DROP INDEX` statements. Additive-only,
touches no existing row's data — the practical rollback for almost any
issue is simply ensuring no exam relies on the new recovery behaviour
(every code path already treats a missing value as "no recovery history
on record"), rather than reverting the schema.

## Deployment procedure — `docs/sql/add-tether-windows-lockdown-hardening.sql`

**Already applied — 2026-08-05, to the one shared Preview/Production
Supabase database (project ref `ugckdvbjzauvcovcqebw`). Do not run this
file again.** The steps below are kept as a historical record of the
procedure that was followed. See "Verification — Windows lockdown
hardening migration" further below for the full read-only confirmation
record.

Preview and Production share ONE Supabase database — this file was
applied **once**, not once per environment; there is no separate
Production application still pending, and it must not be applied a
second time to either environment.

1. Took a current schema backup of the shared database (Supabase
   project → Database → Backups) before applying anything.
2. Attempted a fresh full data dump as an additional precaution — this
   could not be completed: the Supabase connection pooler repeatedly
   terminated the `pg_dump` process mid-run. The existing complete data
   backup from 2026-08-02 (taken immediately before the secure-recovery
   migration, row 15 above) was retained and treated as the operative
   data backup for this change, since this migration is additive-only
   (see "Verification" below) and never touches existing rows.
3. Ran the pre-check query embedded at the top of
   `docs/sql/add-tether-windows-lockdown-hardening.sql` — returned ZERO
   matching rows, confirming the migration had not already been applied.
4. Opened the (shared) Supabase project → SQL Editor.
5. Pasted and ran the file's five `ALTER TYPE ... ADD VALUE IF NOT
   EXISTS` statements once — order does not matter between them (each
   is independent), but the file is already in a sensible order. No
   `prisma db push`, `prisma migrate dev`, `prisma migrate deploy`, or
   `prisma migrate resolve` command was used at any point — applied
   manually through the Supabase SQL Editor only, per this project's
   migration convention.
6. Ran the file's own "Post-application verification" queries to
   confirm all five new enum values landed and that no existing
   `IntegrityEvent` row uses any of them yet.
7. Recorded the date in the Ledger table above (row 16) — a single date
   is sufficient given the shared database.
8. Do not apply this file a second time — re-running it after a
   successful apply is idempotent (`ADD VALUE IF NOT EXISTS`) but is not
   expected to be necessary and should not be done deliberately.

### Verification — Windows lockdown hardening migration

Confirmed via read-only queries against the shared Supabase database
(project ref `ugckdvbjzauvcovcqebw`) on 2026-08-05, immediately after
this migration was applied. **Preview and Production point at this same
shared Supabase database — this migration has now been applied to that
one database and must not be applied again, in either environment.**

- Pre-application check: the query embedded at the top of the SQL file
  (matching `enumlabel` against all five new value names) returned ZERO
  rows, confirming a clean, not-yet-applied state before proceeding.
- The migration was applied exactly once, manually, through the
  Supabase SQL Editor — the file's five `ALTER TYPE ... ADD VALUE IF NOT
  EXISTS` statements. No `prisma migrate` command and no `prisma db
  push` was run against this database at any point in this rollout.
- All five new `IntegrityEventType` enum values were verified present
  afterward (`pg_enum` query from the file's own "Post-application
  verification" section): `REMOTE_CONTROL_SOFTWARE_DETECTED`,
  `SCREEN_CAPTURE_SOFTWARE_DETECTED`, `DEBUGGING_TOOL_DETECTED`,
  `PROHIBITED_APPLICATION_DETECTED`, `PROHIBITED_APPLICATION_CLOSED`.
- No table, column, or row was modified — this migration only adds
  enum values to an existing type. The file's own row-count check
  (`count(*) FROM "IntegrityEvent" WHERE "eventType" IN (...)`)
  confirmed 0 existing rows use any of the five new values.
- A current schema backup was completed before applying anything. A
  fresh full data dump could not be completed — the Supabase connection
  pooler repeatedly terminated `pg_dump` mid-run — so the existing
  complete 2026-08-02 data backup was retained as the operative backup
  for this change; this is considered sufficient given the migration
  touches no existing data.
- The migration is additive and forward-only: Postgres has no operation
  to remove an enum value once added, so there is no rollback path back
  to a schema without these five values — only a forward fix (simply
  not shipping application code that writes them). See "Rollback"
  immediately below.

**This migration must not be applied again.**

### Rollback — `docs/sql/add-tether-windows-lockdown-hardening.sql`

See the SQL file's own embedded "Rollback" section. Postgres cannot
remove an enum value once added — leaving the five unused values in
place is safe and is the recommended forward-fix; the practical rollback
for almost any issue is simply not shipping the application code that
writes them, rather than attempting an enum rebuild.

## Deployment procedure — `docs/sql/repair-installation-attestation-foundation.sql`

**Already applied — 2026-08-06, to the one shared Preview/Production
Supabase database (project ref `ugckdvbjzauvcovcqebw`). Do not run this
file again.** The steps below are kept as a historical record of the
procedure that was followed. See "Verification — installation
attestation foundation repair" further below for the full read-only
confirmation record.

Preview and Production share ONE Supabase database — this file was
applied **once**, not once per environment; there is no separate
Production application still pending, and it must not be applied a
second time to either environment.

**Supersedes the earlier, narrower
`docs/sql/repair-secure-client-session-installation-fields.sql`, which
has been deleted from the repository.** That file's entire scope (six
`SecureClientSession` columns) is Block 5 of this file, byte-for-byte;
it could not actually be applied on its own because its foreign key
depends on `TetherClientInstallation`, a table which turned out to be
missing too (see "Incident and root cause" below) — this file resolves
that dependency instead of working around it.

### Incident and root cause

Production began failing with Prisma error P2022
(`SecureClientSession.clientInstallationId does not exist in the
current database`). A first read-only check confirmed six
`SecureClientSession` columns were missing (see row 15/16's own history
— unrelated to either of those, confirmed by inspecting
`docs/sql/add-tether-secure-resume-recovery.sql` line by line, which
never touches any installation-attestation column). Follow-up live
evidence then showed `SELECT to_regclass('public."TetherClientInstallation"')`
returns NULL — the table that repair's foreign key depended on does not
exist either — and that the six tables currently visible in production
related to secure-client/Tether functionality are `SecureClientAttestation`,
`SecureClientConfiguration`, `SecureClientEvent`,
`SecureClientLaunchManifest`, `SecureClientRecoveryGrant`, and
`SecureClientSession` — none of `TetherClientInstallation`,
`TetherInstallationRegistrationChallenge`,
`SystemCheckSecureClientVerification`, or `TetherSystemCheckRun` appear.

Auditing every `docs/sql/*.sql` file against `prisma/schema.prisma`
identified **five** files, all written 2026-07-30 through 2026-08-01 as
part of "Tether System Check and Exam Readiness v1" / "Secure Client
Attestation v2" (see docs/tether-system-check-v1.md), that were **never
applied to any environment and were never added to this ledger at
all** — no row referenced any of them before this one:

- `docs/sql/add-tether-client-installation.sql` — creates
  `TetherClientInstallation`.
- `docs/sql/add-tether-installation-registration-challenge.sql` —
  creates `TetherInstallationRegistrationChallenge`.
- `docs/sql/add-system-check-secure-client-verification.sql` — creates
  `SystemCheckSecureClientVerification`.
- `docs/sql/add-tether-system-check-readiness.sql` — creates
  `TetherSystemCheckRun`.
- `docs/sql/add-secure-client-session-installation-attestation.sql` —
  ALTERs the existing `SecureClientSession` table (the six columns from
  the original incident).

Individual per-object read-only verification (not just a table-level
check) is required before applying — see "Exact Supabase pre-check
procedure" below — because table absence alone does not prove every
object from a given file is absent (e.g. a column could have been added
by some other means without its table's other objects existing, or vice
versa); the pre-check section embedded in the repair file itself checks
every table, column, index, and foreign key individually.

### Dependency graph and required application order

Every one of the five files' own foreign keys targets either the
baseline `User` table (already present) or, for exactly one file,
`TetherClientInstallation` — there is no other cross-file dependency:

- **`add-tether-client-installation.sql`** → depends only on `User`.
- **`add-tether-installation-registration-challenge.sql`** → depends
  only on `User`. (Its own header states "apply after
  add-tether-client-installation.sql," but its actual foreign key
  targets `User`, never `TetherClientInstallation` — a documentation
  imprecision in the original file, not a functional dependency.)
- **`add-system-check-secure-client-verification.sql`** → depends only
  on `User`. Its `installationId` column is an advisory pointer with NO
  foreign key (matching this schema's existing
  `clientInstallationIdHash`-style convention).
- **`add-tether-system-check-readiness.sql`** → depends only on `User`.
  Its `secureClientSessionId` column is likewise advisory, no foreign
  key.
- **`add-secure-client-session-installation-attestation.sql`** →
  depends on `User` (indirectly, `SecureClientSession` already existing)
  **and genuinely, non-advisorily, on `TetherClientInstallation`** — its
  `clientInstallationId` foreign key will fail if that table is absent.
  This is the one real cross-file ordering constraint in the whole
  rollout.

Required order: `add-tether-client-installation.sql` **before**
`add-secure-client-session-installation-attestation.sql`; the other
three files have no ordering constraint relative to any other file. No
Postgres enum types and no check constraints are introduced by any of
the five files — every "enum-like" column (`status`,
`keyProtectionLevel`, `purpose`, `verificationStatus`, `clientType`,
`overallStatus`, `sourceClientType`) is a plain, application-validated
`TEXT` column, matching this codebase's established "validated string,
not a Prisma enum" convention. No data backfill is required or
performed anywhere — every new table starts empty and every new column
on the pre-existing `SecureClientSession` table is NULL or its
documented safe default for every existing row.

### Assessment of the five original files (additive / idempotent / safe / ordering / non-destructive)

All five are additive-only (`CREATE TABLE IF NOT EXISTS` /
`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / a
guarded-`DO`-block pattern for every foreign key), idempotent, and
contain no `DROP`, `RENAME`, `TRUNCATE`, or table-rewriting statement —
each is safe to re-run after a successful apply (a no-op) and safe if
some, but not all, of its own objects already exist. Four of the five
(`add-tether-client-installation.sql`,
`add-tether-installation-registration-challenge.sql`,
`add-system-check-secure-client-verification.sql`,
`add-tether-system-check-readiness.sql`) are also fully safe to apply
**standalone**, in any order relative to each other, on the current
production database. The fifth
(`add-secure-client-session-installation-attestation.sql`) is **not**
safe to apply standalone against the current production database — its
own header correctly documents the `TetherClientInstallation`
dependency, but attempting it alone (as the narrower repair this file
supersedes would have) fails with a foreign-key error, since that table
does not currently exist.

`docs/sql/repair-installation-attestation-foundation.sql` reproduces
all five files' statements unmodified in content, applied in the
required dependency order (the four independent table-creation files,
then the `SecureClientSession` alteration last), each in its own
`BEGIN...COMMIT` block mirroring how each source file was already
independently transactional — every statement used (`CREATE TABLE`,
`ALTER TABLE ADD COLUMN`, `CREATE INDEX`) is transaction-safe in
Postgres (never `CREATE INDEX CONCURRENTLY`, which Postgres disallows
inside a transaction block).

### Exact Supabase pre-check procedure

Run every query in the "Pre-application verification" section at the
top of `docs/sql/repair-installation-attestation-foundation.sql` and
review every result before proceeding — do not assume any single query
result implies another. In order:

1. Four `to_regclass` table-existence checks (expect NULL for all four
   new tables).
2. The `SecureClientSession` installation-attestation column check
   (expect zero rows).
3. The `SecureClientSession` baseline-column sanity check (expect three
   rows — confirms the table itself and row 14's migration are intact).
4. The combined index-name check across all five files' seventeen
   indexes (expect zero rows).
5. The combined foreign-key-name check across all five files' five
   foreign keys (expect zero rows).

If any query returns an unexpected result (an object already present
that this file would also try to create), **stop and investigate before
applying** — `IF NOT EXISTS` guards mean this file will silently skip
an existing object of the same name without checking whether its shape
matches what is expected here.

### Procedure

1. Took a current schema backup of the shared database (Supabase
   project → Database → Backups) before applying anything.
2. Ran the full pre-check procedure above and reviewed every result.
3. Opened the (shared) Supabase project → SQL Editor.
4. Pasted and ran the file's five sequential `BEGIN...COMMIT` blocks, in
   the order they appear in the file (Blocks 1-4 independently, then
   Block 5 last) — through the Supabase SQL Editor only. No `prisma db
   push`, `prisma migrate dev`, `prisma migrate deploy`, or `prisma
   migrate resolve` command was used at any point.
5. Ran the file's own "Post-application verification" queries and
   confirmed all four tables, all six `SecureClientSession` columns, all
   seventeen indexes, and all five foreign keys landed, and that every
   existing row was untouched (every new table empty, every existing
   `SecureClientSession` row's new columns NULL/false).
6. Recorded the date in the Ledger table above (row 17) — a single date
   is sufficient given the shared database.
7. Do not apply this file a second time — re-running it after a
   successful apply is idempotent but is not expected to be necessary
   and should not be done deliberately.

### Verification — installation attestation foundation repair

Confirmed via read-only queries against the shared Supabase database
(project ref `ugckdvbjzauvcovcqebw`) on 2026-08-06, immediately after
this repair was applied. **Preview and Production point at this same
shared Supabase database — this repair has now been applied to that one
database and must not be applied again, in either environment.**

- The repair was applied exactly once, manually, through the Supabase
  SQL Editor — the file's five sequential `BEGIN...COMMIT` blocks. No
  `prisma migrate` command and no `prisma db push` (nor `migrate
  deploy`, `migrate resolve`, or `migrate dev`) was run against this
  database at any point in this rollout.
- All four new tables were verified created (`to_regclass`):
  `TetherClientInstallation`, `TetherInstallationRegistrationChallenge`,
  `SystemCheckSecureClientVerification`, and `TetherSystemCheckRun`.
- All six `SecureClientSession` installation-attestation columns were
  verified present (`information_schema.columns`): `clientInstallationId`
  (`text`), `installationAttestationVerified` (`boolean`, `NOT NULL`,
  default `false`), `installationAttestationVerifiedAt`
  (`timestamp(3)`), `installationAttestationFailureReason` (`text`),
  `installationVerificationId` (`text`), and `attestationRequirement`
  (`text`).
- All seventeen repair-related indexes were verified present
  (`pg_indexes`), spanning all four new tables plus
  `SecureClientSession_clientInstallationId_idx` on the existing table.
- All five repair-related foreign keys were verified present
  (`pg_constraint`): `TetherClientInstallation_userId_fkey`,
  `TetherInstallationRegistrationChallenge_userId_fkey`,
  `SystemCheckSecureClientVerification_userId_fkey`,
  `TetherSystemCheckRun_userId_fkey`, and
  `SecureClientSession_clientInstallationId_fkey`.
- `SecureClientSession.clientInstallationId` was confirmed to reference
  `TetherClientInstallation.id`, with `ON DELETE SET NULL ON UPDATE
  CASCADE` — verified via the exact clause on
  `SecureClientSession_clientInstallationId_fkey`.
- No existing `SecureClientSession` row required cleanup: the file's own
  "no existing row retroactively verified or assigned a requirement"
  queries both returned 0 (no row has `installationAttestationVerified
  = true`, and no row has any of the six new columns non-NULL/non-default).
- No existing data row was deleted or rewritten anywhere in this
  rollout — every new table was confirmed empty immediately after
  applying, and `SecureClientSession`/`User`/`Submission` row counts
  were identical before and after.
- The production Prisma P2022 failure
  (`SecureClientSession.clientInstallationId does not exist`) is
  resolved.
- End-to-end confirmation after the repair: attempting to access a
  Tether-required examination directly in Chrome (outside the Tether
  Secure Browser) was correctly blocked, exactly as the existing
  installation-attestation/lockdown enforcement is designed to behave —
  confirming the repair restored the schema this enforcement depends on
  without otherwise changing its behavior.

**This repair must not be applied again.**

### Rollback — `docs/sql/repair-installation-attestation-foundation.sql`

See the SQL file's own embedded "Rollback" section (reverse dependency
order — Block 5's foreign key/columns before Block 1's table).
Additive-only, touches no existing row's data — every application code
path already treats a missing/null value on any of these objects as "no
v2 attestation evidence on record yet" (resolveEffectiveTetherVerification
in src/lib/tetherAttestationConfig.ts falls back to LEGACY when
`attestationRequirement` is NULL), which is exactly the state
production has been running in. Dropping anything after applying it
would simply restore the P2022 failure this file exists to repair —
there is no practical scenario where that is the right move.

## Deployment procedure — `docs/tether-preflight-lifecycle-v1.7.4-migration.sql`

**APPLIED ONCE — 2026-08-11, to the shared Preview/Production Supabase
database. Do not re-apply.** Unlike every prior file in this
ledger, this one includes a one-time data backfill (Block 2) AND a
database-level default set after the backfill (Block 3), alongside the
additive schema change (Block 1) — see the SQL file's own header for the
full safety analysis of why that's required and why it's still safe to
apply to a live database ahead of the v1.7.4 code deploy. Block 3 exists
specifically to close the zero-downtime cutover race: without it, a
Submission row created by the OLD (pre-v1.7.4) application code between
"migration applied" and "v1.7.4 code deployed" would land on
`activatedAt IS NULL` — indistinguishable from a genuine v1.7.4
PREPARING attempt — and be incorrectly blocked (403 `EXAM_NOT_ACTIVATED`)
the moment v1.7.4 code takes over, even mid-exam. Do NOT apply Block 1
with a default already attached, and do NOT apply Block 3 before Block
2 — see the SQL file's "WHY BLOCK 3 MUST COME AFTER BLOCK 2" note (a
volatile default set before backfilling stamps every existing row with
the migration's own run time, destroying each row's real `startedAt`).

### Preview

1. Run the read-only pre-check query (top of the SQL file) against the
   Preview database first, to confirm the migration has not already
   been partially applied.
2. Note the current `SELECT count(*) FROM "Submission";` — used to
   confirm no row is created/deleted by this migration (Verification
   query 4).
3. Open the Preview Supabase project → SQL Editor.
4. Paste and run Block 1 (`ALTER TABLE ... ADD COLUMN "activatedAt"`),
   then Block 2 (the backfill `UPDATE`), then Block 3
   (`ALTER COLUMN ... SET DEFAULT CURRENT_TIMESTAMP`) — the file is
   already in execution order; run them strictly in that order, not out
   of sequence.
5. Run all five "Verification queries" at the bottom of the SQL file.
   Query 2 (`count(*) WHERE "activatedAt" IS NULL`) MUST return 0
   immediately after this step; Query 5 (`column_default`) MUST show
   the default is set — if either doesn't hold, STOP and investigate
   before deploying any v1.7.4 code; do not proceed to production.
6. Record the date in the Ledger table above (row 18, "Preview applied").
7. Only after this is confirmed clean should the v1.7.4 web/server
   application code be deployed to Preview (see
   docs/tether-preflight-lifecycle-v1.7.4.md's deployment-order section)
   — never before.

### Production

Only after Preview has been verified (and, ideally, briefly smoke-tested
with the v1.7.4 code running against it):

1. Run the same pre-check and row-count queries against **production**
   first.
2. Open the **production** Supabase project → SQL Editor (double-check
   you are pointed at production, not Preview — though as of this
   ledger's own topology note, they are currently the same database, so
   this step is likely already done by the Preview steps above).
3. Apply the same three blocks, in the same order, the same way. Do not
   skip Block 3 and do not reorder it ahead of Block 2.
4. Re-run all five verification queries against production. Query 2
   must return 0; Query 5 must show the default is set.
5. Record the date in the Ledger table above (row 18, "Production
   applied").
6. Once Block 3 (the default) is confirmed live in production, the
   cutover window is safe: the OLD application code may continue
   running and creating Submission rows indefinitely with no risk of an
   ambiguous NULL, for as long as needed before the v1.7.4 code deploy
   actually happens.
7. Only after this is confirmed clean should the v1.7.4 web/server
   application code be deployed to production, followed by publishing
   the v1.7.4 native installer, followed by physical validation, and
   only then promoting v1.7.4 to the normal recommended download — see
   docs/tether-preflight-lifecycle-v1.7.4.md's full deployment-order
   checklist. Do not skip ahead to publishing the installer or
   promoting the version before the code deploy is confirmed healthy.

### Verification — activatedAt zero-downtime cutover migration

Applied and verified in the shared Preview/Production Supabase database
on 2026-08-11 by the operator running the migration's own three blocks
through the Supabase SQL Editor, per the "Production" procedure above.
**Preview and Production point at this same shared database — this
migration has now been applied to that one database and must not be
applied again, in either environment.**

- All three blocks applied, in order, exactly once: `ADD COLUMN
  "activatedAt"` (no default), the backfill `UPDATE ... WHERE
  "activatedAt" IS NULL`, then `ALTER COLUMN ... SET DEFAULT
  CURRENT_TIMESTAMP`. No `prisma migrate` or `prisma db push` command
  was run against this database.
- Existing rows backfilled: every pre-existing `Submission` row now has
  `activatedAt` equal to its own `startedAt` (Verification query 3 in
  the SQL file — the backfill copies each row's own historical value,
  never a single shared timestamp).
- Zero NULL rows immediately after migration: Verification query 2
  (`count(*) FROM "Submission" WHERE "activatedAt" IS NULL`) returned 0
  immediately after the backfill completed — no historical row was left
  unbackfilled.
- Database default confirmed: Verification query 5
  (`information_schema.columns.column_default` for
  `Submission.activatedAt`) confirms `CURRENT_TIMESTAMP` is set — this
  is the zero-downtime guarantee itself: any Submission row the OLD
  (pre-v1.7.4) application code creates from this point forward gets a
  non-null `activatedAt` automatically, so it can never be misread as an
  ambiguous PREPARING row once v1.7.4 code goes live.
- Row count unaffected: Verification query 4 confirms no row was created
  or deleted by this migration.
- Sequencing confirmed: this migration was applied **before** the
  v1.7.4 web/server application code has been deployed to any
  environment (see docs/tether-preflight-lifecycle-v1.7.4.md's
  "Production rollout order", step 1) — the application code deploy,
  native installer publication, physical validation, and promotion to
  the recommended download (steps 2-6) have not yet occurred.
