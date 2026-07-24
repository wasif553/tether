-- Answer-Development Provenance v1 (additive) — see
-- docs/answer-development-provenance-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the new/changed statements this feature
-- adds (the --from-empty diff always emits CREATE TABLE for every table
-- since it diffs against nothing; every table below is genuinely new).
-- Additive only — no existing table, column, constraint, or enum value
-- is changed or removed. This feature adds no new IntegrityEventType
-- enum values — process events use their own AnswerDevelopmentEvent.eventType
-- string column instead (see prisma/schema.prisma).
--
-- Changes:
--   1. One new nullable column on the EXISTING Submission table —
--      answerProvenancePolicySnapshotJson (the immutable per-attempt
--      policy snapshot, same pattern as examPolicySnapshotJson /
--      aiAssistancePolicySnapshotJson / screenSharePolicySnapshotJson).
--   2. Five new tables: AnswerDevelopmentVersion, AnswerDevelopmentEvent,
--      AnswerDevelopmentArtifact, AnswerDevelopmentArtifactVersion,
--      CodeExecutionEvent. See prisma/schema.prisma for full field-by-
--      field documentation of each.
--
-- IMPORTANT — shared database: Preview and Production currently point at
-- the SAME Supabase database (see docs/migration-ledger.md). This
-- migration must be applied ONCE, not once per environment. Run the
-- pre-check query below first; if it already shows the change applied,
-- do not re-run this file.
--
-- Apply via the Supabase SQL Editor (or `psql`). Do NOT run
-- `prisma db push`, `prisma migrate deploy`, `prisma migrate dev`, or
-- `prisma migrate resolve`.
--
-- Idempotency: this file is NOT idempotent — it is a ONE-TIME script.
-- Re-running it after a successful apply will error ("column already
-- exists" / "relation already exists"). Run the pre-check query first.
--
-- THIS MIGRATION HAS NOT BEEN APPLIED TO ANY ENVIRONMENT. Do not apply it
-- without explicit authorization — see docs/migration-ledger.md. Mark as
-- PENDING — NOT APPLIED until an operator actually runs it.

-- ============================================================================
-- 0. Pre-check (read-only) — run BEFORE applying anything below, to
--    confirm this migration has not already been applied to this
--    database (remember: Preview and Production are the SAME database).
-- ============================================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'Submission' AND column_name = 'answerProvenancePolicySnapshotJson';
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name IN (
--     'AnswerDevelopmentVersion', 'AnswerDevelopmentEvent',
--     'AnswerDevelopmentArtifact', 'AnswerDevelopmentArtifactVersion',
--     'CodeExecutionEvent'
--   );
-- No rows from either query → safe to apply. Any rows → this migration
-- (or part of it) has already run; investigate before re-applying.

-- ============================================================================
-- 1. AlterTable: Submission — the immutable per-attempt provenance policy
--    snapshot. Nullable; null means "no snapshot was taken for this
--    attempt" (every submission created before this feature, or any exam
--    where provenance was never configured) and is ALWAYS treated as OFF
--    — see parseAnswerProvenancePolicy() in src/lib/answerProvenancePolicy.ts.
-- ============================================================================
ALTER TABLE "Submission" ADD COLUMN "answerProvenancePolicySnapshotJson" JSONB;

-- ============================================================================
-- 2. CreateTable: AnswerDevelopmentVersion — one row per readable answer-
--    version checkpoint. Never created for a normalised-unchanged
--    response; INITIAL_TEXT and FINAL_SUBMISSION are always preserved —
--    see src/lib/answerDevelopment.ts.
-- ============================================================================
CREATE TABLE "AnswerDevelopmentVersion" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "answerId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "responseText" TEXT NOT NULL,
    "responseLength" INTEGER NOT NULL,
    "responseHash" TEXT NOT NULL,
    "previousVersionId" TEXT,
    "changeType" TEXT NOT NULL,
    "charactersAdded" INTEGER NOT NULL,
    "charactersRemoved" INTEGER NOT NULL,
    "changeRatio" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientElapsedMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerDevelopmentVersion_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 3. CreateTable: AnswerDevelopmentEvent — structured process metadata
--    that does not require a full readable version. No event is itself
--    labelled misconduct.
-- ============================================================================
CREATE TABLE "AnswerDevelopmentEvent" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "answerId" TEXT,
    "questionId" TEXT,
    "examAttemptSessionId" TEXT,
    "eventType" TEXT NOT NULL,
    "eventLevel" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientElapsedMs" INTEGER,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerDevelopmentEvent_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 4. CreateTable: AnswerDevelopmentArtifact — current outline/working/
--    source-declaration row per (submission, question-or-null, type).
-- ============================================================================
CREATE TABLE "AnswerDevelopmentArtifact" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "answerId" TEXT,
    "questionId" TEXT,
    "artifactType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnswerDevelopmentArtifact_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 5. CreateTable: AnswerDevelopmentArtifactVersion — readable history for
