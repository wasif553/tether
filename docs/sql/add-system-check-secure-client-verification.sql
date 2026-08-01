-- Tether System Check and Exam Readiness v1 — corrective pass (first-time
-- verification) + security hardening pass (adds
-- "displayTopologyClassification", the signature-bound authoritative
-- native display-topology fact) + Secure Client Attestation v2 (adds
-- "installationId", required — see
-- docs/sql/add-tether-client-installation.sql for the companion table
-- this column references, and docs/tether-system-check-v1.md) + EXAM_SESSION
-- v2 wiring (adds "attestationProtocolVersion", evidence-only — see
-- docs/sql/add-secure-client-session-installation-attestation.sql for the
-- companion SecureClientSession columns). This table has not been applied
-- to Preview/Production yet, so this file is updated in place rather than
-- adding a second ALTER TABLE file.
--
-- Adds ONE new, fully additive table: "SystemCheckSecureClientVerification".
-- Does not alter, rename, or drop any existing table, column, index,
-- enum, or constraint. Does not touch Submission, SecureClientSession,
-- SecureClientLaunchManifest, SecureClientEvent, IntegrityEvent, or any
-- exam-settings data — nothing in the exam-launch code path ever reads
-- this table (see the model's own doc comment in prisma/schema.prisma).
--
-- Preview and Production share one Supabase database (see
-- docs/migration-ledger.md) — this file must be applied ONCE, manually,
-- through the Supabase SQL Editor, after review. Do not run
-- `prisma db push`, `prisma migrate dev`, `prisma migrate deploy`, or
-- `prisma migrate resolve` against the shared database. Safe to run
-- more than once (every statement is idempotent via IF NOT EXISTS
-- guards). NOT applied by the assistant that generated it.

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first. Expect NULL (table absent).
-- ---------------------------------------------------------------------------
-- SELECT to_regclass('public."SystemCheckSecureClientVerification"') AS existing_table;

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."SystemCheckSecureClientVerification" (
    "id"                 TEXT NOT NULL,
    "userId"             TEXT NOT NULL,
    "institutionId"      TEXT NOT NULL,
    "purpose"            TEXT NOT NULL DEFAULT 'SYSTEM_CHECK',
    "attestationProtocolVersion" INTEGER NOT NULL DEFAULT 2,
    "installationId"     TEXT NOT NULL,
    "clientType"         TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'NOT_CHECKED',
    "clientVersion"      TEXT,
    "platform"           TEXT,
    "displayTopologyClassification" TEXT,
    "nonceHash"          TEXT NOT NULL,
    "challengeHash"      TEXT NOT NULL,
    "issuedAt"           TIMESTAMP(3) NOT NULL,
    "expiresAt"          TIMESTAMP(3) NOT NULL,
    "verifiedAt"         TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemCheckSecureClientVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SystemCheckSecureClientVerification_nonceHash_key"
    ON "public"."SystemCheckSecureClientVerification" ("nonceHash");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SystemCheckSecureClientVerification_userId_fkey'
    ) THEN
        ALTER TABLE "public"."SystemCheckSecureClientVerification"
            ADD CONSTRAINT "SystemCheckSecureClientVerification_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "public"."User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "SystemCheckSecureClientVerification_userId_createdAt_idx"
    ON "public"."SystemCheckSecureClientVerification" ("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "SystemCheckSecureClientVerification_expiresAt_idx"
    ON "public"."SystemCheckSecureClientVerification" ("expiresAt");

CREATE INDEX IF NOT EXISTS "SystemCheckSecureClientVerification_installationId_idx"
    ON "public"."SystemCheckSecureClientVerification" ("installationId");

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-application verification.
-- ---------------------------------------------------------------------------
-- SELECT to_regclass('public."SystemCheckSecureClientVerification"') AS created_table;
-- (Expected: "SystemCheckSecureClientVerification")
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'SystemCheckSecureClientVerification'
-- ORDER BY indexname;
-- (Expected: SystemCheckSecureClientVerification_expiresAt_idx,
--            SystemCheckSecureClientVerification_installationId_idx,
--            SystemCheckSecureClientVerification_nonceHash_key,
--            SystemCheckSecureClientVerification_pkey,
--            SystemCheckSecureClientVerification_userId_createdAt_idx)
--
-- SELECT conname FROM pg_constraint WHERE conname = 'SystemCheckSecureClientVerification_userId_fkey';
-- (Expected: one row)
--
-- SELECT count(*) FROM "public"."SystemCheckSecureClientVerification";
-- (Expected: 0 immediately after applying)
--
-- Existing tables provably untouched — row counts identical before/after:
-- SELECT count(*) FROM "public"."SecureClientSession";
-- SELECT count(*) FROM "public"."SecureClientLaunchManifest";
-- SELECT count(*) FROM "public"."Submission";
