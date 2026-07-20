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

-- Do the four new IntegrityEventType enum values already exist?
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'IntegrityEventType'::regtype
  AND enumlabel IN (
    'AI_ASSISTANCE_USED',
    'AI_ASSISTANCE_REQUEST_BLOCKED',
    'AI_ASSISTANCE_LIMIT_REACHED',
    'AI_ASSISTANCE_RESPONSE_REGENERATED'
  );

-- Full current enum value list, for a manual diff against prisma/schema.prisma:
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'IntegrityEventType'::regtype
ORDER BY enumsortorder;
```

Interpretation:
- All five targeted queries return no rows → `docs/ai-brainstorming-assistance-migration.sql`
  has not been applied yet; safe to apply.
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
| 1 | `docs/answer-similarity-migration.sql` | Answer Similarity Review v1 | not tracked (predates ledger) | not tracked (predates ledger) | Bundled in the repository's initial commit |
| 2 | `docs/answer-activity-telemetry-migration.sql` | Exam Session Binding + Time Anomaly Review v1 | not tracked (predates ledger) | not tracked (predates ledger) | Bundled in the repository's initial commit |
| 3 | `docs/exam-session-binding-migration.sql` | Exam Session Binding v1 | not tracked (predates ledger) | not tracked (predates ledger) | Bundled in the repository's initial commit |
| 4 | `docs/evidence-frame-migration.sql` | On-Device AI Camera Integrity Detection v1 — Evidence Frames | not tracked (predates ledger) | not tracked (predates ledger) | |
| 5 | `docs/one-question-delivery-migration.sql` | One-Question-At-A-Time Exam Delivery v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 6 | `docs/question-pools-migration.sql` | Question Pools v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 7 | `docs/ai-use-review-migration.sql` | AI-Use Answer Review v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 8 | `docs/exam-policy-evidence-review-migration.sql` | Exam Design Policy + Evidence Review v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 9 | `docs/question-navigator-migration.sql` | Question Navigator v1 | not tracked (predates ledger) | not tracked (predates ledger) | |
| 10 | `docs/ai-brainstorming-assistance-migration.sql` | Controlled AI Brainstorming Assistance v1 | **PENDING — not yet applied** | **PENDING — not yet applied** | See "Deployment procedure" below. This was NOT applied as part of this repair task — see the final report for why. |

Rows 1-9 predate this ledger's creation, so their actual apply dates are
not recorded here — an operator who has applied them should backfill the
real dates. Row 10 (this feature) is the first entry created alongside
its own migration file and should be kept accurate going forward: fill in
the real date the moment the file is actually run against each
environment.

## Deployment procedure — `docs/ai-brainstorming-assistance-migration.sql`

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
