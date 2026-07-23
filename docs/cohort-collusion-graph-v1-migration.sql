-- Cohort-Level Collusion Detection and Integrity Graph v1 (additive) —
-- see docs/cohort-collusion-graph-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the five NEW tables this feature adds
-- (the --from-empty diff always emits CREATE TABLE for every table since
-- it diffs against nothing; every table below is genuinely new — this
-- migration adds NO columns to any existing table, because every new
-- Prisma relation on Exam/Submission/User is a back-relation only, with
-- no underlying column of its own; the foreign keys all live on the new
-- tables). Additive only — no existing table, column, constraint, or
-- enum value is changed or removed.
--
-- New tables: CohortCollusionAnalysis, CollusionPairEdge,
-- CollusionSignal, CollusionCluster, CollusionClusterMember. See
-- prisma/schema.prisma for the full field-by-field documentation of
-- each.
--
-- IMPORTANT — shared database: Preview and Production currently point at
-- the SAME Supabase database (see docs/migration-ledger.md). This
-- migration must be applied ONCE, not once per environment. Run the
-- pre-check query below first; if it already shows the tables applied,
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
-- THIS MIGRATION HAS NOT BEEN APPLIED TO ANY ENVIRONMENT. Do not apply it
-- without explicit authorization — see docs/migration-ledger.md.

-- ============================================================================
-- 0. Pre-check (read-only) — run BEFORE applying anything below, to
--    confirm this migration has not already been applied to this
--    database (remember: Preview and Production are the SAME database).
-- ============================================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name IN (
--     'CohortCollusionAnalysis', 'CollusionPairEdge', 'CollusionSignal',
--     'CollusionCluster', 'CollusionClusterMember'
--   );
-- No rows → safe to apply. Any rows → this migration (or part of it) has
-- already run; investigate before re-applying anything.

-- ============================================================================
-- 1. CreateTable: CohortCollusionAnalysis — one reusable row per exam. A
--    re-run replaces its edges/signals and refreshes qualifying clusters,
--    but never deletes a cluster a lecturer has already reviewed — see
--    src/lib/cohortCollusionAnalysisRunner.ts.
-- ============================================================================
CREATE TABLE "CohortCollusionAnalysis" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "algorithmVersion" TEXT NOT NULL,
    "analysedAt" TIMESTAMP(3),
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleEdgeCount" INTEGER NOT NULL DEFAULT 0,
    "clusterCount" INTEGER NOT NULL DEFAULT 0,
    "overallReviewLevel" TEXT NOT NULL DEFAULT 'NONE',
    "summaryJson" JSONB,
    "requestedById" TEXT NOT NULL,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CohortCollusionAnalysis_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 2. CreateTable: CollusionPairEdge — one possible relationship between
--    two submissions. eligibleForClustering is computed and persisted by
--    the application (src/lib/cohortCollusion/graph.ts), never by a
--    database constraint. Canonical pair ordering is enforced by the
--    application, backed by the unique index below (analysisId +
--    sourceSubmissionId + comparedSubmissionId), mirroring
--    SubmissionSimilarityMatch.
-- ============================================================================
CREATE TABLE "CollusionPairEdge" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "sourceSubmissionId" TEXT NOT NULL,
    "comparedSubmissionId" TEXT NOT NULL,
    "combinedScore" DOUBLE PRECISION NOT NULL,
    "independentFamilyCount" INTEGER NOT NULL,
    "eligibleForClustering" BOOLEAN NOT NULL DEFAULT false,
    "familyScoresJson" JSONB,
    "summaryJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollusionPairEdge_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 3. CreateTable: CollusionSignal — one explainable signal contributing
