-- Tether Secure Client Foundation + Safe Exam Browser Compatibility v1
-- (additive) — see docs/secure-client-foundation-seb-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the new/changed statements this feature
-- adds (the --from-empty diff always emits CREATE TABLE for every table
-- since it diffs against nothing; every table below is genuinely new).
-- Additive only — no existing table, column, constraint, or enum value
-- is changed or removed.
--
-- Changes:
--   1. One new nullable column on the EXISTING Submission table —
--      secureClientPolicySnapshotJson (the immutable per-attempt policy
--      snapshot, same pattern as examPolicySnapshotJson /
--      aiAssistancePolicySnapshotJson / screenSharePolicySnapshotJson /
--      answerProvenancePolicySnapshotJson).
--   2. Seven new tables: SecureClientConfiguration, SebAllowedExamKey,
--      SecureClientLaunchManifest, SecureClientSession,
--      SecureClientAttestation, SecureClientEvent,
--      SecureClientRecoveryGrant. See prisma/schema.prisma for full
--      field-by-field documentation of each.
--
-- Two PARTIAL unique indexes are included below (no `@@unique` equivalent
-- exists in Prisma's schema DSL for a conditional/partial constraint —
-- same pattern as AnswerDevelopmentArtifact_answer_type_key /
-- AnswerDevelopmentArtifact_submission_type_key in the prior Answer-
-- Development Provenance migration):
--   - One ACTIVE SecureClientConfiguration per (examId, provider).
--   - One non-terminal SecureClientSession per submissionId (status NOT
--     IN ('ENDED', 'REJECTED')) — a browser refresh or duplicate launch
--     can never silently create a second concurrently-active session;
--     recovery/end must always be explicit (see
--     src/lib/secureClientRunner.ts).
--
-- IMPORTANT — shared database: Preview and Production currently point at
-- the SAME Supabase database (see docs/migration-ledger.md). This
-- migration must be applied ONCE, not once per environment. Run the
-- pre-check query below first; if it already shows the change applied,
-- do not re-run this file.
--
-- Apply via the Supabase SQL Editor (or `psql`). Do NOT run
-- `prisma db push`, `prisma migrate deploy`, `prisma migrate dev`, or
-- `prisma migrate resolve`.
--
-- Idempotency: this file is NOT idempotent — it is a ONE-TIME script.
-- Re-running it after a successful apply will error ("column already
-- exists" / "relation already exists"). Run the pre-check query first.
--
-- THIS MIGRATION HAS NOT BEEN APPLIED TO ANY ENVIRONMENT. Do not apply it
-- without explicit authorization — see docs/migration-ledger.md. Mark as
-- PENDING — NOT APPLIED until an operator actually runs it.

-- ============================================================================
-- 0. Pre-check (read-only) — run BEFORE applying anything below, to
--    confirm this migration has not already been applied to this
--    database (remember: Preview and Production are the SAME database).
-- ============================================================================
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'Submission' AND column_name = 'secureClientPolicySnapshotJson';
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name IN (
--     'SecureClientConfiguration', 'SebAllowedExamKey',
--     'SecureClientLaunchManifest', 'SecureClientSession',
--     'SecureClientAttestation', 'SecureClientEvent',
--     'SecureClientRecoveryGrant'
--   );
-- No rows from either query → safe to apply. Any rows → this migration
-- (or part of it) has already run; investigate before re-applying.

-- ============================================================================
-- 1. AlterTable: Submission — the immutable per-attempt secure-client
--    policy snapshot. Nullable; null means "no snapshot was taken for
--    this attempt" (every submission created before this feature, or any
--    exam where secure-client delivery was never configured) and is
--    ALWAYS treated as STANDARD_WEB / disabled — see
--    parseSecureClientPolicy() in src/lib/secureClientPolicy.ts.
-- ============================================================================
ALTER TABLE "Submission" ADD COLUMN "secureClientPolicySnapshotJson" JSONB;

