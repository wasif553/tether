-- Tether Secure Exam Recovery and Resilient Autosave v1 — see
-- docs/tether-secure-resume-recovery-v1.md.
--
-- ALTERS three EXISTING tables only — no new table, no dropped/renamed/
-- retyped column, no other table touched. Every new column is nullable or
-- has a safe default; existing rows are never retroactively affected.
--
--   "SecureClientSession": three new nullable columns
--     ("closedAt" timestamp, "closeReason" text, "recoveryOfSessionId"
--     text) plus one index and one self-referencing foreign key. See
--     schema comment above `closedAt` on that model for the full
--     rationale — a crash/relaunch supersedes the old session (status set
--     to the existing "ENDED" value, these two new fields record why)
--     rather than silently reusing its already-VERIFIED state.
--   "Submission": four new columns — "resumeCount" (integer, NOT NULL
--     DEFAULT 0), "lastResumedAt" (timestamp, nullable),
--     "lastAutosaveAcknowledgedAt" (timestamp, nullable),
--     "finalSubmissionRequestId" (text, nullable, UNIQUE).
--   "Answer": two new nullable columns — "lastClientRequestId" (text),
--     "clientRevision" (integer).
--
-- Generated the same way every migration file in this project is (see
-- docs/migration-ledger.md, "Migration convention"): hand-extracted from
-- `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma
-- --script`, reduced to just the new/changed statements for this feature.
--
-- Apply this file AFTER every migration file already recorded as applied
-- in docs/migration-ledger.md (in particular
-- docs/secure-client-foundation-seb-v1-migration.sql, since the new
-- "SecureClientSession"."recoveryOfSessionId" foreign key references that
-- same table). Preview and Production share ONE Supabase database (see
-- docs/migration-ledger.md) — apply this file ONCE, manually, through the
-- Supabase SQL Editor, after review. Do not run `prisma db push`,
-- `prisma migrate dev`, `prisma migrate deploy`, or `prisma migrate
-- resolve` against the shared database. Every statement below is
-- idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards), so this
-- file is safe to re-run if an earlier attempt was interrupted before
-- COMMIT — but do not deliberately re-apply it after a confirmed success
-- (see "Post-application verification" below and the ledger entry this
-- file should get once applied). NOT applied by the assistant that
-- generated it.

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first. Expect every one of these to
-- return ZERO rows.
-- ---------------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN ('closedAt', 'closeReason', 'recoveryOfSessionId');
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'Submission'
--   AND column_name IN ('resumeCount', 'lastResumedAt', 'lastAutosaveAcknowledgedAt', 'finalSubmissionRequestId');
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'Answer'
--   AND column_name IN ('lastClientRequestId', 'clientRevision');

BEGIN;

ALTER TABLE "public"."SecureClientSession"
    ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "closeReason" TEXT,
    ADD COLUMN IF NOT EXISTS "recoveryOfSessionId" TEXT;

CREATE INDEX IF NOT EXISTS "SecureClientSession_recoveryOfSessionId_idx"
    ON "public"."SecureClientSession" ("recoveryOfSessionId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SecureClientSession_recoveryOfSessionId_fkey'
    ) THEN
        ALTER TABLE "public"."SecureClientSession"
            ADD CONSTRAINT "SecureClientSession_recoveryOfSessionId_fkey"
            FOREIGN KEY ("recoveryOfSessionId") REFERENCES "public"."SecureClientSession"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

ALTER TABLE "public"."Submission"
    ADD COLUMN IF NOT EXISTS "resumeCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "lastResumedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "lastAutosaveAcknowledgedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "finalSubmissionRequestId" TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Submission_finalSubmissionRequestId_key'
    ) THEN
        ALTER TABLE "public"."Submission"
            ADD CONSTRAINT "Submission_finalSubmissionRequestId_key" UNIQUE ("finalSubmissionRequestId");
    END IF;
END $$;