--    AnswerDevelopmentArtifact; a PUT never silently discards prior
--    working.
-- ============================================================================
CREATE TABLE "AnswerDevelopmentArtifactVersion" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerDevelopmentArtifactVersion_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 6. CreateTable: CodeExecutionEvent — code-run request contract only. No
--    secure isolated runner exists; every row v1 ever writes has
--    exitStatus 'NOT_CONFIGURED'. Never stores unrestricted terminal
--    output — see src/app/api/submissions/[id]/answer-development/code-run/route.ts.
-- ============================================================================
CREATE TABLE "CodeExecutionEvent" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "answerId" TEXT,
    "questionId" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "runType" TEXT NOT NULL,
    "language" TEXT,
    "codeHash" TEXT NOT NULL,
    "codeLength" INTEGER NOT NULL,
    "testSetIdentifier" TEXT,
    "testsRun" INTEGER,
    "testsPassed" INTEGER,
    "testsFailed" INTEGER,
    "exitStatus" TEXT NOT NULL,
    "durationMs" INTEGER,
    "outputSummaryJson" JSONB,
    "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 7. CreateIndex — unique + lookup indexes for all five new tables.
-- ============================================================================
CREATE UNIQUE INDEX "AnswerDevelopmentVersion_clientRequestId_key" ON "AnswerDevelopmentVersion"("clientRequestId");
CREATE INDEX "AnswerDevelopmentVersion_submissionId_idx" ON "AnswerDevelopmentVersion"("submissionId");
CREATE INDEX "AnswerDevelopmentVersion_answerId_idx" ON "AnswerDevelopmentVersion"("answerId");
CREATE INDEX "AnswerDevelopmentVersion_questionId_idx" ON "AnswerDevelopmentVersion"("questionId");
CREATE INDEX "AnswerDevelopmentVersion_submissionId_questionId_idx" ON "AnswerDevelopmentVersion"("submissionId", "questionId");
CREATE UNIQUE INDEX "AnswerDevelopmentVersion_submissionId_questionId_versionNum_key" ON "AnswerDevelopmentVersion"("submissionId", "questionId", "versionNumber");

CREATE UNIQUE INDEX "AnswerDevelopmentEvent_clientRequestId_key" ON "AnswerDevelopmentEvent"("clientRequestId");
CREATE INDEX "AnswerDevelopmentEvent_submissionId_idx" ON "AnswerDevelopmentEvent"("submissionId");
CREATE INDEX "AnswerDevelopmentEvent_answerId_idx" ON "AnswerDevelopmentEvent"("answerId");
CREATE INDEX "AnswerDevelopmentEvent_questionId_idx" ON "AnswerDevelopmentEvent"("questionId");
CREATE INDEX "AnswerDevelopmentEvent_examAttemptSessionId_idx" ON "AnswerDevelopmentEvent"("examAttemptSessionId");
CREATE INDEX "AnswerDevelopmentEvent_eventType_idx" ON "AnswerDevelopmentEvent"("eventType");
CREATE INDEX "AnswerDevelopmentEvent_serverReceivedAt_idx" ON "AnswerDevelopmentEvent"("serverReceivedAt");

CREATE UNIQUE INDEX "AnswerDevelopmentArtifact_clientRequestId_key" ON "AnswerDevelopmentArtifact"("clientRequestId");
CREATE INDEX "AnswerDevelopmentArtifact_submissionId_idx" ON "AnswerDevelopmentArtifact"("submissionId");
CREATE INDEX "AnswerDevelopmentArtifact_answerId_idx" ON "AnswerDevelopmentArtifact"("answerId");
CREATE INDEX "AnswerDevelopmentArtifact_questionId_idx" ON "AnswerDevelopmentArtifact"("questionId");
CREATE UNIQUE INDEX "AnswerDevelopmentArtifact_submissionId_questionId_artifactT_key" ON "AnswerDevelopmentArtifact"("submissionId", "questionId", "artifactType");

CREATE UNIQUE INDEX "AnswerDevelopmentArtifactVersion_clientRequestId_key" ON "AnswerDevelopmentArtifactVersion"("clientRequestId");
CREATE INDEX "AnswerDevelopmentArtifactVersion_artifactId_idx" ON "AnswerDevelopmentArtifactVersion"("artifactId");
CREATE UNIQUE INDEX "AnswerDevelopmentArtifactVersion_artifactId_versionNumber_key" ON "AnswerDevelopmentArtifactVersion"("artifactId", "versionNumber");

CREATE UNIQUE INDEX "CodeExecutionEvent_clientRequestId_key" ON "CodeExecutionEvent"("clientRequestId");
CREATE INDEX "CodeExecutionEvent_submissionId_idx" ON "CodeExecutionEvent"("submissionId");
CREATE INDEX "CodeExecutionEvent_answerId_idx" ON "CodeExecutionEvent"("answerId");
CREATE INDEX "CodeExecutionEvent_questionId_idx" ON "CodeExecutionEvent"("questionId");

