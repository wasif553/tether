-- On-Device AI Camera Integrity Detection v1 — Evidence Frames (additive)
-- See docs/on-device-ai-integrity-detection-v1.md.
--
-- Generated via:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
-- then hand-extracted to just the new IntegrityEvidenceAsset table below,
-- per the existing production-DDL pattern in
-- docs/network-evidence-and-ip-location.md. Additive only — no existing
-- table, column, or enum is changed or removed.
--
-- Apply via the Supabase SQL Editor (or `psql`) against production.
-- Do NOT run `prisma db push` against production.

-- CreateTable
CREATE TABLE "IntegrityEvidenceAsset" (
    "id" TEXT NOT NULL,
    "integrityEventId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "redactionMode" TEXT NOT NULL DEFAULT 'LOW_RES_FULL_FRAME',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrityEvidenceAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrityEvidenceAsset_integrityEventId_key" ON "IntegrityEvidenceAsset"("integrityEventId");

-- CreateIndex
CREATE INDEX "IntegrityEvidenceAsset_integrityEventId_idx" ON "IntegrityEvidenceAsset"("integrityEventId");

-- CreateIndex
CREATE INDEX "IntegrityEvidenceAsset_submissionId_idx" ON "IntegrityEvidenceAsset"("submissionId");

-- CreateIndex
CREATE INDEX "IntegrityEvidenceAsset_examId_idx" ON "IntegrityEvidenceAsset"("examId");

-- CreateIndex
CREATE INDEX "IntegrityEvidenceAsset_institutionId_idx" ON "IntegrityEvidenceAsset"("institutionId");

-- CreateIndex
CREATE INDEX "IntegrityEvidenceAsset_capturedAt_idx" ON "IntegrityEvidenceAsset"("capturedAt");

-- AddForeignKey
ALTER TABLE "IntegrityEvidenceAsset" ADD CONSTRAINT "IntegrityEvidenceAsset_integrityEventId_fkey" FOREIGN KEY ("integrityEventId") REFERENCES "IntegrityEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityEvidenceAsset" ADD CONSTRAINT "IntegrityEvidenceAsset_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrityEvidenceAsset" ADD CONSTRAINT "IntegrityEvidenceAsset_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Verification queries — run after applying the above
-- ============================================================================

-- 1. Table exists with the expected columns:
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'IntegrityEvidenceAsset'
-- ORDER BY ordinal_position;

-- 2. Indexes exist (expect 6: pkey + 5 created above, unique on integrityEventId):
-- SELECT indexname FROM pg_indexes WHERE tablename = 'IntegrityEvidenceAsset';

-- 3. Foreign keys exist (expect 3: integrityEventId, submissionId, examId, all CASCADE):
-- SELECT conname, confrelid::regclass AS references_table, confdeltype
-- FROM pg_constraint
-- WHERE conrelid = '"IntegrityEvidenceAsset"'::regclass AND contype = 'f';

-- 4. Table is empty immediately after migration (expect 0 — this is a new,
--    additive table; a non-zero count here would indicate the migration
--    ran against the wrong database):
-- SELECT count(*) FROM "IntegrityEvidenceAsset";

-- 5. No existing table/column was altered — spot-check IntegrityEvent still
--    has its original column set (expect no evidenceAsset-image columns on
--    IntegrityEvent itself — evidence lives in the new table only):
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'IntegrityEvent';