--    to one edge. evidenceJson holds only minimal explainable excerpts or
--    hashes, never a full duplicated student answer.
-- ============================================================================
CREATE TABLE "CollusionSignal" (
    "id" TEXT NOT NULL,
    "edgeId" TEXT NOT NULL,
    "signalFamily" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidenceJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollusionSignal_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 4. CreateTable: CollusionCluster — a possible coordinated-answer
--    cluster. reviewStatus/reviewedAt/reviewedById/reviewNote are the
--    lecturer review state that a re-run of the analysis must never
--    silently discard for a cluster the lecturer has already reviewed —
--    see src/lib/cohortCollusionAnalysisRunner.ts.
-- ============================================================================
CREATE TABLE "CollusionCluster" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "clusterKey" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "independentFamilyCount" INTEGER NOT NULL,
    "edgeCount" INTEGER NOT NULL,
    "concernLevel" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "reviewStatus" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "summaryJson" JSONB,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollusionCluster_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 5. CreateTable: CollusionClusterMember — one student's membership in
--    one cluster, with THEIR OWN support counts (never the cluster's
--    totals) — see prisma/schema.prisma's comment on this model for why.
-- ============================================================================
CREATE TABLE "CollusionClusterMember" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "supportingEdgeCount" INTEGER NOT NULL,
    "independentFamilyCount" INTEGER NOT NULL,
    "memberScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollusionClusterMember_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 6. CreateIndex
-- ============================================================================
CREATE INDEX "CohortCollusionAnalysis_examId_idx" ON "CohortCollusionAnalysis"("examId");
CREATE INDEX "CohortCollusionAnalysis_status_idx" ON "CohortCollusionAnalysis"("status");

CREATE INDEX "CollusionPairEdge_analysisId_idx" ON "CollusionPairEdge"("analysisId");
CREATE INDEX "CollusionPairEdge_sourceSubmissionId_idx" ON "CollusionPairEdge"("sourceSubmissionId");
CREATE INDEX "CollusionPairEdge_comparedSubmissionId_idx" ON "CollusionPairEdge"("comparedSubmissionId");
CREATE UNIQUE INDEX "CollusionPairEdge_analysisId_sourceSubmissionId_comparedSub_key" ON "CollusionPairEdge"("analysisId", "sourceSubmissionId", "comparedSubmissionId");

CREATE INDEX "CollusionSignal_edgeId_idx" ON "CollusionSignal"("edgeId");
CREATE INDEX "CollusionSignal_signalFamily_idx" ON "CollusionSignal"("signalFamily");

CREATE INDEX "CollusionCluster_analysisId_idx" ON "CollusionCluster"("analysisId");
CREATE INDEX "CollusionCluster_reviewStatus_idx" ON "CollusionCluster"("reviewStatus");
CREATE INDEX "CollusionCluster_concernLevel_idx" ON "CollusionCluster"("concernLevel");
CREATE UNIQUE INDEX "CollusionCluster_analysisId_clusterKey_key" ON "CollusionCluster"("analysisId", "clusterKey");

CREATE INDEX "CollusionClusterMember_clusterId_idx" ON "CollusionClusterMember"("clusterId");
CREATE INDEX "CollusionClusterMember_submissionId_idx" ON "CollusionClusterMember"("submissionId");
CREATE UNIQUE INDEX "CollusionClusterMember_clusterId_submissionId_key" ON "CollusionClusterMember"("clusterId", "submissionId");

-- ============================================================================
-- 7. AddForeignKey
-- ============================================================================
ALTER TABLE "CohortCollusionAnalysis" ADD CONSTRAINT "CohortCollusionAnalysis_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CohortCollusionAnalysis" ADD CONSTRAINT "CohortCollusionAnalysis_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CollusionPairEdge" ADD CONSTRAINT "CollusionPairEdge_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CohortCollusionAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollusionPairEdge" ADD CONSTRAINT "CollusionPairEdge_sourceSubmissionId_fkey" FOREIGN KEY ("sourceSubmissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollusionPairEdge" ADD CONSTRAINT "CollusionPairEdge_comparedSubmissionId_fkey" FOREIGN KEY ("comparedSubmissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CollusionSignal" ADD CONSTRAINT "CollusionSignal_edgeId_fkey" FOREIGN KEY ("edgeId") REFERENCES "CollusionPairEdge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CollusionCluster" ADD CONSTRAINT "CollusionCluster_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CohortCollusionAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollusionCluster" ADD CONSTRAINT "CollusionCluster_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CollusionClusterMember" ADD CONSTRAINT "CollusionClusterMember_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "CollusionCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollusionClusterMember" ADD CONSTRAINT "CollusionClusterMember_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. All five new tables exist (expect 5 rows):
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name IN (
--     'CohortCollusionAnalysis', 'CollusionPairEdge', 'CollusionSignal',
--     'CollusionCluster', 'CollusionClusterMember'
--   );

-- 2. No existing table was altered — spot-check Submission/Exam/User
--    still have exactly their pre-migration columns (this migration adds
--    zero columns to any existing table):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;

-- 3. Zero rows exist immediately after migration (nothing runs until a
--    lecturer explicitly triggers an analysis):
-- SELECT count(*) FROM "CohortCollusionAnalysis";

-- 4. Foreign keys and unique indexes landed as expected:
-- SELECT indexname FROM pg_indexes WHERE tablename IN (
--   'CohortCollusionAnalysis', 'CollusionPairEdge', 'CollusionSignal',
--   'CollusionCluster', 'CollusionClusterMember'
-- );

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. This feature is entirely new and
-- additive: every existing Exam/Submission/User row is completely
-- unaffected (no column was added to any of them). No exam has ever had
-- a CohortCollusionAnalysis row before this migration, so there is
-- nothing to reconcile. A lecturer must explicitly trigger
-- "Run cohort integrity analysis" for a given exam after this migration
-- is applied — nothing runs automatically, and no existing behaviour of
-- any other feature (SubmissionSimilarityAnalysis, TimingAnalysis,
-- ExamAttemptSession/SessionIntegritySignal, NetworkEvidence,
-- OralVerification) changes in any way.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time — but per the operating rules for
-- this feature, it must NOT be applied without explicit authorization.
