-- Secure Client Attestation v2 — EXAM_SESSION wiring into real exam
-- sessions. See docs/tether-system-check-v1.md, "Real exam attestation —
-- installation-bound v2".
--
-- ALTERS the EXISTING "SecureClientSession" table (part of the original
-- baseline schema, already live in Preview/Production — unlike the newer
-- v2 tables, this table predates the "manual SQL only" discipline and has
-- no earlier docs/sql/*.sql file of its own). Adds FIVE new, entirely
-- additive, nullable-or-defaulted columns plus one index and one advisory
-- foreign key. Does not rename, drop, or change the type of any existing
-- column; does not touch any other table. Existing rows get
-- "installationAttestationVerified" = false and every other new column
-- NULL — never retroactively "verified".
--
-- These columns are evidence/outcome fields for the NEW v2 EXAM_SESSION
-- attestation path only. They are never read or written by the existing,
-- unmodified legacy attestation flow (recordAttestation() in
-- secureClientRunner.ts) — that flow continues to own
-- "status"/"verificationStatus" exactly as before. Whether v2 evidence
-- here actually gates real exam content access is decided entirely at
-- request time by resolveEffectiveTetherVerification()
-- (src/lib/secureClient/examAttestationMode.ts), governed by the
-- TETHER_EXAM_ATTESTATION_MODE environment variable — safe default
-- LEGACY, under which these new columns are recorded but have zero
-- effect on any access decision.
--
-- Apply this file AFTER docs/sql/add-tether-client-installation.sql (the
-- new foreign key references "TetherClientInstallation"."id").
--
-- Preview and Production share one Supabase database (see
-- docs/migration-ledger.md) — this file must be applied ONCE, manually,
-- through the Supabase SQL Editor, after review. Do not run
-- `prisma db push`, `prisma migrate dev`, `prisma migrate deploy`, or
-- `prisma migrate resolve` against the shared database. Safe to run more
-- than once (every statement is idempotent via IF NOT EXISTS /
-- ADD COLUMN IF NOT EXISTS guards). NOT applied by the assistant that
-- generated it.

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first. Expect the five new columns
-- to be ABSENT.
-- ---------------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name LIKE 'installation%' OR column_name = 'clientInstallationId'
-- ORDER BY column_name;
-- (Expected: zero rows)

BEGIN;

ALTER TABLE "public"."SecureClientSession"
    ADD COLUMN IF NOT EXISTS "clientInstallationId" TEXT,
    ADD COLUMN IF NOT EXISTS "installationAttestationVerified" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "installationAttestationVerifiedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "installationAttestationFailureReason" TEXT,
    ADD COLUMN IF NOT EXISTS "installationVerificationId" TEXT;

CREATE INDEX IF NOT EXISTS "SecureClientSession_clientInstallationId_idx"
    ON "public"."SecureClientSession" ("clientInstallationId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SecureClientSession_clientInstallationId_fkey'
    ) THEN
        ALTER TABLE "public"."SecureClientSession"
            ADD CONSTRAINT "SecureClientSession_clientInstallationId_fkey"
            FOREIGN KEY ("clientInstallationId") REFERENCES "public"."TetherClientInstallation"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-application verification.
-- ---------------------------------------------------------------------------
-- SELECT column_name, data_type, column_default FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN ('clientInstallationId', 'installationAttestationVerified',
--                        'installationAttestationVerifiedAt', 'installationAttestationFailureReason',
--                        'installationVerificationId')
-- ORDER BY column_name;
-- (Expected: five rows)
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'SecureClientSession'
--   AND indexname = 'SecureClientSession_clientInstallationId_idx';
-- (Expected: one row)
--
-- SELECT conname FROM pg_constraint WHERE conname = 'SecureClientSession_clientInstallationId_fkey';
-- (Expected: one row)
--
-- Existing rows never retroactively verified:
-- SELECT count(*) FROM "public"."SecureClientSession" WHERE "installationAttestationVerified" = true;
-- (Expected: 0 immediately after applying)
--
-- Existing tables/columns provably untouched — row counts identical before/after:
-- SELECT count(*) FROM "public"."SecureClientSession";
-- SELECT count(*) FROM "public"."Submission";
-- SELECT count(*) FROM "public"."TetherClientInstallation";
