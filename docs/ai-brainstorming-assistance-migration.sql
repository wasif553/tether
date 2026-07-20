-- Controlled AI Brainstorming Assistance v1 (additive) — see
-- docs/controlled-ai-brainstorming-assistance-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the changes below, per the existing
-- production-DDL pattern (docs/answer-similarity-migration.sql,
-- docs/question-navigator-migration.sql, docs/evidence-frame-migration.sql).
-- Additive only — no existing table, column, constraint, or enum value is
-- changed or removed.
--
-- The AiAssistanceMode value ("DISABLED" | "BRAINSTORM_ONLY") and every
-- other new exam-level setting (prompt limits, response-length limit,
-- allowed-capability flags) live inside the EXISTING Exam.secureSettings
-- JSONB column — no migration is required for those at all; only the
-- changes below (five new IntegrityEventType enum values, one new
-- Submission column, one new table) touch the database schema.
--
-- Revised during pre-Preview hardening (see
-- docs/controlled-ai-brainstorming-assistance-v1.md, "Interaction status
-- lifecycle" / "Concurrency: atomic prompt-slot reservation") — updated
-- IN PLACE rather than as a second migration file, since this migration
-- had not yet been applied to any environment at the time of the
-- revision (see docs/migration-ledger.md, row 10 — still PENDING).
-- Two additions since the original version: AiAssistanceInteraction now
-- has `wasRegenerated` and a unique `clientRequestId` (idempotency key),
-- and IntegrityEventType gained a fifth new value,
-- AI_ASSISTANCE_REQUEST_FAILED, for genuine provider/parsing failures.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.
--
-- Idempotency: the four ALTER TYPE ... ADD VALUE IF NOT EXISTS statements
-- are safe to re-run. The ALTER TABLE / CREATE TABLE / CREATE INDEX / ADD
-- CONSTRAINT statements below are NOT idempotent — this is a ONE-TIME
-- script per environment. Re-running it after a successful apply will
-- error ("column already exists" / "relation already exists"). Before
-- applying, run the read-only verification queries in
-- docs/migration-ledger.md to confirm it hasn't already been applied to
-- the target environment, and record the applied date in that ledger
-- once it has.

-- ============================================================================
-- 1. AlterEnum: IntegrityEventType — five new values, following the same
--    convention already used for every previous addition to this enum.
--    Postgres requires each new enum value to be added in its own
--    statement, and none of them may be used in the same transaction that
--    adds them — run these five statements first, on their own, before
--    anything else in this file.
-- ============================================================================
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'AI_ASSISTANCE_USED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'AI_ASSISTANCE_REQUEST_BLOCKED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'AI_ASSISTANCE_LIMIT_REACHED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'AI_ASSISTANCE_RESPONSE_REGENERATED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'AI_ASSISTANCE_REQUEST_FAILED';

-- ============================================================================
-- 2. AlterTable: Submission — the immutable per-attempt AI-assistance
--    policy snapshot, exactly the same pattern as the existing
--    examPolicySnapshotJson column. Nullable; null means "no snapshot was
--    taken for this attempt" (every submission created before this
--    feature, or any exam where AI assistance was never configured) and
--    is ALWAYS treated as DISABLED — see parseAiAssistancePolicy() in
--    src/lib/aiAssistancePolicy.ts.
-- ============================================================================
ALTER TABLE "Submission" ADD COLUMN "aiAssistancePolicySnapshotJson" JSONB;

-- ============================================================================
-- 3. CreateTable: AiAssistanceInteraction — one row per student request.
--    riskCodesJson/status are validated strings/JSON, not Prisma enums
--    (see src/lib/aiAssistancePolicy.ts /
--    src/lib/aiAssistanceVerifier.ts for validation), following the
--    SubmissionSimilarityAnalysis/IntegrityEvidenceAsset convention so a
--    future addition never requires an enum-alteration migration.
--    approvedResponse is nullable — null except for status = 'APPROVED'
--    or 'FALLBACK'. THE REJECTED CANDIDATE TEXT FROM A FAILED
--    VERIFICATION PASS IS NEVER WRITTEN TO ANY COLUMN HERE, ON ANY
--    STATUS — see src/lib/aiAssistanceRunner.ts. status is one of
--    RESERVED | APPROVED | BLOCKED | FALLBACK | FAILED — see the column
--    comment in prisma/schema.prisma for the full lifecycle.
--    clientRequestId is the idempotency key (Part 2 hardening) —
--    nullable with a unique index; Postgres allows unlimited NULLs in a
--    unique index, so only actual duplicate non-null keys collide.
-- ============================================================================
CREATE TABLE "AiAssistanceInteraction" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "studentPrompt" TEXT NOT NULL,
    "approvedResponse" TEXT,
    "status" TEXT NOT NULL,
    "wasRegenerated" BOOLEAN NOT NULL DEFAULT false,
    "clientRequestId" TEXT,
    "promptNumberForQuestion" INTEGER NOT NULL,
    "promptNumberForAttempt" INTEGER NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "riskCodesJson" JSONB,
    "riskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cumulativeRiskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "specificityLevel" INTEGER NOT NULL DEFAULT 0,
    "providerModel" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssistanceInteraction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiAssistanceInteraction_clientRequestId_key" ON "AiAssistanceInteraction"("clientRequestId");
