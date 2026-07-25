-- Tether Secure Client Foundation v1 — hardening pass, shared-database
-- test-residue audit. See docs/migration-ledger.md.
--
-- READ-ONLY. Every statement below is a SELECT. Nothing here deletes,
-- updates, or inserts anything. Run manually against the shared Preview/
-- Production Supabase database to check for leftover rows from the
-- PREVIOUS version of src/lib/secureClient.routes.test.ts, which created
-- real User/Institution/Exam rows there (relying on its own afterAll
-- cleanup) before this hardening pass replaced it with a fully-mocked
-- test file that never opens a real database connection.
--
-- Identifiers the previous version used (see git history of
-- src/lib/secureClient.routes.test.ts before this commit):
--   institution slugs : secure-client-a-<stamp>, secure-client-b-<stamp>
--   user emails        : sc-lect-a-<stamp>@test.local
--                         sc-lect-b-<stamp>@test.local
--                         sc-stud-a-<stamp>@test.local
--                         sc-lect-other-<stamp>@test.local
--   exam titles         : "Secure Client Exam <epoch-ms>-<Math.random()>"
-- <stamp> = Date.now() captured once when that test file loaded, so it is
-- a 13-digit millisecond epoch timestamp shared by every fixture created
-- in the same run.
--
-- The seven new secure-client tables (SecureClientConfiguration,
-- SebAllowedExamKey, SecureClientLaunchManifest, SecureClientSession,
-- SecureClientAttestation, SecureClientEvent, SecureClientRecoveryGrant)
-- do NOT exist in this database yet — the migration in
-- docs/secure-client-foundation-seb-v1-migration.sql is still
-- PENDING — NOT APPLIED (see docs/migration-ledger.md). The previous test
-- file never reached code that touches them (see its own header comment),
-- so no residue is expected there regardless; the queries for those
-- tables below are included for completeness and are safe to run again
-- after the migration is applied (each is guarded with to_regclass so it
-- returns NULL/no-op instead of erroring if the table doesn't exist yet).

-- 1. Institutions matching the secure-client test slug pattern.
SELECT id, name, slug, "createdAt"
FROM "Institution"
WHERE slug LIKE 'secure-client-a-%' OR slug LIKE 'secure-client-b-%'
ORDER BY "createdAt" DESC;

-- 2. Users matching the secure-client test email pattern.
SELECT id, name, email, role, "institutionId", "createdAt"
FROM "User"
WHERE email LIKE 'sc-lect-a-%@test.local'
   OR email LIKE 'sc-lect-b-%@test.local'
   OR email LIKE 'sc-stud-a-%@test.local'
   OR email LIKE 'sc-lect-other-%@test.local'
ORDER BY "createdAt" DESC;

-- 3. Exams matching the secure-client test title pattern.
SELECT id, title, "createdById", "institutionId", "createdAt"
FROM "Exam"
WHERE title LIKE 'Secure Client Exam %'
ORDER BY "createdAt" DESC;

-- 4. Submissions belonging to any exam found in query 3 above.
SELECT s.id, s."examId", s."studentId", s.status, s."startedAt"
FROM "Submission" s
WHERE s."examId" IN (SELECT id FROM "Exam" WHERE title LIKE 'Secure Client Exam %')
ORDER BY s."startedAt" DESC;

-- 5. SecureClientConfiguration rows for any exam found in query 3 above
--    (table does not exist yet — to_regclass guards against an error).
SELECT count(*) AS residual_configurations
FROM "SecureClientConfiguration"
WHERE to_regclass('public."SecureClientConfiguration"') IS NOT NULL
  AND "examId" IN (SELECT id FROM "Exam" WHERE title LIKE 'Secure Client Exam %');

-- 6. SecureClientLaunchManifest rows for any exam found in query 3 above.
SELECT count(*) AS residual_launch_manifests
FROM "SecureClientLaunchManifest"
WHERE to_regclass('public."SecureClientLaunchManifest"') IS NOT NULL
  AND "examId" IN (SELECT id FROM "Exam" WHERE title LIKE 'Secure Client Exam %');

-- 7. SecureClientSession rows for any exam found in query 3 above.
SELECT count(*) AS residual_sessions
FROM "SecureClientSession"
WHERE to_regclass('public."SecureClientSession"') IS NOT NULL
  AND "examId" IN (SELECT id FROM "Exam" WHERE title LIKE 'Secure Client Exam %');

-- 8. SecureClientAttestation rows attached to any session found in query 7.
SELECT count(*) AS residual_attestations
FROM "SecureClientAttestation"
WHERE to_regclass('public."SecureClientAttestation"') IS NOT NULL
  AND "secureClientSessionId" IN (
    SELECT id FROM "SecureClientSession"
    WHERE to_regclass('public."SecureClientSession"') IS NOT NULL
      AND "examId" IN (SELECT id FROM "Exam" WHERE title LIKE 'Secure Client Exam %')
  );

-- 9. SecureClientEvent rows for any exam found in query 3 above.
SELECT count(*) AS residual_events
FROM "SecureClientEvent"
WHERE to_regclass('public."SecureClientEvent"') IS NOT NULL
  AND "examId" IN (SELECT id FROM "Exam" WHERE title LIKE 'Secure Client Exam %');

-- 10. SecureClientRecoveryGrant rows attached to any session found in query 7.
SELECT count(*) AS residual_recovery_grants
FROM "SecureClientRecoveryGrant"
WHERE to_regclass('public."SecureClientRecoveryGrant"') IS NOT NULL
  AND "secureClientSessionId" IN (
    SELECT id FROM "SecureClientSession"
    WHERE to_regclass('public."SecureClientSession"') IS NOT NULL
      AND "examId" IN (SELECT id FROM "Exam" WHERE title LIKE 'Secure Client Exam %')
  );

-- Note: queries 5-10 above will simply be skipped by Postgres returning 0
-- via the to_regclass guard if the tables don't exist — but some Postgres
-- versions still parse-check the table name at plan time even when the
-- guard is false. If any of them error with "relation does not exist",
-- that itself confirms the migration is still unapplied and no residue
-- is possible in those tables; skip them and rely on queries 1-4 alone.

-- Cleanup (NOT executed by this file — for reference only, if residue is
-- found): delete Submission rows first, then Exam rows, then User rows,
-- then Institution rows, in that order (children before parents), scoped
-- to the exact ids returned by queries 1-4 above. Never delete by pattern
-- match alone without first reviewing the returned id list.
