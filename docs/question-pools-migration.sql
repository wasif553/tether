-- Question Pools v1 (additive) — see docs/question-pools-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the new QuestionPool table and the new
-- Question.questionPoolId column below, per the existing production-DDL
-- pattern in docs/evidence-frame-migration.sql and
-- docs/one-question-delivery-migration.sql. Additive only — no existing
-- table, column, enum, or constraint is changed or removed. Submission
-- already has a `questionOrderJson` JSONB column (added by
-- docs/one-question-delivery-migration.sql) which this feature reuses
-- to store the selected/ordered question ids — no new Submission column
-- is required.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.

-- CreateTable
CREATE TABLE "QuestionPool" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "drawCount" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionPool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionPool_examId_idx" ON "QuestionPool"("examId");

-- AddForeignKey
ALTER TABLE "QuestionPool" ADD CONSTRAINT "QuestionPool_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (Question)
ALTER TABLE "Question" ADD COLUMN "questionPoolId" TEXT;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_questionPoolId_fkey" FOREIGN KEY ("questionPoolId") REFERENCES "QuestionPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. QuestionPool table exists with the expected columns:
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'QuestionPool'
-- ORDER BY ordinal_position;

-- 2. Question.questionPoolId exists and defaults to NULL for every
--    existing question (expect 0 rows already having a non-null value,
--    since the column is brand new):
-- SELECT count(*) FROM "Question" WHERE "questionPoolId" IS NOT NULL;

-- 3. Foreign keys exist (expect QuestionPool -> Exam CASCADE, Question ->
--    QuestionPool SET NULL):
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
-- FROM pg_constraint
-- WHERE conrelid IN ('"QuestionPool"'::regclass, '"Question"'::regclass) AND contype = 'f';

-- 4. No existing table/column was altered — spot-check Question still has
--    its original column set:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Question' ORDER BY ordinal_position;

-- This migration is additive and safe to apply to a live production
-- database at any time: it creates one new table and adds one nullable
-- column to an existing table, does not touch any existing column, and
-- has no effect on any exam until a lecturer explicitly creates a
-- question pool and enables enableQuestionPools +
-- questionPoolSelectionMode = "DRAW_FROM_POOLS" in that exam's
-- secureSettings (see docs/question-pools-v1.md).