-- ============================================================================
-- 8. AddForeignKey — all outgoing only; none of these five tables is
--    referenced BY any existing table, so adding them cannot affect any
--    existing foreign key or cascade behaviour.
-- ============================================================================
ALTER TABLE "AnswerDevelopmentVersion" ADD CONSTRAINT "AnswerDevelopmentVersion_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnswerDevelopmentVersion" ADD CONSTRAINT "AnswerDevelopmentVersion_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnswerDevelopmentVersion" ADD CONSTRAINT "AnswerDevelopmentVersion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnswerDevelopmentEvent" ADD CONSTRAINT "AnswerDevelopmentEvent_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnswerDevelopmentEvent" ADD CONSTRAINT "AnswerDevelopmentEvent_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnswerDevelopmentEvent" ADD CONSTRAINT "AnswerDevelopmentEvent_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnswerDevelopmentEvent" ADD CONSTRAINT "AnswerDevelopmentEvent_examAttemptSessionId_fkey" FOREIGN KEY ("examAttemptSessionId") REFERENCES "ExamAttemptSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AnswerDevelopmentArtifact" ADD CONSTRAINT "AnswerDevelopmentArtifact_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnswerDevelopmentArtifact" ADD CONSTRAINT "AnswerDevelopmentArtifact_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnswerDevelopmentArtifact" ADD CONSTRAINT "AnswerDevelopmentArtifact_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AnswerDevelopmentArtifactVersion" ADD CONSTRAINT "AnswerDevelopmentArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "AnswerDevelopmentArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodeExecutionEvent" ADD CONSTRAINT "CodeExecutionEvent_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeExecutionEvent" ADD CONSTRAINT "CodeExecutionEvent_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CodeExecutionEvent" ADD CONSTRAINT "CodeExecutionEvent_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. New Submission column exists, and no existing column was altered/removed:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;

-- 2. All five new tables exist:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
--   AND table_name IN ('AnswerDevelopmentVersion','AnswerDevelopmentEvent','AnswerDevelopmentArtifact','AnswerDevelopmentArtifactVersion','CodeExecutionEvent')
--   ORDER BY table_name;

-- 3. Zero rows exist immediately after migration (nothing runs until a
--    student actually attempts an exam with this feature enabled):
-- SELECT count(*) FROM "AnswerDevelopmentVersion";
-- SELECT count(*) FROM "CodeExecutionEvent";

-- 4. Every existing Submission row has the new column NULL:
-- SELECT count(*) FROM "Submission" WHERE "answerProvenancePolicySnapshotJson" IS NOT NULL; -- expect 0 immediately after migration

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. Every EXISTING submission
-- (including ones currently IN_PROGRESS at deploy time) has
-- answerProvenancePolicySnapshotJson = NULL, which
-- parseAnswerProvenancePolicy() in src/lib/answerProvenancePolicy.ts
-- always treats as OFF — an in-progress attempt that started before this
-- migration was applied can never retroactively start capturing
-- checkpoints mid-attempt, exactly like the existing
-- examPolicySnapshotJson/aiAssistancePolicySnapshotJson/
-- screenSharePolicySnapshotJson precedents this follows.
--
-- Existing exams: answerProvenanceMode and every related setting read
-- back with their documented conservative defaults (OFF / 60 / 80 / 40 /
-- true / true / false / false / false / false / false / true) via the
-- existing parseSecureSettings() merge — no database migration needed
-- for those fields since they live in the pre-existing
-- Exam.secureSettings JSONB column. A lecturer must explicitly enable
-- provenance for each exam; nothing about an existing exam's behaviour
-- changes on its own.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time.
--
-- ============================================================================
-- Rollback (documentation only — see docs/migration-ledger.md for the
-- full procedure; not executed automatically by this file)
-- ============================================================================
-- All five new tables are safe to drop in child-to-parent order if the
-- feature must be fully removed:
--   DROP TABLE "AnswerDevelopmentArtifactVersion";
--   DROP TABLE "AnswerDevelopmentArtifact";
--   DROP TABLE "AnswerDevelopmentEvent";
--   DROP TABLE "AnswerDevelopmentVersion";
--   DROP TABLE "CodeExecutionEvent";
-- (no other table has a foreign key pointing at any of these five — they
-- only have OUTGOING foreign keys to Submission/Answer/Question/
-- ExamAttemptSession — so dropping them cannot cascade into unrelated
-- data loss; this would permanently delete recorded checkpoints/events/
-- artifacts/code-execution requests — export/audit first if that data
-- must be retained).
-- The Submission column is safe to drop if needed:
--   ALTER TABLE "Submission" DROP COLUMN "answerProvenancePolicySnapshotJson";
-- (every application code path treats a missing/null value as OFF).
-- Preferred approach in practice: since the feature defaults to
-- answerProvenanceMode "OFF", ensuring no exam has it enabled is the
-- practical "rollback" for almost any issue, rather than reverting the
-- schema.