CREATE INDEX "AiAssistanceInteraction_submissionId_idx" ON "AiAssistanceInteraction"("submissionId");
CREATE INDEX "AiAssistanceInteraction_submissionId_questionId_idx" ON "AiAssistanceInteraction"("submissionId", "questionId");
CREATE INDEX "AiAssistanceInteraction_examId_idx" ON "AiAssistanceInteraction"("examId");
CREATE INDEX "AiAssistanceInteraction_studentId_idx" ON "AiAssistanceInteraction"("studentId");
CREATE INDEX "AiAssistanceInteraction_submissionId_createdAt_idx" ON "AiAssistanceInteraction"("submissionId", "createdAt");

ALTER TABLE "AiAssistanceInteraction" ADD CONSTRAINT "AiAssistanceInteraction_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAssistanceInteraction" ADD CONSTRAINT "AiAssistanceInteraction_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiAssistanceInteraction" ADD CONSTRAINT "AiAssistanceInteraction_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. New enum values exist (expect 5 rows):
-- SELECT enumlabel FROM pg_enum WHERE enumtypid = 'IntegrityEventType'::regtype
--   AND enumlabel IN ('AI_ASSISTANCE_USED', 'AI_ASSISTANCE_REQUEST_BLOCKED', 'AI_ASSISTANCE_LIMIT_REACHED', 'AI_ASSISTANCE_RESPONSE_REGENERATED', 'AI_ASSISTANCE_REQUEST_FAILED');

-- 2. New Submission column exists, and no existing column was altered/removed:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;

-- 3. New table exists:
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'AiAssistanceInteraction';

-- 4. Foreign keys exist with the expected delete behavior:
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
-- FROM pg_constraint WHERE conrelid = '"AiAssistanceInteraction"'::regclass AND contype = 'f';

-- 5. Zero rows exist immediately after migration (nothing runs until a
--    student actually uses the assistant, and only for exams that opt in):
-- SELECT count(*) FROM "AiAssistanceInteraction";

-- 6. No rejected/pre-verification text ever lands in approvedResponse for
--    a BLOCKED or FAILED interaction (should always return 0 rows):
-- SELECT count(*) FROM "AiAssistanceInteraction" WHERE status IN ('BLOCKED', 'FAILED') AND "approvedResponse" IS NOT NULL;

-- 7. The clientRequestId unique index exists:
-- SELECT indexname FROM pg_indexes WHERE tablename = 'AiAssistanceInteraction' AND indexname = 'AiAssistanceInteraction_clientRequestId_key';

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. Every EXISTING submission
-- (including ones currently IN_PROGRESS at deploy time) has
-- aiAssistancePolicySnapshotJson = NULL, which parseAiAssistancePolicy()
-- in src/lib/aiAssistancePolicy.ts always treats as DISABLED — an
-- in-progress attempt that started before this migration was applied can
-- never retroactively gain AI assistance mid-attempt, exactly like the
-- existing examPolicySnapshotJson precedent this follows.
--
-- Existing exams: aiAssistanceMode/aiAssistanceMaxPromptsPerQuestion/
-- aiAssistanceMaxPromptsPerAttempt/aiAssistanceMaxResponseCharacters/
-- aiAssistanceAllow* all read back with their documented conservative
-- defaults (DISABLED / 3 / 10 / 800 / true,true,true,true for the
-- capability flags, which have no effect while mode is DISABLED) via the
-- existing parseSecureSettings() merge — no database migration needed for
-- those fields since they live in the pre-existing Exam.secureSettings
-- JSONB column. A lecturer must explicitly enable AI assistance for each
-- exam; nothing about an existing exam's behaviour changes on its own.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time.
