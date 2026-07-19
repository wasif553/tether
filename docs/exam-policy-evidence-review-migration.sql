-- Exam Design Policy + Evidence Review v1 (additive) — see
-- docs/exam-design-policy-v1.md and docs/evidence-review-workflow-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the changes below, per the existing
-- production-DDL pattern (docs/answer-similarity-migration.sql,
-- docs/ai-use-review-migration.sql, docs/exam-session-binding-migration.sql).
-- Additive only — no existing table, column, enum, or constraint is
-- changed or removed. The exam-policy settings themselves
-- (examMode/calculatorAllowed/notesAllowed/internetAllowed/aiToolsAllowed)
-- live inside the EXISTING Exam.secureSettings JSONB column — no
-- migration is required for those at all; only the two schema changes
-- below (one new nullable column, five new review-status/reviewer
-- columns, two new tables) touch the database.
--
-- reviewStatus/commentType/etc. are plain validated TEXT columns, not
-- Postgres enums — same convention as SubmissionSimilarityAnalysis.status.
-- Validation lives in src/lib/integrityReview.ts.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.

-- AlterTable: Submission — one new nullable JSONB column, the immutable
-- attempt-policy snapshot. NULL for every existing row and stays NULL
-- for any submission created before this migration is deployed.
ALTER TABLE "Submission" ADD COLUMN "examPolicySnapshotJson" JSONB;

-- AlterTable: IntegrityEvent — five new columns for the 5-state review
-- workflow. The pre-existing resolvedAt/resolvedById/resolutionNote
-- columns are UNCHANGED and remain fully populated/queryable exactly as
-- before — the legacy POST .../resolve route continues to write them.
ALTER TABLE "IntegrityEvent" ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW';
ALTER TABLE "IntegrityEvent" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "IntegrityEvent" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "IntegrityEvent" ADD COLUMN "reviewNote" TEXT;

CREATE INDEX "IntegrityEvent_reviewStatus_idx" ON "IntegrityEvent"("reviewStatus");

ALTER TABLE "IntegrityEvent" ADD CONSTRAINT "IntegrityEvent_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "IntegrityReviewComment" (
    "id" TEXT NOT NULL,
    "integrityEventId" TEXT NOT NULL,
    "evidenceAssetId" TEXT,
    "submissionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "commentType" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrityReviewComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrityReviewComment_integrityEventId_idx" ON "IntegrityReviewComment"("integrityEventId");
CREATE INDEX "IntegrityReviewComment_submissionId_idx" ON "IntegrityReviewComment"("submissionId");
CREATE INDEX "IntegrityReviewComment_evidenceAssetId_idx" ON "IntegrityReviewComment"("evidenceAssetId");

ALTER TABLE "IntegrityReviewComment" ADD CONSTRAINT "IntegrityReviewComment_integrityEventId_fkey" FOREIGN KEY ("integrityEventId") REFERENCES "IntegrityEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrityReviewComment" ADD CONSTRAINT "IntegrityReviewComment_evidenceAssetId_fkey" FOREIGN KEY ("evidenceAssetId") REFERENCES "IntegrityEvidenceAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IntegrityReviewComment" ADD CONSTRAINT "IntegrityReviewComment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrityReviewComment" ADD CONSTRAINT "IntegrityReviewComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "IntegrityReviewStatusHistory" (
    "id" TEXT NOT NULL,
    "integrityEventId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedByRole" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrityReviewStatusHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrityReviewStatusHistory_integrityEventId_idx" ON "IntegrityReviewStatusHistory"("integrityEventId");
CREATE INDEX "IntegrityReviewStatusHistory_submissionId_idx" ON "IntegrityReviewStatusHistory"("submissionId");

ALTER TABLE "IntegrityReviewStatusHistory" ADD CONSTRAINT "IntegrityReviewStatusHistory_integrityEventId_fkey" FOREIGN KEY ("integrityEventId") REFERENCES "IntegrityEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrityReviewStatusHistory" ADD CONSTRAINT "IntegrityReviewStatusHistory_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrityReviewStatusHistory" ADD CONSTRAINT "IntegrityReviewStatusHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. New column/tables exist:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' AND column_name = 'examPolicySnapshotJson';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'IntegrityEvent' AND column_name IN ('reviewStatus','reviewedAt','reviewedById','reviewNote');
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('IntegrityReviewComment', 'IntegrityReviewStatusHistory');

-- 2. No existing column was dropped/altered — spot-check the old
--    resolution trio is still present and untouched:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'IntegrityEvent' AND column_name IN ('resolvedAt','resolvedById','resolutionNote');

-- 3. Every existing IntegrityEvent row defaulted to reviewStatus =
--    'NEEDS_REVIEW' — never fabricated as already-reviewed:
-- SELECT "reviewStatus", count(*) FROM "IntegrityEvent" GROUP BY "reviewStatus";

-- 4. Every existing Submission row has a NULL policy snapshot (no
--    backfill performed or possible):
-- SELECT count(*) FROM "Submission" WHERE "examPolicySnapshotJson" IS NOT NULL;
-- (expect 0 immediately after this migration)

-- 5. Foreign keys exist with the expected delete behavior:
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
-- FROM pg_constraint
-- WHERE conrelid IN (
--   '"IntegrityReviewComment"'::regclass, '"IntegrityReviewStatusHistory"'::regclass
-- ) AND contype = 'f';

-- ============================================================================
-- Legacy and in-progress-attempt behaviour
-- ============================================================================
--
-- Existing exams: Exam.secureSettings already tolerates unknown/missing
-- keys (see parseSecureSettings() in src/lib/secureExam.ts) — no
-- migration needed for examMode/calculatorAllowed/notesAllowed/
-- internetAllowed/aiToolsAllowed. Every existing exam reads back as
-- examMode: "CUSTOM" with all four resources false, exactly the same as
-- if a lecturer had explicitly chosen those values — it is NEVER
-- inferred that an existing secure exam is closed-book.
--
-- Existing submissions: examPolicySnapshotJson is NULL. The evidence
-- review UI and src/lib/examPolicy.ts:classifyIntegritySignalForPolicy
-- both treat a null snapshot as UNKNOWN policy alignment — never a
-- retrospective policy-breach classification — and the UI shows
-- "Policy snapshot unavailable for this legacy attempt."
--
-- Existing integrity events: reviewStatus defaults to 'NEEDS_REVIEW' for
-- every row (including ones that already have resolvedAt set from the
-- legacy resolve route) — a lecturer who already resolved an event still
-- sees its resolution details (resolvedAt/resolvedById/resolutionNote
-- are untouched), but the NEW reviewStatus starts at NEEDS_REVIEW rather
-- than being backfilled to RESOLVED, since this migration performs no
-- backfill and must not fabricate a reviewer decision that was never
-- actually made under the new 5-state model. The legacy POST
-- .../resolve route (kept for backward compatibility — see
-- docs/evidence-review-workflow-v1.md) additionally sets reviewStatus to
-- 'RESOLVED' going forward for any NEW resolution made after this
-- deployment, so old and new resolutions only diverge for
-- already-resolved historical rows, and only in reviewStatus (never in
-- resolvedAt/resolvedById/resolutionNote, which are always accurate).
--
-- In-progress attempts at deploy time: an attempt that started BEFORE
-- this migration/deployment has no examPolicySnapshotJson and never gets
-- one retroactively — it behaves exactly like a legacy submission for
-- policy-interpretation purposes. Its exam's answer/grading/submission
-- flow is completely unaffected; the exam's own Exam.secureSettings
-- (already in use for that attempt) does not change as a result of this
-- migration.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time.
