-- Exam Session Binding + Time Anomaly Review v1 (additive) — see
-- docs/exam-session-binding-v1.md and docs/time-anomaly-review-v1.md.
--
-- Combines the session-binding tables (ExamAttemptSession,
-- SessionIntegritySignal) and the activity-telemetry / timing-analysis
-- tables (AnswerActivityEvent, TimingAnalysis, TimingIntegritySignal)
-- into one additive migration file — permitted by the task's Part 7 note
-- that the telemetry migration "may be combined with the session-binding
-- migration if implementation conventions prefer one additive migration
-- file." This repo's convention is one hand-written SQL file per feature
-- (docs/answer-similarity-migration.sql, docs/ai-use-review-migration.sql),
-- so this session-binding + telemetry + timing feature follows the same
-- single-file convention.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the five new tables below. Additive only —
-- no existing table, column, enum, or constraint is changed or removed.
--
-- Status/type/level/review-status/recommendation fields are plain
-- validated TEXT columns, not Postgres enums — same convention as
-- SubmissionSimilarityAnalysis.status/overallRisk. Validation lives in
-- src/lib/sessionBinding.ts, src/lib/sessionIntegrity.ts, and
-- src/lib/timeAnomalyDetection.ts.
--
-- NOTHING HERE STORES RAW IP ADDRESSES, RAW SESSION/DEVICE TOKENS, RAW
-- USER-AGENT STRINGS NEEDED FOR DISPLAY, OR AN HMAC SECRET. Only HMAC
-- hashes, coarse categories, and IP network prefixes.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.

-- CreateTable
CREATE TABLE "ExamAttemptSession" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "browserSessionTokenHash" TEXT NOT NULL,
    "deviceTokenHash" TEXT NOT NULL,
    "coarseFingerprintHash" TEXT,
    "userAgentHash" TEXT,
    "browserFamily" TEXT,
    "operatingSystemFamily" TEXT,
    "deviceCategory" TEXT,
    "ipPrefixHash" TEXT,
    "ipVersion" TEXT,
    "cameraPermissionState" TEXT NOT NULL DEFAULT 'unknown',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamAttemptSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExamAttemptSession_submissionId_idx" ON "ExamAttemptSession"("submissionId");
CREATE INDEX "ExamAttemptSession_userId_idx" ON "ExamAttemptSession"("userId");
CREATE INDEX "ExamAttemptSession_status_idx" ON "ExamAttemptSession"("status");
CREATE INDEX "ExamAttemptSession_lastSeenAt_idx" ON "ExamAttemptSession"("lastSeenAt");
CREATE INDEX "ExamAttemptSession_deviceTokenHash_idx" ON "ExamAttemptSession"("deviceTokenHash");

ALTER TABLE "ExamAttemptSession" ADD CONSTRAINT "ExamAttemptSession_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamAttemptSession" ADD CONSTRAINT "ExamAttemptSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "SessionIntegritySignal" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "examAttemptSessionId" TEXT,
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

    CONSTRAINT "SessionIntegritySignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SessionIntegritySignal_submissionId_idx" ON "SessionIntegritySignal"("submissionId");
CREATE INDEX "SessionIntegritySignal_examAttemptSessionId_idx" ON "SessionIntegritySignal"("examAttemptSessionId");
CREATE INDEX "SessionIntegritySignal_reviewStatus_idx" ON "SessionIntegritySignal"("reviewStatus");

ALTER TABLE "SessionIntegritySignal" ADD CONSTRAINT "SessionIntegritySignal_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionIntegritySignal" ADD CONSTRAINT "SessionIntegritySignal_examAttemptSessionId_fkey" FOREIGN KEY ("examAttemptSessionId") REFERENCES "ExamAttemptSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SessionIntegritySignal" ADD CONSTRAINT "SessionIntegritySignal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "AnswerActivityEvent" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "questionId" TEXT,
    "examAttemptSessionId" TEXT,
    "eventType" TEXT NOT NULL,
    "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientElapsedMs" INTEGER,
    "questionIndex" INTEGER,
    "responseLength" INTEGER,
    "responseHash" TEXT,
    "responseLengthDelta" INTEGER,
    "previousEventId" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnswerActivityEvent_submissionId_idx" ON "AnswerActivityEvent"("submissionId");
