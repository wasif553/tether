-- Auth and Token Abuse Protection v1 (additive) — see
-- docs/auth-token-abuse-protection-v1.md and
-- prisma/schema.prisma's SecurityRateLimitBucket model for the full
-- field-by-field documentation.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- (which always emits CREATE TABLE for every table since it diffs
-- against nothing), hand-extracted to just the ONE new table this
-- feature adds. Additive only — no existing table, column, constraint,
-- row, or enum value is changed or removed.
--
-- New table: SecurityRateLimitBucket — one generic, durable,
-- concurrency-safe fixed-window rate-limit bucket shared by every
-- abuse-sensitive verification surface this feature protects (login,
-- forgot-password, password-reset token guessing, course-invitation
-- token guessing, standalone-invite token guessing, exam access-code
-- guessing). Only an HMAC-SHA256 digest of a scope-qualified identifier
-- is ever stored (`keyHash`) — never a raw email, IP address, password,
-- reset token, invitation token, or access code. No password, diagnosis,
-- or other sensitive field exists on this table.
--
-- ============================================================================
-- SECURITY REVIEW STATUS — READ BEFORE APPLYING
-- ============================================================================
--
-- THIS FILE IS NOT APPLIED. It must not be run against the shared
-- Preview/Production Supabase database until an independent security
-- review of the accompanying application-code diff has explicitly
-- authorized applying it. See docs/migration-ledger.md row 23 — its
-- status must read NOT APPLIED / PENDING SECURITY REVIEW until that
-- authorization happens, and this comment block must be updated (or the
-- ledger row marked applied) only at that point, exactly once.
--
-- Password Reset v1's migration (row 22, PasswordResetToken) is already
-- applied to the shared database — this file is unrelated to it and
-- must never be confused with, or substituted for, re-running that one.
-- NEVER re-apply row 22.
--
-- ============================================================================
--
-- IMPORTANT — shared database: Preview and Production currently point at
-- the SAME Supabase database (see docs/migration-ledger.md). Once
-- authorized, this migration must be applied ONCE, not once per
-- environment. Run the pre-check query below first; if it already shows
-- the table applied, do not re-run this file.
--
-- Apply via a direct database connection (see docs/migration-ledger.md
-- row 20-22 for the established precedent) or the Supabase SQL Editor.
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
-- No backfill, no destructive change: every existing table (including
-- User, PasswordResetToken, CourseEnrollmentInvitation, Exam) is
-- completely untouched by this migration — no column added to any of
-- them; the relation, if any, would live entirely on the new table, and
-- in this design there is no foreign key at all (buckets are identified
-- purely by an opaque keyHash, deliberately decoupled from any specific
-- User/Exam/Invitation row so this table can never be used to enumerate
-- or join back to real records).

-- ============================================================================
-- 0. Pre-check (read-only) — run BEFORE applying anything below, to
--    confirm this migration has not already been applied to this
--    database (remember: Preview and Production are the SAME database).
-- ============================================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'SecurityRateLimitBucket';
-- No rows → safe to apply. A row → this migration has already run;
-- investigate before re-applying anything.

-- ============================================================================
-- 1. CreateTable: SecurityRateLimitBucket
-- ============================================================================
CREATE TABLE "SecurityRateLimitBucket" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityRateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 2. CreateIndex
-- ============================================================================
CREATE UNIQUE INDEX "SecurityRateLimitBucket_scope_keyHash_key" ON "SecurityRateLimitBucket"("scope", "keyHash");
CREATE INDEX "SecurityRateLimitBucket_windowStart_idx" ON "SecurityRateLimitBucket"("windowStart");

-- ============================================================================
-- Verification queries — run after applying the above (only once authorized)
-- ============================================================================

-- 1. The new table exists (expect 1 row):
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'SecurityRateLimitBucket';

-- 2. Exact column shape matches prisma/schema.prisma (7 columns):
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'SecurityRateLimitBucket'
--   ORDER BY ordinal_position;

-- 3. No existing table was altered — this migration adds zero columns to
--    User, PasswordResetToken, Exam, or any other pre-existing table:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'User' ORDER BY ordinal_position;

-- 4. Zero rows exist immediately after migration (nothing writes to this
--    table until a real abuse-sensitive request happens):
-- SELECT count(*) FROM "SecurityRateLimitBucket";

-- 5. Indexes landed as expected (expect 2 rows — the unique index on
--    (scope, keyHash) and the plain index on windowStart used for
--    opportunistic cleanup):
-- SELECT indexname FROM pg_indexes WHERE tablename = 'SecurityRateLimitBucket';

-- 6. No foreign keys exist on this table by design (expect 0 rows) —
--    buckets are deliberately decoupled from any specific User/Exam/
--    Invitation row:
-- SELECT conname FROM pg_constraint
--   WHERE conrelid = '"SecurityRateLimitBucket"'::regclass AND contype = 'f';

-- ============================================================================
-- Rollback
-- ============================================================================
-- Additive-only, touches no existing table's data at all. Safe to drop if
-- the feature must be fully removed — no other table has a foreign key
-- pointing at SecurityRateLimitBucket (it has none at all), so dropping
-- it cannot cascade into unrelated data loss:
--   DROP TABLE "SecurityRateLimitBucket";
-- Preferred approach in practice: since this table's contents are
-- opaque, short-lived rate-limit windows (not a durable record of
-- anything), the practical "rollback" for almost any issue is simply
-- not shipping the application code that writes to it, rather than
-- dropping the schema — a dropped or empty table only makes every rate
-- limiter fail open (see src/lib/security/rateLimiter.ts's documented
-- fail-open-on-error policy), never fail in a way that blocks
-- legitimate authentication/reset/invitation/exam-start flows.

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. This feature is entirely new and
-- additive: every existing User/Exam/Submission/PasswordResetToken/
-- CourseEnrollmentInvitation row is completely unaffected. No stored
-- credential, token, or access code is touched by this migration — it
-- only ever changes later, when real request traffic populates this
-- table through the new application code.
--
-- This migration is purely additive and low-risk — but per the operating
-- rules for this feature, it must NOT be applied without explicit,
-- independent security review authorization, and must NOT be applied
-- more than once.
