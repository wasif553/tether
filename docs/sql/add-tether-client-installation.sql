-- Secure Client Attestation v2 — see docs/tether-system-check-v1.md,
-- "Per-installation key" / "Installation registration".
--
-- Adds ONE new, fully additive table: "TetherClientInstallation". Does
-- not alter, rename, or drop any existing table, column, index, enum,
-- or constraint. This is the REPLACEMENT for the removed v1 design (a
-- single Ed25519 private key compiled into every packaged build) — each
-- installation now registers its OWN keypair here, so compromise of one
-- installation's key can never affect any other installation, and any
-- individual installation can be revoked independently.
--
-- Preview and Production share one Supabase database (see
-- docs/migration-ledger.md) — this file must be applied ONCE, manually,
-- through the Supabase SQL Editor, after review. Do not run
-- `prisma db push`, `prisma migrate dev`, `prisma migrate deploy`, or
-- `prisma migrate resolve` against the shared database. Safe to run more
-- than once (every statement is idempotent via IF NOT EXISTS guards).
-- NOT applied by the assistant that generated it.
--
-- Apply this file BEFORE, or together with,
-- docs/sql/add-system-check-secure-client-verification.sql — that
-- table's "installationId" column has no foreign key (advisory pointer
-- convention, matching other tables in this schema), so there is no
-- strict ordering requirement, but applying this one first is the more
-- intuitive order.

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first. Expect NULL (table absent).
-- ---------------------------------------------------------------------------
-- SELECT to_regclass('public."TetherClientInstallation"') AS existing_table;

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."TetherClientInstallation" (
    "id"                   TEXT NOT NULL,
    "userId"               TEXT NOT NULL,
    "institutionId"        TEXT NOT NULL,
    "publicKey"            TEXT NOT NULL,
    "publicKeyFingerprint" TEXT NOT NULL,
    "keyAlgorithm"         TEXT NOT NULL,
    "keyProtectionLevel"   TEXT NOT NULL DEFAULT 'SOFTWARE_PROTECTED',
    "clientVersion"        TEXT,
    "platform"             TEXT,
    "status"               TEXT NOT NULL DEFAULT 'ACTIVE',
    "installedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttestedAt"       TIMESTAMP(3),
    "revokedAt"            TIMESTAMP(3),
    "revocationReason"     TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TetherClientInstallation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TetherClientInstallation_publicKeyFingerprint_key"
    ON "public"."TetherClientInstallation" ("publicKeyFingerprint");

CREATE UNIQUE INDEX IF NOT EXISTS "TetherClientInstallation_userId_publicKeyFingerprint_key"
    ON "public"."TetherClientInstallation" ("userId", "publicKeyFingerprint");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'TetherClientInstallation_userId_fkey'
    ) THEN
        ALTER TABLE "public"."TetherClientInstallation"
            ADD CONSTRAINT "TetherClientInstallation_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "public"."User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "TetherClientInstallation_userId_status_idx"
    ON "public"."TetherClientInstallation" ("userId", "status");

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-application verification.
-- ---------------------------------------------------------------------------
-- SELECT to_regclass('public."TetherClientInstallation"') AS created_table;
-- (Expected: "TetherClientInstallation")
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'TetherClientInstallation'
-- ORDER BY indexname;
-- (Expected: TetherClientInstallation_pkey,
--            TetherClientInstallation_publicKeyFingerprint_key,
--            TetherClientInstallation_userId_publicKeyFingerprint_key,
--            TetherClientInstallation_userId_status_idx)
--
-- SELECT conname FROM pg_constraint WHERE conname = 'TetherClientInstallation_userId_fkey';
-- (Expected: one row)
--
-- SELECT count(*) FROM "public"."TetherClientInstallation";
-- (Expected: 0 immediately after applying)
--
-- Existing tables provably untouched — row counts identical before/after:
-- SELECT count(*) FROM "public"."SecureClientSession";
-- SELECT count(*) FROM "public"."Submission";
-- SELECT count(*) FROM "public"."User";
