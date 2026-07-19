-- Question Navigator v1 (additive) — see docs/question-navigator-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the changes below, per the existing
-- production-DDL pattern (docs/answer-similarity-migration.sql,
-- docs/exam-policy-evidence-review-migration.sql). Additive only — no
-- existing table, column, or constraint is changed or removed.
--
-- The three new secure-settings fields
-- (showQuestionNavigator/allowQuestionJumping/allowFlagForReview) live
-- inside the EXISTING Exam.secureSettings JSONB column — no migration is
-- required for those at all; only the changes below (two new enum
-- values, one new table) touch the database schema.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.

-- AlterEnum: IntegrityEventType — two new values, following the same
-- convention already used for every previous addition to this enum
-- (QUESTION_NAVIGATED_NEXT/PREVIOUS/QUESTION_BACK_NAVIGATION_BLOCKED,
-- the camera-integrity values, etc.). Postgres requires each new enum
-- value to be added in its own statement outside of a transaction block
-- containing its first use — run these two statements first, on their
-- own, before anything else in this file.
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'QUESTION_NAVIGATED_DIRECT';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'QUESTION_DIRECT_NAVIGATION_BLOCKED';

-- CreateTable
CREATE TABLE "SubmissionQuestionState" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "firstVisitedAt" TIMESTAMP(3),
    "lastVisitedAt" TIMESTAMP(3),
    "flaggedForReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionQuestionState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubmissionQuestionState_submissionId_questionId_key" ON "SubmissionQuestionState"("submissionId", "questionId");
CREATE INDEX "SubmissionQuestionState_submissionId_idx" ON "SubmissionQuestionState"("submissionId");
CREATE INDEX "SubmissionQuestionState_questionId_idx" ON "SubmissionQuestionState"("questionId");
CREATE INDEX "SubmissionQuestionState_submissionId_flaggedForReview_idx" ON "SubmissionQuestionState"("submissionId", "flaggedForReview");

ALTER TABLE "SubmissionQuestionState" ADD CONSTRAINT "SubmissionQuestionState_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubmissionQuestionState" ADD CONSTRAINT "SubmissionQuestionState_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. New enum values exist:
-- SELECT enumlabel FROM pg_enum WHERE enumtypid = 'IntegrityEventType'::regtype
--   AND enumlabel IN ('QUESTION_NAVIGATED_DIRECT', 'QUESTION_DIRECT_NAVIGATION_BLOCKED');

-- 2. New table exists:
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'SubmissionQuestionState';

-- 3. No existing table/column was altered — spot-check Submission and
--    Question still have their original column sets:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Question' ORDER BY ordinal_position;

-- 4. Foreign keys exist with the expected CASCADE delete behavior:
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
-- FROM pg_constraint WHERE conrelid = '"SubmissionQuestionState"'::regclass AND contype = 'f';

-- 5. Zero rows exist immediately after migration (nothing runs until a
--    student actually visits/flags a question under this feature):
-- SELECT count(*) FROM "SubmissionQuestionState";

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. Every EXISTING submission
-- (including ones currently IN_PROGRESS at deploy time) simply has zero
-- SubmissionQuestionState rows — this is a perfectly valid, expected
-- state, not a data-integrity problem: "no row" means "not visited, not
-- flagged" for that question, and the navigator/progress-derivation
-- logic (src/lib/questionNavigator.ts) treats a missing row exactly the
-- same as an explicit visited:false/flaggedForReview:false row. Answered
-- state is derived entirely from the pre-existing Answer.response column
-- and needs no migration or backfill at all — a legacy submission with
-- saved answers but zero visit rows will still correctly show those
-- questions as ANSWERED (not SKIPPED/NOT_VISITED) the first time the
-- navigator is opened for it.
--
-- Existing exams: showQuestionNavigator/allowQuestionJumping/
-- allowFlagForReview all read back with their documented defaults
-- (false/false/true) via the existing parseSecureSettings() merge — no
-- database migration needed for those three fields since they live in
-- the pre-existing Exam.secureSettings JSONB column.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time.
