-- Answer Similarity Review + Oral Verification v1 (additive) — see
-- docs/answer-similarity-review-v1.md and
-- docs/oral-verification-workflow-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the new tables below, per the existing
-- production-DDL pattern (docs/evidence-frame-migration.sql,
-- docs/one-question-delivery-migration.sql,
-- docs/question-pools-migration.sql). Additive only — no existing
-- table, column, enum, or constraint is changed or removed.
--
-- Status/risk/signal-type/review-status fields are plain validated
-- TEXT columns, not Postgres enums — following the same convention as
-- IntegrityEvidenceAsset.storageProvider and QuestionPool, so this
-- migration never needs an `ALTER TYPE` and can never fail due to enum
-- ordering. Validation lives in src/lib/answerSimilarity.ts and
-- src/lib/oralVerificationQuestions.ts.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.

-- CreateTable
CREATE TABLE "SubmissionSimilarityAnalysis" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "submissionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "overallRisk" TEXT NOT NULL DEFAULT 'NONE',
    "analysedAt" TIMESTAMP(3),
    "algorithmVersion" TEXT NOT NULL,
    "summaryJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionSimilarityAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubmissionSimilarityAnalysis_examId_idx" ON "SubmissionSimilarityAnalysis"("examId");
CREATE INDEX "SubmissionSimilarityAnalysis_status_idx" ON "SubmissionSimilarityAnalysis"("status");

-- AddForeignKey
ALTER TABLE "SubmissionSimilarityAnalysis" ADD CONSTRAINT "SubmissionSimilarityAnalysis_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "SubmissionSimilarityMatch" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "sourceSubmissionId" TEXT NOT NULL,
    "comparedSubmissionId" TEXT NOT NULL,
    "questionId" TEXT,
    "signalType" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "matchedDetailJson" JSONB,
    "reviewStatus" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionSimilarityMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubmissionSimilarityMatch_analysisId_idx" ON "SubmissionSimilarityMatch"("analysisId");
CREATE INDEX "SubmissionSimilarityMatch_sourceSubmissionId_idx" ON "SubmissionSimilarityMatch"("sourceSubmissionId");
CREATE INDEX "SubmissionSimilarityMatch_comparedSubmissionId_idx" ON "SubmissionSimilarityMatch"("comparedSubmissionId");
CREATE INDEX "SubmissionSimilarityMatch_questionId_idx" ON "SubmissionSimilarityMatch"("questionId");
CREATE INDEX "SubmissionSimilarityMatch_reviewStatus_idx" ON "SubmissionSimilarityMatch"("reviewStatus");

-- AddForeignKey
ALTER TABLE "SubmissionSimilarityMatch" ADD CONSTRAINT "SubmissionSimilarityMatch_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "SubmissionSimilarityAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubmissionSimilarityMatch" ADD CONSTRAINT "SubmissionSimilarityMatch_sourceSubmissionId_fkey" FOREIGN KEY ("sourceSubmissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubmissionSimilarityMatch" ADD CONSTRAINT "SubmissionSimilarityMatch_comparedSubmissionId_fkey" FOREIGN KEY ("comparedSubmissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubmissionSimilarityMatch" ADD CONSTRAINT "SubmissionSimilarityMatch_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SubmissionSimilarityMatch" ADD CONSTRAINT "SubmissionSimilarityMatch_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "OralVerification" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUIRED',
    "reason" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "outcome" TEXT,
    "lecturerNotes" TEXT,
    "generatedQuestionsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OralVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OralVerification_submissionId_idx" ON "OralVerification"("submissionId");
CREATE INDEX "OralVerification_status_idx" ON "OralVerification"("status");

-- AddForeignKey
ALTER TABLE "OralVerification" ADD CONSTRAINT "OralVerification_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OralVerification" ADD CONSTRAINT "OralVerification_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OralVerification" ADD CONSTRAINT "OralVerification_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. All three new tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_name IN ('SubmissionSimilarityAnalysis', 'SubmissionSimilarityMatch', 'OralVerification');

-- 2. No existing table/column was altered — spot-check Submission, Question,
--    Exam, and User still have their original column sets (expect no
--    missing pre-existing columns):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Question' ORDER BY ordinal_position;

-- 3. Foreign keys exist with the expected delete behavior (CASCADE for
--    analysis/match/verification ownership, SET NULL for optional
--    question/reviewer/completedBy references):
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
-- FROM pg_constraint
-- WHERE conrelid IN (
--   '"SubmissionSimilarityAnalysis"'::regclass,
--   '"SubmissionSimilarityMatch"'::regclass,
--   '"OralVerification"'::regclass
-- ) AND contype = 'f';

-- 4. Zero rows exist immediately after migration (nothing runs until a
--    lecturer explicitly triggers analysis or requires oral verification):
-- SELECT count(*) FROM "SubmissionSimilarityAnalysis";
-- SELECT count(*) FROM "SubmissionSimilarityMatch";
-- SELECT count(*) FROM "OralVerification";

-- This migration is purely additive and safe to apply to a live
-- production database at any time: it creates three new tables and adds
-- no columns to any existing table. Every existing Submission/Question/
-- Exam/User row is completely unaffected. No backfill is required or
-- possible — analysis only ever runs going forward, triggered explicitly
-- by a lecturer via POST /api/lecturer/exams/[examId]/similarity-analysis
-- or POST /api/lecturer/submissions/[id]/oral-verification (see
-- docs/answer-similarity-review-v1.md and
-- docs/oral-verification-workflow-v1.md).