CREATE INDEX "AnswerActivityEvent_questionId_idx" ON "AnswerActivityEvent"("questionId");
CREATE INDEX "AnswerActivityEvent_examAttemptSessionId_idx" ON "AnswerActivityEvent"("examAttemptSessionId");
CREATE INDEX "AnswerActivityEvent_eventType_idx" ON "AnswerActivityEvent"("eventType");
CREATE INDEX "AnswerActivityEvent_serverReceivedAt_idx" ON "AnswerActivityEvent"("serverReceivedAt");

ALTER TABLE "AnswerActivityEvent" ADD CONSTRAINT "AnswerActivityEvent_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnswerActivityEvent" ADD CONSTRAINT "AnswerActivityEvent_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnswerActivityEvent" ADD CONSTRAINT "AnswerActivityEvent_examAttemptSessionId_fkey" FOREIGN KEY ("examAttemptSessionId") REFERENCES "ExamAttemptSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TimingAnalysis" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "overallSignalLevel" TEXT NOT NULL DEFAULT 'NONE',
    "algorithmVersion" TEXT NOT NULL,
    "analysedAt" TIMESTAMP(3),
    "requestedById" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL DEFAULT 'NO_IMMEDIATE_ACTION',
    "reasonCodesJson" JSONB,
    "summaryJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimingAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TimingAnalysis_submissionId_key" ON "TimingAnalysis"("submissionId");
CREATE INDEX "TimingAnalysis_examId_idx" ON "TimingAnalysis"("examId");
CREATE INDEX "TimingAnalysis_status_idx" ON "TimingAnalysis"("status");

ALTER TABLE "TimingAnalysis" ADD CONSTRAINT "TimingAnalysis_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimingAnalysis" ADD CONSTRAINT "TimingAnalysis_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimingAnalysis" ADD CONSTRAINT "TimingAnalysis_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TimingIntegritySignal" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
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

    CONSTRAINT "TimingIntegritySignal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TimingIntegritySignal_analysisId_idx" ON "TimingIntegritySignal"("analysisId");
CREATE INDEX "TimingIntegritySignal_reviewStatus_idx" ON "TimingIntegritySignal"("reviewStatus");

ALTER TABLE "TimingIntegritySignal" ADD CONSTRAINT "TimingIntegritySignal_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "TimingAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimingIntegritySignal" ADD CONSTRAINT "TimingIntegritySignal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. All five new tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_name IN ('ExamAttemptSession', 'SessionIntegritySignal',
--   'AnswerActivityEvent', 'TimingAnalysis', 'TimingIntegritySignal');

-- 2. No existing table/column was altered — spot-check Submission, Question,
--    Exam, and User still have their original column sets:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Question' ORDER BY ordinal_position;

-- 3. No column here ever holds a raw IP, raw token, or raw user-agent
--    string — spot-check column names contain only "Hash"/"Family"/
--    "Category"/"Version"/"State" suffixes for anything network/device
--    related:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'ExamAttemptSession' ORDER BY ordinal_position;

-- 4. Foreign keys exist with the expected delete behavior (CASCADE for
--    session/signal/event/analysis ownership, SET NULL for optional
--    session/question/reviewer references):
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
-- FROM pg_constraint
-- WHERE conrelid IN (
--   '"ExamAttemptSession"'::regclass, '"SessionIntegritySignal"'::regclass,
--   '"AnswerActivityEvent"'::regclass, '"TimingAnalysis"'::regclass,
--   '"TimingIntegritySignal"'::regclass
-- ) AND contype = 'f';

-- 5. Zero rows exist immediately after migration (nothing runs until the
--    exam page's first heartbeat, an answer autosave, or a lecturer
--    explicitly runs timing analysis):
-- SELECT count(*) FROM "ExamAttemptSession";
-- SELECT count(*) FROM "SessionIntegritySignal";
-- SELECT count(*) FROM "AnswerActivityEvent";
-- SELECT count(*) FROM "TimingAnalysis";
-- SELECT count(*) FROM "TimingIntegritySignal";

-- This migration is purely additive and safe to apply to a live
-- production database at any time: it creates five new tables and adds
-- no columns to any existing table. Every existing Submission/Question/
-- Exam/User row is completely unaffected. No backfill is required or
-- possible — an in-progress attempt that started BEFORE this migration
-- and deployment simply has no ExamAttemptSession row until its next
-- heartbeat/answer-save after deployment, at which point one is created
-- exactly as for a brand-new attempt; the attempt itself is never
-- interrupted, and no historical timing data is invented for it (see
-- docs/exam-session-binding-v1.md, "Behaviour for in-progress attempts
-- across deployment").
