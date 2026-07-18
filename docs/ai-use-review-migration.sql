-- AI-Use Answer Review v1 (additive) — see docs/ai-use-answer-review-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the two new tables below, per the existing
-- production-DDL pattern (docs/answer-similarity-migration.sql,
-- docs/evidence-frame-migration.sql, docs/question-pools-migration.sql).
-- Additive only — no existing table, column, enum, or constraint is
-- changed or removed.
--
-- Status/level/signal-type/review-status/recommendation fields are plain
-- validated TEXT columns, not Postgres enums — same convention as
-- SubmissionSimilarityAnalysis.status/overallRisk. Validation lives in
-- src/lib/aiUseReview.ts.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.

-- CreateTable
CREATE TABLE "AiUseReviewAnalysis" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "overallSignalLevel" TEXT NOT NULL DEFAULT 'NONE',
    "provider" TEXT NOT NULL,
    "modelIdentifier" TEXT,
    "algorithmVersion" TEXT NOT NULL,
    "analysedAt" TIMESTAMP(3),
    "requestedById" TEXT NOT NULL,
    "failureCode" TEXT,
    "recommendation" TEXT NOT NULL DEFAULT 'NO_IMMEDIATE_ACTION',
    "reasonCodesJson" JSONB,
    "summaryJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUseReviewAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiUseReviewAnalysis_submissionId_key" ON "AiUseReviewAnalysis"("submissionId");
CREATE INDEX "AiUseReviewAnalysis_examId_idx" ON "AiUseReviewAnalysis"("examId");
CREATE INDEX "AiUseReviewAnalysis_status_idx" ON "AiUseReviewAnalysis"("status");

-- AddForeignKey
ALTER TABLE "AiUseReviewAnalysis" ADD CONSTRAINT "AiUseReviewAnalysis_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUseReviewAnalysis" ADD CONSTRAINT "AiUseReviewAnalysis_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUseReviewAnalysis" ADD CONSTRAINT "AiUseReviewAnalysis_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AiUseReviewSignal" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answerId" TEXT,
    "signalType" TEXT NOT NULL,
    "signalLevel" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidenceJson" JSONB,
    "reviewStatus" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUseReviewSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUseReviewSignal_analysisId_idx" ON "AiUseReviewSignal"("analysisId");
CREATE INDEX "AiUseReviewSignal_questionId_idx" ON "AiUseReviewSignal"("questionId");
CREATE INDEX "AiUseReviewSignal_answerId_idx" ON "AiUseReviewSignal"("answerId");
CREATE INDEX "AiUseReviewSignal_reviewStatus_idx" ON "AiUseReviewSignal"("reviewStatus");

-- AddForeignKey
ALTER TABLE "AiUseReviewSignal" ADD CONSTRAINT "AiUseReviewSignal_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "AiUseReviewAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUseReviewSignal" ADD CONSTRAINT "AiUseReviewSignal_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiUseReviewSignal" ADD CONSTRAINT "AiUseReviewSignal_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiUseReviewSignal" ADD CONSTRAINT "AiUseReviewSignal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. Both new tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_name IN ('AiUseReviewAnalysis', 'AiUseReviewSignal');

-- 2. No existing table/column was altered — spot-check Submission, Question,
--    Exam, User, and Answer still have their original column sets (expect
--    no missing pre-existing columns):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Answer' ORDER BY ordinal_position;

-- 3. Foreign keys exist with the expected delete behavior (CASCADE for
--    analysis/signal ownership, SET NULL for optional answer/reviewer
--    references):
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
-- FROM pg_constraint
-- WHERE conrelid IN ('"AiUseReviewAnalysis"'::regclass, '"AiUseReviewSignal"'::regclass)
--   AND contype = 'f';

-- 4. Zero rows exist immediately after migration (nothing runs until a
--    lecturer explicitly clicks "Run AI-use review" for a submission):
-- SELECT count(*) FROM "AiUseReviewAnalysis";
-- SELECT count(*) FROM "AiUseReviewSignal";

-- This migration is purely additive and safe to apply to a live
-- production database at any time: it creates two new tables and adds no
-- columns to any existing table. Every existing Submission/Question/Exam/
-- User/Answer row is completely unaffected, and no backfill is required
-- or possible — analysis only ever runs going forward, triggered
-- explicitly by a lecturer via
-- POST /api/lecturer/submissions/[id]/ai-use-review (see
-- docs/ai-use-answer-review-v1.md).
