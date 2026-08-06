-- PRODUCTION SCHEMA REPAIR — complete installation-attestation
-- foundation rollout. See docs/migration-ledger.md, row 17.
--
-- SUPERSEDES docs/sql/repair-secure-client-session-installation-fields.sql
-- (deleted from the repository as part of this change — its scope, the
-- six SecureClientSession columns, is a strict subset of Block 5 below,
-- so leaving both files would only invite applying a partial repair by
-- mistake). If that file was already applied to any environment before
-- this one exists, Block 5 below is a no-op there (every statement is
-- IF NOT EXISTS) — safe either way.
--
-- INCIDENT: Production Prisma error P2022
-- (`SecureClientSession.clientInstallationId does not exist`). Follow-up
-- live-database evidence additionally confirmed
-- `SELECT to_regclass('public."TetherClientInstallation"')` returns
-- NULL — the table the original narrow repair's foreign key depends on
-- is ALSO missing, so that repair cannot be applied as-is. The six
-- currently-visible related tables in production are
-- SecureClientAttestation, SecureClientConfiguration, SecureClientEvent,
-- SecureClientLaunchManifest, SecureClientRecoveryGrant, and
-- SecureClientSession — none of TetherClientInstallation,
-- TetherInstallationRegistrationChallenge,
-- SystemCheckSecureClientVerification, or TetherSystemCheckRun appear
-- in that list, consistent with an entire feature rollout (five SQL
-- files, all written 2026-07-30 through 2026-08-01 as part of "Tether
-- System Check and Exam Readiness v1" / "Secure Client Attestation v2")
-- never having been applied AND never having been added to
-- docs/migration-ledger.md at all. This file does not ASSUME that from
-- the table-list alone, though — the pre-check section below verifies
-- every individual object.
--
-- SCOPE — consolidates, faithfully and without modification to their
-- own logic, the five previously untracked files below, applied in
-- their required dependency order:
--
--   Block 1 — docs/sql/add-tether-client-installation.sql
--     CREATE TABLE "TetherClientInstallation" (id, userId, institutionId,
--     publicKey, publicKeyFingerprint, keyAlgorithm, keyProtectionLevel
--     DEFAULT 'SOFTWARE_PROTECTED', clientVersion, platform, status
--     DEFAULT 'ACTIVE', installedAt DEFAULT now(), lastAttestedAt,
--     revokedAt, revocationReason, createdAt DEFAULT now(), updatedAt).
--     PK on id. UNIQUE on publicKeyFingerprint. UNIQUE on
--     (userId, publicKeyFingerprint). Index on (userId, status). FK
--     userId -> User(id) ON DELETE CASCADE ON UPDATE CASCADE. No enum
--     types, no check constraints — every "enum-like" column
--     (keyProtectionLevel, status) is a validated TEXT column, not a
--     Postgres CREATE TYPE enum. Depends only on the baseline "User"
--     table.
--
--   Block 2 — docs/sql/add-tether-installation-registration-challenge.sql
--     CREATE TABLE "TetherInstallationRegistrationChallenge" (id,
--     userId, publicKeyFingerprint, nonceHash, consumedAt DEFAULT now(),
--     createdAt DEFAULT now()). PK on id. UNIQUE on nonceHash. Index on
--     (userId, createdAt). FK userId -> User(id) ON DELETE CASCADE ON
--     UPDATE CASCADE. Depends only on "User" — its own header comment's
--     stated "apply after add-tether-client-installation.sql" is a
--     feature-sequencing preference, not a real SQL dependency (its only
--     foreign key targets User, never TetherClientInstallation); still
--     honoured here for clarity, applied as Block 2.
--
--   Block 3 — docs/sql/add-system-check-secure-client-verification.sql
--     CREATE TABLE "SystemCheckSecureClientVerification" (id, userId,
--     institutionId, purpose DEFAULT 'SYSTEM_CHECK',
--     attestationProtocolVersion DEFAULT 2, installationId [advisory,
--     NO foreign key — matches this schema's existing
--     clientInstallationIdHash-style advisory-pointer convention],
--     clientType, verificationStatus DEFAULT 'NOT_CHECKED',
--     clientVersion, platform, displayTopologyClassification, nonceHash,
--     challengeHash, issuedAt, expiresAt, verifiedAt, createdAt DEFAULT
--     now(), updatedAt). PK on id. UNIQUE on nonceHash. Indexes on
--     (userId, createdAt), (expiresAt), (installationId). FK userId ->
--     User(id) ON DELETE CASCADE ON UPDATE CASCADE. Depends only on
--     "User".
--
--   Block 4 — docs/sql/add-tether-system-check-readiness.sql
--     CREATE TABLE "TetherSystemCheckRun" (id, userId, overallStatus,
--     sourceClientType, clientVersion, operatingSystem,
--     operatingSystemVersion, secureClientSessionId [advisory, NO
--     foreign key], checkedAt DEFAULT now(), expiresAt, resultsJson
--     JSONB NOT NULL, createdAt DEFAULT now(), updatedAt). PK on id.
--     Indexes on (userId, checkedAt), (userId, expiresAt),
--     (secureClientSessionId). FK userId -> User(id) ON DELETE CASCADE
--     ON UPDATE CASCADE. Depends only on "User".
--
--   Block 5 — docs/sql/add-secure-client-session-installation-attestation.sql
--     ALTERs the EXISTING "SecureClientSession" table: six new,
--     entirely additive, nullable-or-defaulted columns
--     (clientInstallationId TEXT, installationAttestationVerified
--     BOOLEAN NOT NULL DEFAULT false, installationAttestationVerifiedAt
--     TIMESTAMP(3), installationAttestationFailureReason TEXT,
--     installationVerificationId TEXT, attestationRequirement TEXT),
--     one index on clientInstallationId, one REAL (non-advisory) foreign
--     key clientInstallationId -> TetherClientInstallation(id) ON
--     DELETE SET NULL ON UPDATE CASCADE. THIS is the one genuine
--     cross-file dependency in the whole rollout — it requires Block 1's
--     table to exist first, which is why it is applied LAST here, not
--     third (its position among the original five files).
--
-- No data backfill anywhere: every new table starts empty; every new
-- column on the pre-existing SecureClientSession table is NULL or its
-- documented safe default (installationAttestationVerified = false)
-- for every existing row — nothing is retroactively "verified" or
-- assigned an attestation requirement. No DROP, RENAME, TRUNCATE, or
-- table rewrite anywhere in this file.
--
-- Each block is its OWN transaction (mirroring how each source file was
-- already independently transactional) — a problem in one block never
-- undoes an already-committed earlier block, and every block's own
-- IF NOT EXISTS / guarded-DO-block idempotency means this file is safe
-- to re-run in full even if some blocks already succeeded in an earlier
-- partial attempt. Every statement here is transaction-safe: plain
-- CREATE TABLE / ALTER TABLE ADD COLUMN / CREATE INDEX (never CREATE
-- INDEX CONCURRENTLY, which Postgres does not permit inside a
-- transaction block).
--
-- This file does NOT structurally validate an already-existing,
-- differently-shaped object of the same name — IF NOT EXISTS means
-- "skip if present," not "verify it matches." That is exactly why the
-- pre-check section below exists and must be run, and reviewed, BEFORE
-- applying: if it reveals an object already present in an unexpected
-- shape, STOP and investigate rather than proceeding.
--
-- Preview and Production share ONE Supabase database (see
-- docs/migration-ledger.md) — apply this file ONCE, manually, through
-- the Supabase SQL Editor, after review. Do not run `prisma db push`,
-- `prisma migrate dev`, `prisma migrate deploy`, or `prisma migrate
-- resolve` against the shared database. NOT applied by the assistant
-- that generated it.

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first, and review every result
-- before proceeding. Every "table" query expects NULL; every "column"
-- query expects zero rows; every index/constraint query expects zero
-- rows — unless noted otherwise.
-- ---------------------------------------------------------------------------

-- Tables (expect NULL — absent — for all four):
-- SELECT to_regclass('public."TetherClientInstallation"') AS tether_client_installation;
-- SELECT to_regclass('public."TetherInstallationRegistrationChallenge"') AS tether_registration_challenge;
-- SELECT to_regclass('public."SystemCheckSecureClientVerification"') AS system_check_verification;
-- SELECT to_regclass('public."TetherSystemCheckRun"') AS tether_system_check_run;

-- SecureClientSession installation-attestation columns (expect zero rows):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN (
--     'clientInstallationId', 'installationAttestationVerified',
--     'installationAttestationVerifiedAt', 'installationAttestationFailureReason',
--     'installationVerificationId', 'attestationRequirement'
--   );

-- Baseline sanity check — SecureClientSession's own pre-existing
-- columns must already exist (confirms the table itself, and row-14's
-- baseline migration, are intact — this is a narrow, additive gap, not
-- a missing/corrupt table):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN ('verificationStatus', 'status', 'clientType');
-- (Expected: three rows)

-- Every index this file would create (expect zero rows for all):
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
--   'TetherClientInstallation_pkey', 'TetherClientInstallation_publicKeyFingerprint_key',
--   'TetherClientInstallation_userId_publicKeyFingerprint_key', 'TetherClientInstallation_userId_status_idx',
--   'TetherInstallationRegistrationChallenge_pkey', 'TetherInstallationRegistrationChallenge_nonceHash_key',
--   'TetherInstallationRegistrationChallenge_userId_createdAt_idx',
--   'SystemCheckSecureClientVerification_pkey', 'SystemCheckSecureClientVerification_nonceHash_key',
--   'SystemCheckSecureClientVerification_userId_createdAt_idx', 'SystemCheckSecureClientVerification_expiresAt_idx',
--   'SystemCheckSecureClientVerification_installationId_idx',
--   'TetherSystemCheckRun_pkey', 'TetherSystemCheckRun_userId_checkedAt_idx',
--   'TetherSystemCheckRun_userId_expiresAt_idx', 'TetherSystemCheckRun_secureClientSessionId_idx',
--   'SecureClientSession_clientInstallationId_idx'
-- );

