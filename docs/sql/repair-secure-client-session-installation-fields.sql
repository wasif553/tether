-- PRODUCTION SCHEMA REPAIR — SecureClientSession installation-attestation
-- fields. See docs/migration-ledger.md, row 17.
--
-- INCIDENT: Production began failing with Prisma error P2022
-- ("The column `SecureClientSession.clientInstallationId` does not
-- exist in the current database.") A read-only check against the
-- shared Supabase database confirmed that of
-- clientInstallationId / installationAttestationVerified /
-- attestationRequirement / verificationStatus, only "verificationStatus"
-- (a BASELINE column from docs/secure-client-foundation-seb-v1-migration.sql,
-- ledger row 14, confirmed applied 2026-07-25) actually exists. The
-- other three — and, by the same root cause, the three sibling columns
-- below that were never individually checked — are confirmed missing.
--
-- ROOT CAUSE: this is NOT a defect in the 2026-08-02 migration
-- (docs/sql/add-tether-secure-resume-recovery.sql, ledger row 15,
-- confirmed applied). That file only ever added
-- "closedAt"/"closeReason"/"recoveryOfSessionId" to SecureClientSession
-- — it never touched any installation-attestation column and was never
-- meant to. The actual source of truth for the missing columns is a
-- SEPARATE, EARLIER file, docs/sql/add-secure-client-session-installation-attestation.sql
-- (first added to the repository 2026-08-01, in the "Secure Client
-- Attestation v2" / installation-bound-attestation work — see
-- docs/tether-system-check-v1.md). That file was never applied AND was
-- never added to docs/migration-ledger.md at all (confirmed: no ledger
-- row references it, nor its four sibling files from the same feature
-- work — docs/sql/add-tether-client-installation.sql,
-- docs/sql/add-tether-installation-registration-challenge.sql,
-- docs/sql/add-system-check-secure-client-verification.sql,
-- docs/sql/add-tether-system-check-readiness.sql). It fell through the
-- ledger's own tracking process entirely — this repair closes that gap
-- for SecureClientSession specifically; the other four files are a
-- separate, out-of-scope finding recorded in the incident report, not
-- repaired here.
--
-- SIX confirmed-missing, entirely additive columns (derived from
-- prisma/schema.prisma's SecureClientSession model, cross-checked
-- against add-secure-client-session-installation-attestation.sql's own
-- statements — not inferred from field names alone) plus one index and
-- one advisory foreign key. Does not rename, drop, retype, or rewrite
-- any existing column; does not touch any other table; preserves every
-- existing row exactly as-is (every new column is nullable or
-- defaults to a value that means "no v2 attestation evidence yet" —
-- never retroactively "verified", never retroactively assigned an
-- attestation requirement).
--
-- DEPENDENCY: the foreign key below references
-- "TetherClientInstallation"("id") (created by
-- docs/sql/add-tether-client-installation.sql). Whether that table
-- exists in the shared database was NOT confirmed as part of this
-- incident (the read-only check that triggered this repair only
-- queried SecureClientSession's own columns) — the pre-check below
-- includes an explicit, informational check for it. If it is absent,
-- the ADD CONSTRAINT step will fail with a clear Postgres error and the
-- whole transaction will roll back (nothing partially applied) — do not
-- work around that by removing the foreign key; resolve the missing
-- prerequisite table first.
--
-- Preview and Production share ONE Supabase database (see
-- docs/migration-ledger.md) — apply this file ONCE, manually, through
-- the Supabase SQL Editor, after review and after confirming the
-- TetherClientInstallation dependency above. Do not run `prisma db
-- push`, `prisma migrate dev`, `prisma migrate deploy`, or `prisma
-- migrate resolve` against the shared database. Every statement is
-- idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards), so this
-- file is safe to re-run if an earlier attempt was interrupted before
-- COMMIT — but do not deliberately re-apply it after a confirmed
-- success. NOT applied by the assistant that generated it.

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first.
-- ---------------------------------------------------------------------------
-- Expect ZERO rows (confirms the six columns are genuinely absent —
-- matches the incident's own read-only finding for three of them):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN (
--     'clientInstallationId', 'installationAttestationVerified',
--     'installationAttestationVerifiedAt', 'installationAttestationFailureReason',
--     'installationVerificationId', 'attestationRequirement'
--   );
--
-- Expect exactly one row ("verificationStatus") — confirms the baseline
-- table itself is intact and this is a narrow, additive gap, not a
-- missing/corrupt table:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN ('clientInstallationId', 'installationAttestationVerified',
--                        'attestationRequirement', 'verificationStatus');
--
-- Informational only — confirms whether the foreign-key dependency
-- below can succeed. A NULL result means "TetherClientInstallation does
-- not exist yet" — resolve that separately before applying this file:
-- SELECT to_regclass('public."TetherClientInstallation"') AS dependency_table;

BEGIN;

ALTER TABLE "public"."SecureClientSession"
    ADD COLUMN IF NOT EXISTS "clientInstallationId" TEXT,
    ADD COLUMN IF NOT EXISTS "installationAttestationVerified" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "installationAttestationVerifiedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "installationAttestationFailureReason" TEXT,
    ADD COLUMN IF NOT EXISTS "installationVerificationId" TEXT,
    ADD COLUMN IF NOT EXISTS "attestationRequirement" TEXT;

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
-- SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN ('clientInstallationId', 'installationAttestationVerified',
--                        'installationAttestationVerifiedAt', 'installationAttestationFailureReason',
--                        'installationVerificationId', 'attestationRequirement')
-- ORDER BY column_name;
-- (Expected: six rows; installationAttestationVerified boolean NOT NULL
--  DEFAULT false, the other five nullable with no default)
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'SecureClientSession'
--   AND indexname = 'SecureClientSession_clientInstallationId_idx';
-- (Expected: one row)
--
-- SELECT conname FROM pg_constraint WHERE conname = 'SecureClientSession_clientInstallationId_fkey';
-- (Expected: one row)
--
-- Existing rows never retroactively verified or assigned a requirement:
-- SELECT count(*) FROM "public"."SecureClientSession" WHERE "installationAttestationVerified" = true;
-- (Expected: 0 immediately after applying)
-- SELECT count(*) FROM "public"."SecureClientSession"
-- WHERE "clientInstallationId" IS NOT NULL OR "attestationRequirement" IS NOT NULL
--    OR "installationAttestationVerifiedAt" IS NOT NULL OR "installationAttestationFailureReason" IS NOT NULL
--    OR "installationVerificationId" IS NOT NULL;
-- (Expected: 0 immediately after applying)
--
-- Existing tables/rows provably untouched — row counts identical before/after:
-- SELECT count(*) FROM "public"."SecureClientSession";
-- SELECT count(*) FROM "public"."TetherClientInstallation";

-- ---------------------------------------------------------------------------
-- Rollback — additive-only, touches no existing row's data:
-- ---------------------------------------------------------------------------
-- ALTER TABLE "public"."SecureClientSession" DROP CONSTRAINT IF EXISTS "SecureClientSession_clientInstallationId_fkey";
-- DROP INDEX IF EXISTS "SecureClientSession_clientInstallationId_idx";
-- ALTER TABLE "public"."SecureClientSession"
--     DROP COLUMN IF EXISTS "clientInstallationId",
--     DROP COLUMN IF EXISTS "installationAttestationVerified",
--     DROP COLUMN IF EXISTS "installationAttestationVerifiedAt",
--     DROP COLUMN IF EXISTS "installationAttestationFailureReason",
--     DROP COLUMN IF EXISTS "installationVerificationId",
--     DROP COLUMN IF EXISTS "attestationRequirement";
--
-- Preferred approach in practice: every application code path already
-- treats a missing/null value on any of these six columns as "no v2
-- attestation evidence on record" (this is, after all, exactly the
-- state the live database has been running in since these columns were
-- never applied) — see resolveEffectiveTetherVerification in
-- src/lib/tetherAttestationConfig.ts, which falls back to LEGACY
-- whenever attestationRequirement is NULL. Ensuring no exam relies on
-- v2/installation-bound attestation behaviour is a sufficient practical
-- "rollback" for almost any issue; dropping the columns is rarely
-- necessary, and doing so would simply restore the exact P2022 failure
-- this file exists to repair.
