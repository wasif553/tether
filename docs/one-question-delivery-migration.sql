-- One-Question-At-A-Time Exam Delivery v1 (additive)
-- See docs/one-question-delivery-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the new Submission columns below, per the
-- existing production-DDL pattern in docs/evidence-frame-migration.sql
-- and docs/network-evidence-and-ip-location.md. Additive only — no
-- existing table, column, enum, or constraint is changed or removed.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN "questionOrderJson" JSONB;
ALTER TABLE "Submission" ADD COLUMN "currentQuestionIndex" INTEGER NOT NULL DEFAULT 0;

-- AlterEnum — additive only. Postgres allows adding new enum values
-- without rewriting the table/existing rows. New values cannot be added
-- inside the same transaction as their first use, which is not a concern
-- here since nothing references them yet.
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'QUESTION_NAVIGATED_NEXT';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'QUESTION_NAVIGATED_PREVIOUS';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'QUESTION_BACK_NAVIGATION_BLOCKED';

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. Both new Submission columns exist with the expected types/defaults:
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'Submission' AND column_name IN ('questionOrderJson', 'currentQuestionIndex')
-- ORDER BY column_name;

-- 2. Every existing row got the safe defaults (expect 0 rows — no existing
--    submission should have a non-null questionOrderJson or a non-zero
--    currentQuestionIndex immediately after migration, since this feature
--    is opt-in and off for every exam until a lecturer enables it):
-- SELECT count(*) FROM "Submission" WHERE "questionOrderJson" IS NOT NULL OR "currentQuestionIndex" != 0;

-- 3. No existing column was altered — spot-check Submission still has its
--    original column set (expect no missing pre-existing columns):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;

-- 4. The three new enum values exist on IntegrityEventType:
-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = 'IntegrityEventType'::regtype
--   AND enumlabel IN ('QUESTION_NAVIGATED_NEXT', 'QUESTION_NAVIGATED_PREVIOUS', 'QUESTION_BACK_NAVIGATION_BLOCKED');

-- This migration is purely additive and safe to apply to a live production
-- database at any time: it adds two nullable/defaulted columns to an
-- existing table, does not touch any existing column/index/constraint, and
-- has no effect on any exam until a lecturer explicitly enables
-- oneQuestionAtATime and/or randomiseQuestionOrder in that exam's
-- secureSettings (see docs/one-question-delivery-v1.md).