-- Every foreign key this file would create (expect zero rows for all):
-- SELECT conname FROM pg_constraint WHERE conname IN (
--   'TetherClientInstallation_userId_fkey',
--   'TetherInstallationRegistrationChallenge_userId_fkey',
--   'SystemCheckSecureClientVerification_userId_fkey',
--   'TetherSystemCheckRun_userId_fkey',
--   'SecureClientSession_clientInstallationId_fkey'
-- );

BEGIN;
-- Block 1 — docs/sql/add-tether-client-installation.sql
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

BEGIN;
-- Block 2 — docs/sql/add-tether-installation-registration-challenge.sql
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

BEGIN;
-- Block 3 — docs/sql/add-system-check-secure-client-verification.sql
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

BEGIN;
-- Block 4 — docs/sql/add-tether-system-check-readiness.sql
CREATE TABLE IF NOT EXISTS "public"."TetherSystemCheckRun" (
    "id"                     TEXT NOT NULL,
    "userId"                 TEXT NOT NULL,
    "overallStatus"          TEXT NOT NULL,
    "sourceClientType"       TEXT NOT NULL,
    "clientVersion"          TEXT,
    "operatingSystem"        TEXT,
    "operatingSystemVersion" TEXT,
    "secureClientSessionId"  TEXT,
    "checkedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"              TIMESTAMP(3) NOT NULL,
    "resultsJson"            JSONB NOT NULL,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TetherSystemCheckRun_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'TetherSystemCheckRun_userId_fkey'
    ) THEN
        ALTER TABLE "public"."TetherSystemCheckRun"
            ADD CONSTRAINT "TetherSystemCheckRun_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "public"."User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "TetherSystemCheckRun_userId_checkedAt_idx"
    ON "public"."TetherSystemCheckRun" ("userId", "checkedAt");