ALTER TABLE "public"."Answer"
    ADD COLUMN IF NOT EXISTS "lastClientRequestId" TEXT,
    ADD COLUMN IF NOT EXISTS "clientRevision" INTEGER;

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-application verification.
-- ---------------------------------------------------------------------------
-- SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN ('closedAt', 'closeReason', 'recoveryOfSessionId')
-- ORDER BY column_name;
-- (Expected: three rows; recoveryOfSessionId nullable text)
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'SecureClientSession'
--   AND indexname = 'SecureClientSession_recoveryOfSessionId_idx';
-- (Expected: one row)
--
-- SELECT conname FROM pg_constraint WHERE conname = 'SecureClientSession_recoveryOfSessionId_fkey';
-- (Expected: one row)
--
-- SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'Submission'
--   AND column_name IN ('resumeCount', 'lastResumedAt', 'lastAutosaveAcknowledgedAt', 'finalSubmissionRequestId')
-- ORDER BY column_name;
-- (Expected: four rows; resumeCount integer NOT NULL DEFAULT 0, the other
--  three nullable)
--
-- SELECT conname FROM pg_constraint WHERE conname = 'Submission_finalSubmissionRequestId_key';
-- (Expected: one row)
--
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'Answer'
--   AND column_name IN ('lastClientRequestId', 'clientRevision')
-- ORDER BY column_name;
-- (Expected: two rows, both nullable)
--
-- Existing rows never retroactively populated with anything but the safe
-- default/NULL:
-- SELECT count(*) FROM "public"."Submission" WHERE "resumeCount" <> 0;
-- (Expected: 0 immediately after applying)
-- SELECT count(*) FROM "public"."Submission" WHERE "lastResumedAt" IS NOT NULL OR "finalSubmissionRequestId" IS NOT NULL;
-- (Expected: 0 immediately after applying)
-- SELECT count(*) FROM "public"."SecureClientSession" WHERE "closedAt" IS NOT NULL OR "recoveryOfSessionId" IS NOT NULL;
-- (Expected: 0 immediately after applying)
-- SELECT count(*) FROM "public"."Answer" WHERE "lastClientRequestId" IS NOT NULL OR "clientRevision" IS NOT NULL;
-- (Expected: 0 immediately after applying)
--
-- Existing tables provably untouched — row counts identical before/after:
-- SELECT count(*) FROM "public"."SecureClientSession";
-- SELECT count(*) FROM "public"."Submission";
-- SELECT count(*) FROM "public"."Answer";

-- ---------------------------------------------------------------------------
-- Rollback — additive-only, touches no existing row's data:
-- ---------------------------------------------------------------------------
-- ALTER TABLE "public"."SecureClientSession" DROP CONSTRAINT IF EXISTS "SecureClientSession_recoveryOfSessionId_fkey";
-- DROP INDEX IF EXISTS "SecureClientSession_recoveryOfSessionId_idx";
-- ALTER TABLE "public"."SecureClientSession"
--     DROP COLUMN IF EXISTS "closedAt",
--     DROP COLUMN IF EXISTS "closeReason",
--     DROP COLUMN IF EXISTS "recoveryOfSessionId";
-- ALTER TABLE "public"."Submission" DROP CONSTRAINT IF EXISTS "Submission_finalSubmissionRequestId_key";
-- ALTER TABLE "public"."Submission"
--     DROP COLUMN IF EXISTS "resumeCount",
--     DROP COLUMN IF EXISTS "lastResumedAt",
--     DROP COLUMN IF EXISTS "lastAutosaveAcknowledgedAt",
--     DROP COLUMN IF EXISTS "finalSubmissionRequestId";
-- ALTER TABLE "public"."Answer"
--     DROP COLUMN IF EXISTS "lastClientRequestId",
--     DROP COLUMN IF EXISTS "clientRevision";
--
-- Preferred approach in practice: every application code path already
-- treats a missing/null value on any of these nine columns as "no
-- idempotency/recovery history on record yet" (never as an error, never
-- as a security-relevant default) — see parseSecureSettings-style
-- fallback handling throughout src/lib/tetherRecovery*.ts and the
-- answers/submit routes. Ensuring no exam is actively relying on
-- crash-recovery/idempotent-autosave behaviour is a sufficient practical
-- "rollback" for almost any issue; dropping the columns is rarely
-- necessary.
