-- Tether System Check and Exam Readiness v1 — see docs/tether-system-check-v1.md.
--
-- Adds ONE new, fully additive table: "TetherSystemCheckRun". Does not
-- alter, rename, or drop any existing table, column, index, enum, or
-- constraint. Does not touch Submission, SecureClientSession,
-- SecureClientEvent, IntegrityEvent, or any exam-settings data.
--
-- This table stores TECHNICAL READINESS records only — no images, audio,
-- biometric templates, raw permission objects, authentication tokens,
-- launch manifests, or secrets are ever written to it (see
-- src/lib/systemCheck/readiness.ts and the API routes under
-- src/app/api/tether/system-check/).
--
-- Preview and Production share one Supabase database (see
-- docs/migration-ledger.md) — this file must be applied ONCE, manually,
-- through the Supabase SQL Editor, after review. Do not run
-- `prisma db push`, `prisma migrate dev`, `prisma migrate deploy`, or
-- `prisma migrate resolve` against the shared database. Safe to run
-- more than once (every statement is idempotent via IF NOT EXISTS /
-- ON CONFLICT-free guards).

-- ---------------------------------------------------------------------------
-- Pre-application verification — run first. Expect ZERO rows / false.
-- ---------------------------------------------------------------------------
-- SELECT to_regclass('public."TetherSystemCheckRun"') AS existing_table;
-- (Expected: NULL — the table does not exist yet.)

BEGIN;

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

-- Advisory reference only to an existing student account — matches the
-- "TetherSystemCheckRun.userId -> User.id" relation in prisma/schema.prisma.
-- ON DELETE CASCADE mirrors the existing Submission.studentId -> User
-- relation's behaviour for per-user records tied to a deleted account.
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

-- ---------------------------------------------------------------------------
-- Post-application verification — run after applying. Expect the table,
-- all three indexes, and the foreign key to exist; row count 0 on a
-- freshly-applied database.
-- ---------------------------------------------------------------------------
-- SELECT to_regclass('public."TetherSystemCheckRun"') AS created_table;
-- (Expected: "TetherSystemCheckRun")
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND tablename = 'TetherSystemCheckRun'
-- ORDER BY indexname;
-- (Expected: TetherSystemCheckRun_pkey,
--            TetherSystemCheckRun_secureClientSessionId_idx,
--            TetherSystemCheckRun_userId_checkedAt_idx,
--            TetherSystemCheckRun_userId_expiresAt_idx)
--
-- SELECT conname FROM pg_constraint WHERE conname = 'TetherSystemCheckRun_userId_fkey';
-- (Expected: one row)
--
-- SELECT count(*) FROM "public"."TetherSystemCheckRun";
-- (Expected: 0 immediately after applying)
--
-- Existing tables are provably untouched — row counts must be identical
-- before and after applying this file:
-- SELECT count(*) FROM "public"."Submission";
-- SELECT count(*) FROM "public"."SecureClientSession";
-- SELECT count(*) FROM "public"."IntegrityEvent";