CREATE INDEX IF NOT EXISTS "TetherSystemCheckRun_userId_expiresAt_idx"
    ON "public"."TetherSystemCheckRun" ("userId", "expiresAt");

CREATE INDEX IF NOT EXISTS "TetherSystemCheckRun_secureClientSessionId_idx"
    ON "public"."TetherSystemCheckRun" ("secureClientSessionId");
COMMIT;

BEGIN;
-- Block 5 — docs/sql/add-secure-client-session-installation-attestation.sql
-- Applied LAST: this is the only block with a real foreign-key
-- dependency on an object created earlier in this file (Block 1's
-- TetherClientInstallation table).
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

-- Tables (expect each file's own name back):
-- SELECT to_regclass('public."TetherClientInstallation"') AS tether_client_installation;
-- SELECT to_regclass('public."TetherInstallationRegistrationChallenge"') AS tether_registration_challenge;
-- SELECT to_regclass('public."SystemCheckSecureClientVerification"') AS system_check_verification;
-- SELECT to_regclass('public."TetherSystemCheckRun"') AS tether_system_check_run;

-- SecureClientSession columns (expect six rows):
-- SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'SecureClientSession'
--   AND column_name IN (
--     'clientInstallationId', 'installationAttestationVerified',
--     'installationAttestationVerifiedAt', 'installationAttestationFailureReason',
--     'installationVerificationId', 'attestationRequirement'
--   )
-- ORDER BY column_name;

-- Every index (expect all seventeen rows from the pre-check list above):
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
--   'TetherClientInstallation_pkey', 'TetherClientInstallation_publicKeyFingerprint_key',
--   'TetherClientInstallation_userId_publicKeyFingerprint_key', 'TetherClientInstallation_userId_status_idx',
--   'TetherInstallationRegistrationChallenge_pkey', 'TetherInstallationRegistrationChallenge_nonceHash_key',
--   'TetherInstallationRegistrationChallenge_userId_createdAt_idx',
--   'SystemCheckSecureClientVerification_pkey', 'SystemCheckSecureClientVerification_nonceHash_key',
--   'SystemCheckSecureClientVerification_userId_createdAt_idx', 'SystemCheckSecureClientVerification_expiresAt_idx',
--   'SystemCheckSecureClientVerification_installationId_idx',
--   'TetherSystemCheckRun_pkey', 'TetherSystemCheckRun_userId_checkedAt_idx',
--   'TetherSystemCheckRun_userId_expiresAt_idx', 'TetherSystemCheckRun_secureClientSessionId_idx',
--   'SecureClientSession_clientInstallationId_idx'
-- ) ORDER BY indexname;

