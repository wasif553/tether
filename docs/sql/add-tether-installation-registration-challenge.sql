-- Pre-Preview safety pass — see docs/tether-system-check-v1.md,
-- "Single-use registration challenges".
--
-- Adds ONE new, fully additive table:
-- "TetherInstallationRegistrationChallenge". Does not alter, rename, or
-- drop any existing table, column, index, enum, or constraint. Does not
-- touch Submission, SecureClientSession, TetherClientInstallation, or any
-- exam-launch data.
--
-- Records ONLY the atomic CONSUMPTION of a registration challenge — a
-- row is written here inside the SAME transaction as creating the
-- TetherClientInstallation row it registered (registerInstallation in
-- tetherAttestationRunner.ts), never at challenge-issuance time (issuing
-- a challenge remains stateless, matching every other short-lived signed
-- challenge in this codebase). A second registration attempt with the
-- same nonce fails the unique constraint on "nonceHash" outright, and
-- the whole transaction — including the TetherClientInstallation insert
-- — rolls back together; there is no path that creates an installation
-- without also recording its challenge's consumption, or vice versa.
--
-- Never stores: private keys, plaintext DPAPI material, a full reusable
-- challenge token, authentication tokens, or any hardware identifier
-- beyond the installation's own self-generated public-key fingerprint
-- (already stored, unencrypted, on TetherClientInstallation itself).
--
-- Preview and Production share one Supabase database (see
-- docs/migration-ledger.md) — this file must be applied ONCE, manually,
-- through the Supabase SQL Editor, after review. Do not run
-- `prisma db push`, `prisma migrate dev`, `prisma migrate deploy`, or
-- `prisma migrate resolve` against the shared database. Safe to run more
-- than once (every statement is idempotent via IF NOT EXISTS guards).
-- NOT applied by the assistant that generated it.
--
-- Apply this file AFTER docs/sql/add-tether-client-installation.sql (the
-- new foreign key references "User"."id", which every other file in
-- this feature already assumes exists).

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first. Expect NULL (table absent).
-- ---------------------------------------------------------------------------
-- SELECT to_regclass('public."TetherInstallationRegistrationChallenge"') AS existing_table;

BEGIN;

CREATE TABLE IF NOT EXISTS "public"."TetherInstallationRegistrationChallenge" (
    "id"                   TEXT NOT NULL,
    "userId"               TEXT NOT NULL,
    "publicKeyFingerprint" TEXT NOT NULL,
    "nonceHash"            TEXT NOT NULL,
    "consumedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TetherInstallationRegistrationChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TetherInstallationRegistrationChallenge_nonceHash_key"
    ON "public"."TetherInstallationRegistrationChallenge" ("nonceHash");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'TetherInstallationRegistrationChallenge_userId_fkey'
    ) THEN
        ALTER TABLE "public"."TetherInstallationRegistrationChallenge"
            ADD CONSTRAINT "TetherInstallationRegistrationChallenge_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "public"."User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "TetherInstallationRegistrationChallenge_userId_createdAt_idx"
    ON "public"."TetherInstallationRegistrationChallenge" ("userId", "createdAt");

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-application verification.
-- ---------------------------------------------------------------------------
-- SELECT to_regclass('public."TetherInstallationRegistrationChallenge"') AS created_table;
-- (Expected: "TetherInstallationRegistrationChallenge")
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'TetherInstallationRegistrationChallenge'
-- ORDER BY indexname;
-- (Expected: TetherInstallationRegistrationChallenge_nonceHash_key,
--            TetherInstallationRegistrationChallenge_pkey,
--            TetherInstallationRegistrationChallenge_userId_createdAt_idx)
--
-- SELECT conname FROM pg_constraint WHERE conname = 'TetherInstallationRegistrationChallenge_userId_fkey';
-- (Expected: one row)
--
-- SELECT count(*) FROM "public"."TetherInstallationRegistrationChallenge";
-- (Expected: 0 immediately after applying)
--
-- Existing tables provably untouched — row counts identical before/after:
-- SELECT count(*) FROM "public"."TetherClientInstallation";
-- SELECT count(*) FROM "public"."User";
