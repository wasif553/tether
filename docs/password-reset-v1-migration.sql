-- Password Reset v1 (additive) — see docs/password-reset-v1.md and
-- prisma/schema.prisma's PasswordResetToken model for the full
-- field-by-field documentation.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- (which always emits CREATE TABLE for every table since it diffs
-- against nothing), hand-extracted to just the ONE new table this
-- feature adds. Additive only — no existing table, column, constraint,
-- row, or enum value is changed or removed.
--
-- New table: PasswordResetToken — one row per issued forgot-password
-- link. Only a SHA-256 hash of the token is ever stored (tokenHash,
-- UNIQUE); the plaintext is never persisted anywhere. `consumedAt` is
-- null until the token is used (or invalidated by a later successful
-- reset for the same user), at which point it is set exactly once via an
-- atomic conditional UPDATE — see src/lib/passwordReset.ts. No password,
-- diagnosis, or other sensitive field beyond the hash exists on this
-- table.
--
-- IMPORTANT — shared database: Preview and Production currently point at
-- the SAME Supabase database (see docs/migration-ledger.md). This
-- migration must be applied ONCE, not once per environment. Run the
-- pre-check query below first; if it already shows the table applied, do
-- not re-run this file.
--
-- Apply via a direct database connection (see docs/migration-ledger.md
-- row 20/21 for the established precedent) or the Supabase SQL Editor.
-- Do NOT run `prisma db push`, `prisma migrate deploy`, `prisma migrate
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
-- No backfill, no destructive change: existing User rows (and every
-- other existing table) are completely untouched by this migration —
-- User gains no new column; the relation is a foreign key living
-- entirely on the new table.

-- ============================================================================
-- 0. Pre-check (read-only) — run BEFORE applying anything below, to
--    confirm this migration has not already been applied to this
--    database (remember: Preview and Production are the SAME database).
-- ============================================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'PasswordResetToken';
-- No rows → safe to apply. A row → this migration has already run;
-- investigate before re-applying anything.

-- ============================================================================
-- 1. CreateTable: PasswordResetToken
-- ============================================================================
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 2. CreateIndex
-- ============================================================================
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
CREATE INDEX "PasswordResetToken_userId_createdAt_idx" ON "PasswordResetToken"("userId", "createdAt");

-- ============================================================================
-- 3. AddForeignKey
-- ============================================================================
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. The new table exists (expect 1 row):
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'PasswordResetToken';

-- 2. Exact column shape matches prisma/schema.prisma (6 columns):
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'PasswordResetToken'
--   ORDER BY ordinal_position;

-- 3. No existing table was altered — this migration adds zero columns to
--    User or any other pre-existing table:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'User' ORDER BY ordinal_position;

-- 4. Zero rows exist immediately after migration (nothing writes to this
--    table until a real forgot-password request happens):
-- SELECT count(*) FROM "PasswordResetToken";

-- 5. Indexes landed as expected (expect 3 rows — the unique index on
--    tokenHash, the plain index on userId, and the composite
--    (userId, createdAt) index used for the per-account cooldown check):
-- SELECT indexname FROM pg_indexes WHERE tablename = 'PasswordResetToken';

-- 6. The foreign key landed with the documented ON DELETE CASCADE
--    behaviour (deleting a User also deletes their reset-token history —
--    there is no separate retention requirement for this table):
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
--   FROM pg_constraint
--   WHERE conrelid = '"PasswordResetToken"'::regclass AND contype = 'f';

-- ============================================================================
-- Rollback
-- ============================================================================
-- Additive-only, touches no existing table's data at all. Safe to drop if
-- the feature must be fully removed — no other table has a foreign key
-- pointing at PasswordResetToken (it only has an OUTGOING foreign key to
-- User), so dropping it cannot cascade into unrelated data loss:
--   DROP TABLE "PasswordResetToken";
-- Preferred approach in practice: since nothing else in the application
-- reads or depends on this table's existence, and no exam/submission/
-- integrity/LTI/course-invitation/standalone-link code path touches it,
-- the practical "rollback" for almost any issue is simply not shipping
-- the application code that writes to it, rather than dropping the
-- schema.

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. This feature is entirely new and
-- additive: every existing User/Exam/Submission/Course row (and every
-- other existing table) is completely unaffected. No user's
-- passwordHash is touched by this migration — it only ever changes
-- later, when that user explicitly completes a reset through the new
-- application code.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time — but per the operating rules for
-- this feature, it must NOT be applied without explicit authorization.
