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

**Confirmed applied — do not re-apply.** As of 2026-08-05, the following
eight migration files have each been applied exactly once to the one
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