-- ============================================================================
-- 2. CreateTable: SecureClientConfiguration — one lecturer-managed SEB or
--    future Tether provider configuration per exam (versioned; DRAFT
--    until explicitly activated).
-- ============================================================================
CREATE TABLE "SecureClientConfiguration" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "displayName" TEXT,
    "configurationVersion" INTEGER NOT NULL DEFAULT 1,
    "configurationHash" TEXT,
    "startUrlTemplate" TEXT,
    "quitUrlTemplate" TEXT,
    "allowedOriginsJson" JSONB,
    "allowedPlatformsJson" JSONB,
    "minimumVersionsJson" JSONB,
    "settingsJson" JSONB,
    "createdById" TEXT NOT NULL,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecureClientConfiguration_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 3. CreateTable: SebAllowedExamKey — accepted Browser Exam Key / Config
--    Key values for one configuration. Only a normalised SHA-256 hash and
--    (deliberately, see prisma/schema.prisma comment) an AES-256-GCM
--    encrypted raw-key ciphertext are ever stored — never the raw key in
--    plaintext, never returned to any client after entry.
-- ============================================================================
CREATE TABLE "SebAllowedExamKey" (
    "id" TEXT NOT NULL,
    "configurationId" TEXT NOT NULL,
    "keyType" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "rawKeyCiphertext" TEXT,
    "platform" TEXT,
    "clientVersion" TEXT,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SebAllowedExamKey_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 4. CreateTable: SecureClientLaunchManifest — one short-lived, single-use
--    signed secure launch. The raw launch nonce is NEVER stored — only
--    nonceHash.
-- ============================================================================
CREATE TABLE "SecureClientLaunchManifest" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "configurationId" TEXT,
    "clientType" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "clientSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecureClientLaunchManifest_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 5. CreateTable: SecureClientSession — one verified or attempted secure-
--    client session per submission.
--    `clientInstallationIdHash` is a random, hashed, per-installation
--    identifier — never a hardware serial number, MAC address, or
--    unrestricted machine fingerprint.
-- ============================================================================
CREATE TABLE "SecureClientSession" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "configurationId" TEXT,
    "clientType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "verificationStatus" TEXT NOT NULL DEFAULT 'NOT_CHECKED',
    "platform" TEXT,
    "clientVersion" TEXT,
    "clientInstallationIdHash" TEXT,
    "policyHash" TEXT,
    "manifestId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "interruptedAt" TIMESTAMP(3),
    "recoveredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecureClientSession_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 6. CreateTable: SecureClientAttestation — one structured preflight /
--    client-verification result. `detailsJson` uses a strict per-check
--    schema — never arbitrary JSON, never a full process list, never
--    command-line arguments, never open-document names, never window
--    titles.
-- ============================================================================
CREATE TABLE "SecureClientAttestation" (
    "id" TEXT NOT NULL,
    "secureClientSessionId" TEXT NOT NULL,
    "attestationVersion" TEXT NOT NULL DEFAULT 'v1',
    "clientType" TEXT NOT NULL,
    "platform" TEXT,
    "osVersion" TEXT,
    "clientVersion" TEXT,
    "clientBuild" TEXT,
    "clientSignatureStatus" TEXT,
    "configurationVerificationStatus" TEXT,
    "displayCount" INTEGER,
    "displayCheckStatus" TEXT,
    "remoteSessionStatus" TEXT,
    "virtualMachineStatus" TEXT,
    "processCheckStatus" TEXT,
    "captureProtectionStatus" TEXT,
    "clipboardPolicyStatus" TEXT,
    "printingPolicyStatus" TEXT,
    "externalNavigationPolicyStatus" TEXT,
    "overallStatus" TEXT NOT NULL,
    "detailsJson" JSONB,
    "clientReportedAt" TIMESTAMP(3),
    "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecureClientAttestation_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 7. CreateTable: SecureClientEvent — structured client/session integrity
--    signal. NO EVENT IS ITSELF LABELLED MISCONDUCT — eventLevel is
--    INFORMATIONAL/CONTEXT/ACTION_REQUIRED/REVIEW_CONTEXT, never a
--    violation score.
-- ============================================================================
CREATE TABLE "SecureClientEvent" (
    "id" TEXT NOT NULL,
    "secureClientSessionId" TEXT,
    "submissionId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventLevel" TEXT NOT NULL,
    "clientRequestId" TEXT,
    "sequenceNumber" INTEGER,
    "clientElapsedMs" INTEGER,
    "serverReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecureClientEvent_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 8. CreateTable: SecureClientRecoveryGrant — one lecturer-issued, one-
--    time recovery credential for an interrupted secure-client session.
--    Only a hash of the grant code/token is ever stored — never the raw
--    value after issuance.
-- ============================================================================
CREATE TABLE "SecureClientRecoveryGrant" (
    "id" TEXT NOT NULL,
    "secureClientSessionId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "grantCodeHash" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecureClientRecoveryGrant_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 9. CreateIndex — unique + lookup indexes for all seven new tables.
-- ============================================================================
CREATE INDEX "SecureClientConfiguration_examId_idx" ON "SecureClientConfiguration"("examId");
CREATE INDEX "SecureClientConfiguration_institutionId_idx" ON "SecureClientConfiguration"("institutionId");
CREATE INDEX "SecureClientConfiguration_status_idx" ON "SecureClientConfiguration"("status");

-- Race-safety hardening (same pattern as
-- AnswerDevelopmentArtifact_answer_type_key in the Answer-Development
-- Provenance migration): a plain (examId, provider) unique index would
-- reject every DRAFT/REVOKED/ARCHIVED row after the first, which is
-- wrong — lecturers must be able to keep draft/historical rows around.
-- What must actually be unique is "at most one ACTIVE configuration per
-- exam+provider at a time." A partial index scoped to status = 'ACTIVE'
-- enforces exactly that at the database level (not just in application
-- code) — see activateConfiguration() in src/lib/secureClientRunner.ts,
-- which relies on this constraint racing safely under concurrent
-- activation attempts.
CREATE UNIQUE INDEX "SecureClientConfiguration_exam_provider_active_key"
ON "SecureClientConfiguration" ("examId", "provider")
WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "SebAllowedExamKey_configurationId_keyType_keyHash_key" ON "SebAllowedExamKey"("configurationId", "keyType", "keyHash");
CREATE INDEX "SebAllowedExamKey_configurationId_idx" ON "SebAllowedExamKey"("configurationId");
CREATE INDEX "SebAllowedExamKey_keyType_idx" ON "SebAllowedExamKey"("keyType");
CREATE INDEX "SebAllowedExamKey_active_idx" ON "SebAllowedExamKey"("active");

CREATE UNIQUE INDEX "SecureClientLaunchManifest_nonceHash_key" ON "SecureClientLaunchManifest"("nonceHash");
CREATE INDEX "SecureClientLaunchManifest_submissionId_idx" ON "SecureClientLaunchManifest"("submissionId");
CREATE INDEX "SecureClientLaunchManifest_examId_idx" ON "SecureClientLaunchManifest"("examId");
CREATE INDEX "SecureClientLaunchManifest_institutionId_idx" ON "SecureClientLaunchManifest"("institutionId");
CREATE INDEX "SecureClientLaunchManifest_expiresAt_idx" ON "SecureClientLaunchManifest"("expiresAt");

CREATE UNIQUE INDEX "SecureClientSession_manifestId_key" ON "SecureClientSession"("manifestId");
CREATE INDEX "SecureClientSession_submissionId_idx" ON "SecureClientSession"("submissionId");
CREATE INDEX "SecureClientSession_examId_idx" ON "SecureClientSession"("examId");
CREATE INDEX "SecureClientSession_institutionId_idx" ON "SecureClientSession"("institutionId");
CREATE INDEX "SecureClientSession_status_idx" ON "SecureClientSession"("status");
CREATE INDEX "SecureClientSession_studentId_idx" ON "SecureClientSession"("studentId");

-- Concurrency-safety hardening: at most one CURRENT (non-terminal)
-- session per submission. Terminal statuses (ENDED, REJECTED) are
-- excluded from the partial index's WHERE clause so a submission can
-- accumulate an unlimited history of past sessions while never having
-- more than one that is still CREATED/PREFLIGHT/ACTIVE/INTERRUPTED/
-- RECOVERY_REQUIRED at once — see getOrCreateSessionCore() in
-- src/lib/secureClientRunner.ts, which relies on this constraint (plus
-- the existing pg_advisory_xact_lock(hashtext(submissionId)) pattern
-- already used elsewhere in this codebase) to make concurrent launch
-- attempts race-safe.
CREATE UNIQUE INDEX "SecureClientSession_submission_nonterminal_key"
ON "SecureClientSession" ("submissionId")
WHERE "status" NOT IN ('ENDED', 'REJECTED');

CREATE INDEX "SecureClientAttestation_secureClientSessionId_idx" ON "SecureClientAttestation"("secureClientSessionId");
CREATE INDEX "SecureClientAttestation_overallStatus_idx" ON "SecureClientAttestation"("overallStatus");
CREATE INDEX "SecureClientAttestation_serverReceivedAt_idx" ON "SecureClientAttestation"("serverReceivedAt");

CREATE UNIQUE INDEX "SecureClientEvent_clientRequestId_key" ON "SecureClientEvent"("clientRequestId");
CREATE INDEX "SecureClientEvent_secureClientSessionId_idx" ON "SecureClientEvent"("secureClientSessionId");
CREATE INDEX "SecureClientEvent_submissionId_idx" ON "SecureClientEvent"("submissionId");
CREATE INDEX "SecureClientEvent_examId_idx" ON "SecureClientEvent"("examId");
CREATE INDEX "SecureClientEvent_institutionId_idx" ON "SecureClientEvent"("institutionId");
CREATE INDEX "SecureClientEvent_eventType_idx" ON "SecureClientEvent"("eventType");
CREATE INDEX "SecureClientEvent_serverReceivedAt_idx" ON "SecureClientEvent"("serverReceivedAt");

CREATE UNIQUE INDEX "SecureClientRecoveryGrant_grantCodeHash_key" ON "SecureClientRecoveryGrant"("grantCodeHash");
CREATE INDEX "SecureClientRecoveryGrant_secureClientSessionId_idx" ON "SecureClientRecoveryGrant"("secureClientSessionId");
CREATE INDEX "SecureClientRecoveryGrant_submissionId_idx" ON "SecureClientRecoveryGrant"("submissionId");
CREATE INDEX "SecureClientRecoveryGrant_expiresAt_idx" ON "SecureClientRecoveryGrant"("expiresAt");

-- ============================================================================
-- 10. AddForeignKey — all outgoing only; none of these seven tables is
--     referenced BY any existing table, so adding them cannot affect any
--     existing foreign key or cascade behaviour.
-- ============================================================================
ALTER TABLE "SecureClientConfiguration" ADD CONSTRAINT "SecureClientConfiguration_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecureClientConfiguration" ADD CONSTRAINT "SecureClientConfiguration_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SecureClientConfiguration" ADD CONSTRAINT "SecureClientConfiguration_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SecureClientConfiguration" ADD CONSTRAINT "SecureClientConfiguration_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SebAllowedExamKey" ADD CONSTRAINT "SebAllowedExamKey_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "SecureClientConfiguration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SebAllowedExamKey" ADD CONSTRAINT "SebAllowedExamKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SecureClientLaunchManifest" ADD CONSTRAINT "SecureClientLaunchManifest_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecureClientLaunchManifest" ADD CONSTRAINT "SecureClientLaunchManifest_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecureClientLaunchManifest" ADD CONSTRAINT "SecureClientLaunchManifest_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "SecureClientConfiguration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SecureClientSession" ADD CONSTRAINT "SecureClientSession_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecureClientSession" ADD CONSTRAINT "SecureClientSession_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecureClientSession" ADD CONSTRAINT "SecureClientSession_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "SecureClientConfiguration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SecureClientAttestation" ADD CONSTRAINT "SecureClientAttestation_secureClientSessionId_fkey" FOREIGN KEY ("secureClientSessionId") REFERENCES "SecureClientSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SecureClientEvent" ADD CONSTRAINT "SecureClientEvent_secureClientSessionId_fkey" FOREIGN KEY ("secureClientSessionId") REFERENCES "SecureClientSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SecureClientEvent" ADD CONSTRAINT "SecureClientEvent_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SecureClientRecoveryGrant" ADD CONSTRAINT "SecureClientRecoveryGrant_secureClientSessionId_fkey" FOREIGN KEY ("secureClientSessionId") REFERENCES "SecureClientSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecureClientRecoveryGrant" ADD CONSTRAINT "SecureClientRecoveryGrant_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecureClientRecoveryGrant" ADD CONSTRAINT "SecureClientRecoveryGrant_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. New Submission column exists, and no existing column was altered/removed:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'Submission' ORDER BY ordinal_position;

-- 2. All seven new tables exist:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
--   AND table_name IN ('SecureClientConfiguration','SebAllowedExamKey','SecureClientLaunchManifest','SecureClientSession','SecureClientAttestation','SecureClientEvent','SecureClientRecoveryGrant')
--   ORDER BY table_name;

-- 3. Zero rows exist immediately after migration (nothing runs until a
--    lecturer configures secure-client delivery and a student launches):
-- SELECT count(*) FROM "SecureClientConfiguration";
-- SELECT count(*) FROM "SecureClientSession";

-- 4. Every existing Submission row has the new column NULL:
-- SELECT count(*) FROM "Submission" WHERE "secureClientPolicySnapshotJson" IS NOT NULL; -- expect 0 immediately after migration

-- 5. Both partial unique indexes exist with their correct WHERE clauses
--    (confirms Postgres registered them as PARTIAL indexes, not plain
--    ones) — expect exactly 1 row each:
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'SecureClientConfiguration' AND indexname = 'SecureClientConfiguration_exam_provider_active_key';
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'SecureClientSession' AND indexname = 'SecureClientSession_submission_nonterminal_key';
-- Each indexdef should show its own WHERE clause
-- ("WHERE (\"status\" = 'ACTIVE'::text)" /
-- "WHERE (\"status\" <> ALL (ARRAY['ENDED'::text, 'REJECTED'::text]))")
-- confirming they are genuinely partial indexes.

-- ============================================================================
-- Legacy compatibility and in-progress attempts
-- ============================================================================
--
-- No backfill is required or performed. Every EXISTING submission
-- (including ones currently IN_PROGRESS at deploy time) has
-- secureClientPolicySnapshotJson = NULL, which parseSecureClientPolicy()
-- in src/lib/secureClientPolicy.ts always treats as STANDARD_WEB /
-- disabled — an in-progress attempt that started before this migration
-- was applied can never retroactively start requiring a secure client
-- mid-attempt, exactly like the existing examPolicySnapshotJson /
-- aiAssistancePolicySnapshotJson / screenSharePolicySnapshotJson /
-- answerProvenancePolicySnapshotJson precedents this follows.
--
-- Existing exams: deliveryMode and every related secure-client setting
-- read back with their documented conservative defaults (STANDARD_WEB /
-- disabled) via the existing parseSecureSettings() merge — no database
-- migration needed for those fields since they live in the pre-existing
-- Exam.secureSettings JSONB column. A lecturer must explicitly choose a
-- non-default delivery mode for each exam; nothing about an existing
-- exam's behaviour changes on its own, and no exam is retroactively
-- required to use Safe Exam Browser or any secure client.
--
-- This migration is purely additive and safe to apply to a live
-- production database at any time.
--
-- ============================================================================
-- Rollback (documentation only — see docs/migration-ledger.md for the
-- full procedure; not executed automatically by this file)
-- ============================================================================
-- All seven new tables are safe to drop in child-to-parent order if the
-- feature must be fully removed:
--   DROP TABLE "SecureClientRecoveryGrant";
--   DROP TABLE "SecureClientEvent";
--   DROP TABLE "SecureClientAttestation";
--   DROP TABLE "SecureClientSession";
--   DROP TABLE "SecureClientLaunchManifest";
--   DROP TABLE "SebAllowedExamKey";
--   DROP TABLE "SecureClientConfiguration";
-- (no other table has a foreign key pointing at any of these seven —
-- they only have OUTGOING foreign keys to Exam/Submission/User — so
-- dropping them cannot cascade into unrelated data loss; this would
-- permanently delete recorded configurations, keys, launch manifests,
-- sessions, attestations, events, and recovery grants — export/audit
-- first if that data must be retained).
-- The Submission column is safe to drop if needed:
--   ALTER TABLE "Submission" DROP COLUMN "secureClientPolicySnapshotJson";
-- (every application code path treats a missing/null value as
-- STANDARD_WEB / disabled).
-- Preferred approach in practice: since the feature defaults to
-- deliveryMode "STANDARD_WEB" for every exam, ensuring no exam is
-- switched to a SEB/Tether-required delivery mode is the practical
-- "rollback" for almost any issue, rather than reverting the schema.
