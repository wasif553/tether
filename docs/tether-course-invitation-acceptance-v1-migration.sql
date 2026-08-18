-- Tether Course Invitation + Acceptance v1 (additive) — see
-- docs/tether-course-invitation-acceptance-v1.md and
-- prisma/schema.prisma's CourseEnrollmentInvitation model for the full
-- field-by-field documentation.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- (which always emits CREATE TABLE for every table since it diffs
-- against nothing), hand-extracted to just the ONE new table this
-- feature adds. Additive only — no existing table, column, constraint,
-- row, or enum value is changed or removed.
--
-- New table: CourseEnrollmentInvitation — one row per (courseId,
-- studentId) pair, connecting a self-service STUDENT
-- (User.institutionId: null) to a lecturer's course/institution ONLY
-- after that student's own explicit acceptance. Bound to an exact
-- existing studentId, never a raw email string. Only a SHA-256 hash of
-- the invitation token is ever stored (tokenHash, nullable — cleared
-- after acceptance since the secret is no longer needed); the plaintext
-- is never persisted anywhere. No diagnosis, password, or other
-- sensitive field exists on this table.
--
-- IMPORTANT — shared database: Preview and Production currently point at
-- the SAME Supabase database (see docs/migration-ledger.md). This
-- migration must be applied ONCE, not once per environment. Run the
-- pre-check query below first; if it already shows the table applied,
-- do not re-run this file.
--
-- Apply via a direct database connection (see docs/migration-ledger.md
-- row 20 for the established precedent) or the Supabase SQL Editor. Do
-- NOT run `prisma db push`, `prisma migrate deploy`, `prisma migrate
-- dev`, or `prisma migrate resolve`.
--
-- Idempotency: this file is NOT idempotent — it is a ONE-TIME script.
-- Re-running it after a successful apply will error ("relation already
-- exists"). Run the pre-check query first.
--
-- Expand-first rollout: safe to apply BEFORE the application code from
-- this feature is deployed — it only creates a new, currently-unused
-- table. Old application code has no idea this table exists and never
-- queries it, so applying it early causes zero behaviour change until
-- the new application code (which reads/writes it) is deployed
-- afterwards.
--
-- No backfill, no destructive change: existing Course/CourseEnrollment/
-- User rows are completely untouched by this migration.

-- ============================================================================
-- 0. Pre-check (read-only) — run BEFORE applying anything below, to
--    confirm this migration has not already been applied to this
--    database (remember: Preview and Production are the SAME database).
-- ============================================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'CourseEnrollmentInvitation';
-- No rows → safe to apply. A row → this migration has already run;
-- investigate before re-applying anything.

-- ============================================================================
-- 1. CreateTable: CourseEnrollmentInvitation
-- ============================================================================
CREATE TABLE "CourseEnrollmentInvitation" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseEnrollmentInvitation_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 2. CreateIndex
-- ============================================================================
CREATE INDEX "CourseEnrollmentInvitation_studentId_idx" ON "CourseEnrollmentInvitation"("studentId");
CREATE INDEX "CourseEnrollmentInvitation_invitedById_idx" ON "CourseEnrollmentInvitation"("invitedById");
CREATE UNIQUE INDEX "CourseEnrollmentInvitation_courseId_studentId_key" ON "CourseEnrollmentInvitation"("courseId", "studentId");

-- ============================================================================
-- 3. AddForeignKey
-- ============================================================================
ALTER TABLE "CourseEnrollmentInvitation" ADD CONSTRAINT "CourseEnrollmentInvitation_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourseEnrollmentInvitation" ADD CONSTRAINT "CourseEnrollmentInvitation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourseEnrollmentInvitation" ADD CONSTRAINT "CourseEnrollmentInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. The new table exists (expect 1 row):
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'CourseEnrollmentInvitation';

-- 2. Exact column shape matches prisma/schema.prisma (10 columns):
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'CourseEnrollmentInvitation'
--   ORDER BY ordinal_position;

-- 3. No existing table was altered — this migration adds zero columns to
--    Course, User, or any other pre-existing table (all three relations
--    are foreign keys living entirely on the new table):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Course' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'User' ORDER BY ordinal_position;

-- 4. Zero rows exist immediately after migration (nothing writes to this
--    table until a lecturer explicitly creates an invitation):
-- SELECT count(*) FROM "CourseEnrollmentInvitation";

-- 5. Indexes and unique constraint landed as expected (expect 3 rows —
--    two plain indexes plus the composite unique index):
-- SELECT indexname FROM pg_indexes WHERE tablename = 'CourseEnrollmentInvitation';

-- 6. All three foreign keys landed with the documented ON DELETE
--    behaviour (CASCADE from Course/student User, RESTRICT from
--    invitedBy User — mirrors ExamTimeAccommodation.createdById's
--    RESTRICT convention, so an inviting lecturer's own account can
--    never be deleted out from under an invitation record without an
--    explicit decision about what happens to it):
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
--   FROM pg_constraint
--   WHERE conrelid = '"CourseEnrollmentInvitation"'::regclass AND contype = 'f';

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. This feature is entirely new and
-- additive: every existing Course/CourseEnrollment/User/Exam/Submission
-- row is completely unaffected (no column was added to any of them). No
-- student's institutionId is touched by this migration — it only ever
-- changes later, when a student explicitly accepts an invitation created
-- through the new application code.
--
-- Every EXISTING and IN-PROGRESS Submission row is unaffected: this
-- migration touches only a brand-new, currently-empty table.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time — but per the operating rules for
-- this feature, it must NOT be applied without explicit authorization.
