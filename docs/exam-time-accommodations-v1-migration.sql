-- Individual Exam Timing & Accommodations v1 (additive) — see
-- src/lib/examTimeAccommodation.ts and prisma/schema.prisma's
-- ExamTimeAccommodation model for the full field-by-field documentation.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the ONE new table this feature adds (the
-- --from-empty diff always emits CREATE TABLE for every table since it
-- diffs against nothing). Additive only — no existing table, column,
-- constraint, or enum value is changed or removed. No new Prisma enum
-- was introduced: adjustmentMode is a plain, application-validated TEXT
-- column, matching this codebase's established "validated string, not a
-- Prisma enum" convention (see e.g. SecureClientSession.status/purpose).
--
-- New table: ExamTimeAccommodation — one row per (exam, student) pair,
-- storing only the operational timing adjustment needed to deliver the
-- exam (adjustmentMode + adjustmentValue). No diagnosis, disability
-- type, medical condition, plan document, or free-text reason column
-- exists anywhere in this table, by design — see
-- prisma/schema.prisma's own comment on the model.
--
-- IMPORTANT — shared database: Preview and Production currently point at
-- the SAME Supabase database (see docs/migration-ledger.md). This
-- migration must be applied ONCE, not once per environment. Run the
-- pre-check query below first; if it already shows the table applied,
-- do not re-run this file.
--
-- Apply via the Supabase SQL Editor (or `psql`). Do NOT run
-- `prisma db push`, `prisma migrate deploy`, `prisma migrate dev`, or
-- `prisma migrate resolve`.
--
-- Idempotency: this file is NOT idempotent — it is a ONE-TIME script.
-- Re-running it after a successful apply will error ("relation already
-- exists"). Run the pre-check query first.
--
-- Expand-first rollout: this migration is safe to apply BEFORE the
-- application code from this feature is deployed — it only creates a new,
-- currently-unused table. Old application code has no idea this table
-- exists and never queries it, so applying it early causes zero behaviour
-- change until the new application code (which reads/writes it) is
-- deployed afterwards.
--
-- THIS MIGRATION HAS NOT BEEN APPLIED TO ANY ENVIRONMENT. Do not apply it
-- without explicit authorization — see docs/migration-ledger.md.

-- ============================================================================
-- 0. Pre-check (read-only) — run BEFORE applying anything below, to
--    confirm this migration has not already been applied to this
--    database (remember: Preview and Production are the SAME database).
-- ============================================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'ExamTimeAccommodation';
-- No rows → safe to apply. A row → this migration has already run;
-- investigate before re-applying anything.

-- ============================================================================
-- 1. CreateTable: ExamTimeAccommodation — one row per (exam, student)
--    pair. Resolved ONLY when a student's NEW attempt starts (see
--    POST /api/exams/[id]/start) — the resolved effective duration is
--    then frozen into that attempt's own immutable
--    Submission.examPolicySnapshotJson.timingPolicy and never re-read
--    from this table again for that attempt. Editing or deleting a row
--    here never changes an attempt that has already started.
-- ============================================================================
CREATE TABLE "ExamTimeAccommodation" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "adjustmentMode" TEXT NOT NULL,
    "adjustmentValue" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamTimeAccommodation_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 2. CreateIndex
-- ============================================================================
CREATE INDEX "ExamTimeAccommodation_examId_idx" ON "ExamTimeAccommodation"("examId");
CREATE INDEX "ExamTimeAccommodation_studentId_idx" ON "ExamTimeAccommodation"("studentId");
CREATE UNIQUE INDEX "ExamTimeAccommodation_examId_studentId_key" ON "ExamTimeAccommodation"("examId", "studentId");

-- ============================================================================
-- 3. AddForeignKey
-- ============================================================================
ALTER TABLE "ExamTimeAccommodation" ADD CONSTRAINT "ExamTimeAccommodation_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamTimeAccommodation" ADD CONSTRAINT "ExamTimeAccommodation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamTimeAccommodation" ADD CONSTRAINT "ExamTimeAccommodation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. The new table exists (expect 1 row):
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'ExamTimeAccommodation';

-- 2. Exact column shape matches prisma/schema.prisma (8 columns):
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'ExamTimeAccommodation'
--   ORDER BY ordinal_position;

-- 3. No existing table was altered — this migration adds zero columns to
--    Exam, User, or any other pre-existing table (both new relations are
--    back-relations only, with no underlying column of their own — the
--    foreign keys live entirely on the new table):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Exam' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'User' ORDER BY ordinal_position;

-- 4. Zero rows exist immediately after migration (nothing writes to this
--    table until a lecturer explicitly creates an accommodation):
-- SELECT count(*) FROM "ExamTimeAccommodation";

-- 5. Indexes and unique constraint landed as expected (expect 3 rows —
--    two plain indexes plus the composite unique index):
-- SELECT indexname FROM pg_indexes WHERE tablename = 'ExamTimeAccommodation';

-- 6. All three foreign keys landed with the documented ON DELETE
--    behaviour (CASCADE from Exam/student User, RESTRICT from
--    createdBy User — mirrors ExamAssignment's own studentId CASCADE,
--    while createdById is RESTRICT so a lecturer's own account can never
--    be deleted out from under an accommodation they created without an
--    explicit decision about what happens to it):
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
--   FROM pg_constraint
--   WHERE conrelid = '"ExamTimeAccommodation"'::regclass AND contype = 'f';

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. This feature is entirely new and
-- additive: every existing Exam/Submission/User row is completely
-- unaffected (no column was added to any of them). No exam has ever had
-- an ExamTimeAccommodation row before this migration, so there is
-- nothing to reconcile.
--
-- Every EXISTING and IN-PROGRESS Submission row is unaffected: this
-- table is read only at the moment a NEW attempt is created (POST
-- /api/exams/[id]/start), never for the resume path (an existing
-- IN_PROGRESS submission is returned as-is, with no re-computation), and
-- never retroactively. A student who is already mid-exam when this
-- migration is applied is completely unaffected regardless of whether a
-- lecturer later adds, edits, or removes an accommodation row for them —
-- their already-frozen examPolicySnapshotJson.timingPolicy.durationMins
-- governs their attempt exactly as it did before this migration.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time — but per the operating rules for
-- this feature, it must NOT be applied without explicit authorization.
