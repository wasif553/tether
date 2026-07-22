-- Screen-share Evidence Mode v1 (additive) — see
-- docs/screen-share-evidence-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted and adapted to ALTER statements for the two
-- pre-existing tables this touches (Submission, IntegrityEvidenceAsset —
-- the --from-empty diff always emits CREATE TABLE for every table since
-- it diffs against nothing; both of these already exist in production),
-- per the existing production-DDL pattern (docs/evidence-frame-migration.sql,
-- docs/ai-brainstorming-assistance-migration.sql). Additive only — no
-- existing table, column, constraint, or enum value is changed or
-- removed. No new table is created — this feature deliberately reuses
-- the existing IntegrityEvidenceAsset table (its `kind`/`eventType`
-- columns already generically distinguish evidence source/type; see that
-- model's comment in prisma/schema.prisma) rather than introducing a
-- second, parallel evidence table.
--
-- The screenShareMode/screenShareCaptureEvidence/
-- screenShareEvidenceIntervalSeconds/screenShareMaxEvidenceFrames
-- settings live inside the EXISTING Exam.secureSettings JSONB column —
-- no migration is required for those at all; only the changes below
-- (eight new IntegrityEventType enum values, one new Submission column,
-- one new IntegrityEvidenceAsset column + its unique index) touch the
-- database schema.
--
-- IMPORTANT — shared database: Preview and Production currently point at
-- the SAME Supabase database (per the task context for this feature).
-- This migration must be applied ONCE, not once per environment — do
-- NOT apply it a second time against what would actually be the same
-- database under a different name/URL. Run the pre-check query below
-- first; if it already shows the change applied, do not re-run this file.
--
-- Apply via the Supabase SQL Editor (or `psql`). Do NOT run
-- `prisma db push`, `prisma migrate deploy`, `prisma migrate dev`, or
-- `prisma migrate resolve`.
--
-- Idempotency: the eight ALTER TYPE ... ADD VALUE IF NOT EXISTS
-- statements are safe to re-run. The ALTER TABLE / CREATE INDEX
-- statements below are NOT idempotent — this is a ONE-TIME script.
-- Re-running it after a successful apply will error ("column already
-- exists" / "relation already exists"). Run the pre-check query first.

-- ============================================================================
-- 0. Pre-check (read-only) — run BEFORE applying anything below, to
--    confirm this migration has not already been applied to this
--    database (remember: Preview and Production are the SAME database).
-- ============================================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'Submission' AND column_name = 'screenSharePolicySnapshotJson';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'IntegrityEvidenceAsset' AND column_name = 'clientRequestId';
-- SELECT enumlabel FROM pg_enum WHERE enumtypid = 'IntegrityEventType'::regtype
--   AND enumlabel LIKE 'SCREEN_SHARE_%';
-- All three empty/no-rows → safe to apply. Any non-empty result → this
-- migration (or part of it) has already run; investigate before
-- re-applying anything.

-- ============================================================================
-- 1. AlterEnum: IntegrityEventType — eight new values, following the same
--    convention already used for every previous addition to this enum.
--    Postgres requires each new enum value to be added in its own
--    statement, and none of them may be used in the same transaction that
--    adds them — run these eight statements first, on their own, before
--    anything else in this file.
-- ============================================================================
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_SHARE_STARTED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_SHARE_PERMISSION_DENIED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_SHARE_UNAVAILABLE';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_SHARE_SURFACE_REJECTED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_SHARE_INTERRUPTED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_SHARE_RESTORED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_SHARE_EVIDENCE_CAPTURED';
ALTER TYPE "IntegrityEventType" ADD VALUE IF NOT EXISTS 'SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED';

-- ============================================================================
-- 2. AlterTable: Submission — the immutable per-attempt screen-share
--    policy snapshot, exactly the same pattern as the existing
--    examPolicySnapshotJson/aiAssistancePolicySnapshotJson columns.
--    Nullable; null means "no snapshot was taken for this attempt"
--    (every submission created before this feature, or any exam where
--    screen sharing was never configured) and is ALWAYS treated as OFF
--    — see parseScreenSharePolicy() in src/lib/screenSharePolicy.ts.
-- ============================================================================
ALTER TABLE "Submission" ADD COLUMN "screenSharePolicySnapshotJson" JSONB;

-- ============================================================================
-- 3. AlterTable: IntegrityEvidenceAsset — adds the idempotency key
--    (Part 2 hardening pattern, reused from the AiAssistanceInteraction
--    precedent in docs/ai-brainstorming-assistance-migration.sql).
--    Nullable with a unique index — Postgres allows unlimited NULLs in a
--    unique index, so this is fully backward compatible: every EXISTING
--    camera evidence asset simply has clientRequestId = NULL (camera
--    evidence uploads never set it) and is completely unaffected. Only
--    screen-share evidence uploads populate this column, to let a
--    retried/duplicated upload request be recognised and replayed
--    instead of silently creating a second evidence asset and consuming
--    a second slot against the attempt's max-frames limit.
-- ============================================================================
ALTER TABLE "IntegrityEvidenceAsset" ADD COLUMN "clientRequestId" TEXT;
CREATE UNIQUE INDEX "IntegrityEvidenceAsset_clientRequestId_key" ON "IntegrityEvidenceAsset"("clientRequestId");

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. New enum values exist (expect 8 rows):
-- SELECT enumlabel FROM pg_enum WHERE enumtypid = 'IntegrityEventType'::regtype
--   AND enumlabel IN (
--     'SCREEN_SHARE_STARTED', 'SCREEN_SHARE_PERMISSION_DENIED', 'SCREEN_SHARE_UNAVAILABLE',
--     'SCREEN_SHARE_SURFACE_REJECTED', 'SCREEN_SHARE_INTERRUPTED', 'SCREEN_SHARE_RESTORED',
--     'SCREEN_SHARE_EVIDENCE_CAPTURED', 'SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED'
--   );

-- 2. New Submission column exists, and no existing column was altered/removed:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;

-- 3. New IntegrityEvidenceAsset column + unique index exist, and no
--    existing column/row was altered/removed (every existing row's
--    clientRequestId is NULL):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'IntegrityEvidenceAsset' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'IntegrityEvidenceAsset' AND indexname = 'IntegrityEvidenceAsset_clientRequestId_key';
-- SELECT count(*) FROM "IntegrityEvidenceAsset" WHERE "clientRequestId" IS NOT NULL; -- expect 0 immediately after migration

-- 4. Zero screen-share evidence rows exist immediately after migration
--    (nothing runs until a student actually shares their screen under an
--    exam with this feature enabled):
-- SELECT count(*) FROM "IntegrityEvidenceAsset" WHERE kind = 'SCREEN_SHARE_EVIDENCE_FRAME';

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. Every EXISTING submission
-- (including ones currently IN_PROGRESS at deploy time) has
-- screenSharePolicySnapshotJson = NULL, which parseScreenSharePolicy() in
-- src/lib/screenSharePolicy.ts always treats as OFF — an in-progress
-- attempt that started before this migration was applied can never
-- retroactively require screen sharing mid-attempt, exactly like the
-- existing examPolicySnapshotJson/aiAssistancePolicySnapshotJson
-- precedents this follows.
--
-- Existing exams: screenShareMode/screenShareCaptureEvidence/
-- screenShareEvidenceIntervalSeconds/screenShareMaxEvidenceFrames all
-- read back with their documented conservative defaults (OFF / false /
-- 60 / 20, which have no effect while mode is OFF) via the existing
-- parseSecureSettings() merge — no database migration needed for those
-- fields since they live in the pre-existing Exam.secureSettings JSONB
-- column. A lecturer must explicitly enable screen sharing for each
-- exam; nothing about an existing exam's behaviour changes on its own.
--
-- Existing camera evidence: every existing IntegrityEvidenceAsset row
-- (kind = 'AI_CAMERA_EVIDENCE_FRAME') is completely unaffected — the new
-- clientRequestId column defaults to NULL and camera evidence uploads
-- never set it, so this migration changes nothing about how camera
-- evidence is stored, queried, or displayed.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time.
