-- Question Bank / Exam Pools redesign v1 (additive) — see
-- docs/question-bank-exam-pools-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the new/changed statements this feature
-- adds — Question already exists in production, so unlike a genuinely
-- new table (where the --from-empty diff's CREATE TABLE can be used
-- as-is), the two new columns below are hand-written as ALTER TABLE ADD
-- COLUMN statements; the two new index statements and the one new
-- foreign-key constraint ARE used verbatim from that diff's output.
-- Additive only — no existing table, column, constraint, or enum value
-- is changed or removed.
--
-- Changes:
--   1. Two new nullable columns on the EXISTING Question table:
--      - source (TEXT) — "MANUAL" | "AI_GENERATED" | "BULK_IMPORT" |
--        "QUESTION_BANK", validated in src/lib/questionSource.ts. A plain
--        String, not a Prisma enum, matching this schema's own
--        established convention (see SubmissionSimilarityAnalysis.status/
--        IntegrityEvidenceAsset) to avoid enum-alteration migration risk.
--        Null for every question created before this feature — their
--        real origin is genuinely unrecorded and is never guessed or
--        backfilled; only newly-created questions populate this field.
--      - sourceBankQuestionId (TEXT) — the BankQuestion this question was
--        copied FROM at copy time, never a live link (copying always
--        produces a fully independent Question row — see
--        mapBankQuestionToQuestionData in src/lib/questionBank.ts).
--        SET NULL on delete of the source BankQuestion/bank — deleting a
--        bank question must never delete or orphan an exam question that
--        has already been copied from it and may already have student
--        answers against it; it only loses the "copied from" trail.
--   2. Two new indexes supporting the "has this BankQuestion already been
--      copied into this exam" duplicate-detection query.
--   3. One new foreign key: Question.sourceBankQuestionId -> BankQuestion.id.
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
--   WHERE table_name = 'Question' AND column_name IN ('source', 'sourceBankQuestionId');
-- No rows -> safe to apply. Any rows -> this migration (or part of it)
-- has already run; investigate before re-applying.

-- ============================================================================
-- 1. AlterTable: Question — add the two new nullable provenance columns.
-- ============================================================================
ALTER TABLE "Question" ADD COLUMN "source" TEXT;
ALTER TABLE "Question" ADD COLUMN "sourceBankQuestionId" TEXT;

-- ============================================================================
-- 2. CreateIndex — supports the duplicate-detection lookup
--    (WHERE examId = ? AND sourceBankQuestionId IN (...)).
-- ============================================================================
CREATE INDEX "Question_examId_sourceBankQuestionId_idx" ON "Question"("examId", "sourceBankQuestionId");

CREATE INDEX "Question_sourceBankQuestionId_idx" ON "Question"("sourceBankQuestionId");

-- ============================================================================
-- 3. AddForeignKey — Question.sourceBankQuestionId -> BankQuestion.id.
--    ON DELETE SET NULL: deleting a BankQuestion (or its whole bank, which
--    cascades to BankQuestion) must never delete or orphan any exam
--    Question already copied from it.
-- ============================================================================
ALTER TABLE "Question" ADD CONSTRAINT "Question_sourceBankQuestionId_fkey" FOREIGN KEY ("sourceBankQuestionId") REFERENCES "BankQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