-- Every foreign key (expect all five rows):
-- SELECT conname FROM pg_constraint WHERE conname IN (
--   'TetherClientInstallation_userId_fkey',
--   'TetherInstallationRegistrationChallenge_userId_fkey',
--   'SystemCheckSecureClientVerification_userId_fkey',
--   'TetherSystemCheckRun_userId_fkey',
--   'SecureClientSession_clientInstallationId_fkey'
-- ) ORDER BY conname;

-- Every new table is empty immediately after applying:
-- SELECT count(*) FROM "public"."TetherClientInstallation";
-- SELECT count(*) FROM "public"."TetherInstallationRegistrationChallenge";
-- SELECT count(*) FROM "public"."SystemCheckSecureClientVerification";
-- SELECT count(*) FROM "public"."TetherSystemCheckRun";
-- (Expected: 0 for all four)

-- No existing SecureClientSession row retroactively verified or assigned a requirement:
-- SELECT count(*) FROM "public"."SecureClientSession" WHERE "installationAttestationVerified" = true;
-- SELECT count(*) FROM "public"."SecureClientSession"
-- WHERE "clientInstallationId" IS NOT NULL OR "attestationRequirement" IS NOT NULL
--    OR "installationAttestationVerifiedAt" IS NOT NULL OR "installationAttestationFailureReason" IS NOT NULL
--    OR "installationVerificationId" IS NOT NULL;
-- (Expected: 0 for both)

-- Existing tables/rows provably untouched — row counts identical before/after:
-- SELECT count(*) FROM "public"."SecureClientSession";
-- SELECT count(*) FROM "public"."User";
-- SELECT count(*) FROM "public"."Submission";

-- ---------------------------------------------------------------------------
-- Rollback — additive-only, touches no existing row's data. Reverse
-- dependency order (Block 5's foreign key must be dropped before Block
-- 1's table it references):
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
-- DROP TABLE IF EXISTS "public"."TetherSystemCheckRun";
-- DROP TABLE IF EXISTS "public"."SystemCheckSecureClientVerification";
-- DROP TABLE IF EXISTS "public"."TetherInstallationRegistrationChallenge";
-- DROP TABLE IF EXISTS "public"."TetherClientInstallation";
--
-- Preferred approach in practice: every application code path already
-- treats a missing/null value on any of these objects as "installation
-- attestation v2 has no evidence on record yet" — this is exactly the
-- state production has been running in since these files were never
-- applied. Dropping anything after applying it would simply restore the
-- P2022 failure this file exists to repair — there is no practical
-- scenario where that is the right move.
