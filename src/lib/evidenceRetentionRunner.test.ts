/**
 * Evidence retention runner — DB-backed tests. See
 * src/lib/evidenceRetentionRunner.ts's own doc comment and
 * docs/tether-data-and-privacy-register.md.
 *
 * Uses the local_dev storage adapter (the default outside production —
 * see evidenceStorage.ts's resolveEvidenceStorageAdapter), whose
 * delete() is a plain filesystem removal with `force: true`, so it
 * succeeds as a no-op even when no real file was ever written for the
 * synthetic storageKey values used here — this test exercises the
 * eligibility/ordering/reporting logic without needing real evidence
 * bytes on disk.
 *
 * Requires the local test Postgres instance (same requirement as the
 * sibling src/lib/evidenceRetention.test.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { getOrCreateTestInstitution } from "./testInstitution";
import { findEligibleEvidenceAssetsForDeletion, deleteEvidenceAsset, runEvidenceRetentionSweep, resolveEvidenceRetentionDays } from "./evidenceRetentionRunner";

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let lecturerA: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`evidence-retention-runner-${stamp}`);
  instA = a.id;
  lecturerA = await prisma.user.create({
    data: { name: "ERR Lecturer", email: `err-lect-${stamp}@test.local`, passwordHash: "x", role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "ERR Student", email: `err-stud-${stamp}@test.local`, passwordHash: "x", role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, studentA.id);
});

afterAll(async () => {
  await prisma.integrityEvidenceAsset.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createEvidenceAsset(capturedAt: Date) {
  const exam = await prisma.exam.create({
    data: { title: `Retention Runner Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
  });
  cleanup.exams.push(exam.id);
  const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" } });
  const event = await prisma.integrityEvent.create({
    data: { submissionId: submission.id, examId: exam.id, studentId: studentA.id, eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED", severity: "INFO", message: "test", occurredAt: capturedAt },
  });
  const asset = await prisma.integrityEvidenceAsset.create({
    data: {
      integrityEventId: event.id,
      submissionId: submission.id,
      examId: exam.id,
      institutionId: instA,
      kind: "SCREEN_SHARE_EVIDENCE_FRAME",
      eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED",
      storageProvider: "local_dev",
      storageKey: `retention-runner-test/${randomUUID()}.jpg`,
      contentType: "image/jpeg",
      byteSize: 1234,
      capturedAt,
    },
  });
  return { exam, submission, event, asset };
}

describe("resolveEvidenceRetentionDays", () => {
  it("defaults to 90 days when unset", () => {
    const original = process.env.EVIDENCE_RETENTION_DAYS;
    delete process.env.EVIDENCE_RETENTION_DAYS;
    expect(resolveEvidenceRetentionDays()).toBe(90);
    if (original !== undefined) process.env.EVIDENCE_RETENTION_DAYS = original;
  });

  it("falls back to the default for a non-positive or malformed value", () => {
    const original = process.env.EVIDENCE_RETENTION_DAYS;
    process.env.EVIDENCE_RETENTION_DAYS = "-5";
    expect(resolveEvidenceRetentionDays()).toBe(90);
    process.env.EVIDENCE_RETENTION_DAYS = "not-a-number";
    expect(resolveEvidenceRetentionDays()).toBe(90);
    if (original !== undefined) process.env.EVIDENCE_RETENTION_DAYS = original;
    else delete process.env.EVIDENCE_RETENTION_DAYS;
  });

  it("honours a valid configured value", () => {
    const original = process.env.EVIDENCE_RETENTION_DAYS;
    process.env.EVIDENCE_RETENTION_DAYS = "30";
    expect(resolveEvidenceRetentionDays()).toBe(30);
    if (original !== undefined) process.env.EVIDENCE_RETENTION_DAYS = original;
    else delete process.env.EVIDENCE_RETENTION_DAYS;
  });
});

describe("findEligibleEvidenceAssetsForDeletion", () => {
  it("finds an asset captured well before the retention cutoff", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const { asset } = await createEvidenceAsset(old);
    const eligible = await findEligibleEvidenceAssetsForDeletion(90, now);
    expect(eligible.some((a) => a.id === asset.id)).toBe(true);
  });

  it("never includes an asset captured within the retention window", async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const { asset } = await createEvidenceAsset(recent);
    const eligible = await findEligibleEvidenceAssetsForDeletion(90, now);
    expect(eligible.some((a) => a.id === asset.id)).toBe(false);
  });

  it("treats an asset exactly at the cutoff boundary as NOT yet eligible (strict less-than)", async () => {
    const now = new Date();
    const exactlyAtCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const { asset } = await createEvidenceAsset(exactlyAtCutoff);
    const eligible = await findEligibleEvidenceAssetsForDeletion(90, now);
    expect(eligible.some((a) => a.id === asset.id)).toBe(false);
  });
});

const RETENTION_CONTEXT = { retentionDays: 90, cutoff: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) };

describe("deleteEvidenceAsset", () => {
  it("deletes the database row (and the — possibly nonexistent — storage object without erroring)", async () => {
    const { asset } = await createEvidenceAsset(new Date());
    const outcome = await deleteEvidenceAsset(asset, RETENTION_CONTEXT);
    expect(outcome.ok).toBe(true);
    const found = await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } });
    expect(found).toBeNull();
  });

  // Evidence retention deletion safety v1.
  describe("A. storage failure — the DB row must survive and no deletion audit log must be written", () => {
    it("a storage delete failure leaves the IntegrityEvidenceAsset row and creates zero retention-deletion audit rows", async () => {
      // local_dev's delete() is a plain filesystem removal — an "unsafe"
      // key (path traversal) makes resolvePath() throw before any
      // filesystem call, giving a real, non-mocked storage-delete
      // failure exactly like a genuine Supabase API-level error would.
      const exam = await prisma.exam.create({
        data: { title: `Retention Storage Fail Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
      });
      cleanup.exams.push(exam.id);
      const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" } });
      const event = await prisma.integrityEvent.create({
        data: { submissionId: submission.id, examId: exam.id, studentId: studentA.id, eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED", severity: "INFO", message: "test", occurredAt: new Date() },
      });
      const asset = await prisma.integrityEvidenceAsset.create({
        data: {
          integrityEventId: event.id,
          submissionId: submission.id,
          examId: exam.id,
          institutionId: instA,
          kind: "SCREEN_SHARE_EVIDENCE_FRAME",
          eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED",
          storageProvider: "local_dev",
          storageKey: "../../unsafe-traversal-key.jpg",
          contentType: "image/jpeg",
          byteSize: 1234,
          capturedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
        },
      });

      const outcome = await deleteEvidenceAsset(
        { id: asset.id, storageProvider: asset.storageProvider, storageKey: asset.storageKey, capturedAt: asset.capturedAt, submissionId: asset.submissionId, examId: asset.examId, institutionId: asset.institutionId, kind: asset.kind, byteSize: asset.byteSize },
        RETENTION_CONTEXT,
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatch(/storage delete failed/);

      const found = await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } });
      expect(found).not.toBeNull();

      const auditRows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_RETENTION_DELETED", targetId: asset.id } });
      expect(auditRows.length).toBe(0);

      // Cleanup: this row is intentionally old + eligible (that's the
      // point of this test), so it must not leak into sibling tests in
      // this file that assume a clean eligible-assets slate (e.g. "no
      // eligible assets is a safe no-op"). Deleted directly — the
      // unsafe storageKey would fail through the normal adapter path.
      await prisma.integrityEvidenceAsset.delete({ where: { id: asset.id } });
    });
  });

  // B. success — DB row deleted, exactly one correct, sanitized audit row.
  describe("B. success — DB row deleted and exactly one deletion audit row is created", () => {
    it("creates one INTEGRITY_EVIDENCE_RETENTION_DELETED audit row with correct fields and no student-linkable metadata", async () => {
      const { asset } = await createEvidenceAsset(new Date(Date.now() - 200 * 24 * 60 * 60 * 1000));

      const outcome = await deleteEvidenceAsset(asset, RETENTION_CONTEXT);
      expect(outcome.ok).toBe(true);

      const found = await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } });
      expect(found).toBeNull();

      const auditRows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_RETENTION_DELETED", targetId: asset.id } });
      expect(auditRows.length).toBe(1);
      const row = auditRows[0];
      expect(row.actorId).toBeNull();
      expect(row.targetType).toBe("IntegrityEvidenceAsset");
      expect(row.institutionId).toBe(instA);

      const metadataStr = JSON.stringify(row.metadata);
      expect(metadataStr).not.toContain(asset.storageKey);
      expect(metadataStr).not.toContain(asset.submissionId);
      expect(metadataStr).toContain(asset.kind);
    });
  });

  // C. transaction failure after a successful storage delete — the DB row
  // must roll back (survive), and D. a subsequent retry must then
  // succeed, proving the storage-delete-of-already-gone-object no-op
  // makes the retry safe.
  describe("C/D. DB+audit transaction failure after storage delete, then a successful idempotent retry", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("rolls back the DB row on a transaction failure (no partial commit, no audit row), then a retry completes both the delete and the audit write", async () => {
      const { asset } = await createEvidenceAsset(new Date(Date.now() - 200 * 24 * 60 * 60 * 1000));

      const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(async () => {
        throw new Error("simulated transaction failure");
      });

      const failedOutcome = await deleteEvidenceAsset(asset, RETENTION_CONTEXT);
      expect(failedOutcome.ok).toBe(false);
      if (!failedOutcome.ok) expect(failedOutcome.error).toMatch(/database delete \+ audit transaction failed/);

      // Row survives — the transaction never committed.
      const stillPresent = await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } });
      expect(stillPresent).not.toBeNull();
      // No partially-committed audit row either.
      const auditRowsAfterFailure = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_RETENTION_DELETED", targetId: asset.id } });
      expect(auditRowsAfterFailure.length).toBe(0);

      transactionSpy.mockRestore();

      // Retry: storage delete of the already-(no-op)-deleted object
      // succeeds again (local_dev delete() with force:true is idempotent),
      // and the DB transaction now runs for real.
      const retryOutcome = await deleteEvidenceAsset(asset, RETENTION_CONTEXT);
      expect(retryOutcome.ok).toBe(true);

      const afterRetry = await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } });
      expect(afterRetry).toBeNull();
      const auditRowsAfterRetry = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_RETENTION_DELETED", targetId: asset.id } });
      expect(auditRowsAfterRetry.length).toBe(1);
    });
  });
});

describe("runEvidenceRetentionSweep", () => {
  it("dry run (default) evaluates and reports eligible assets but deletes nothing", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const { asset } = await createEvidenceAsset(old);

    const report = await runEvidenceRetentionSweep({ retentionDays: 90, now, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.eligible.some((a) => a.id === asset.id)).toBe(true);
    expect(report.outcomes).toEqual([]);

    const stillPresent = await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } });
    expect(stillPresent).not.toBeNull();
  });

  it("execute mode (dryRun:false) actually deletes every eligible asset and reports each outcome", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const { asset: eligibleAsset } = await createEvidenceAsset(old);
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const { asset: recentAsset } = await createEvidenceAsset(recent);

    const report = await runEvidenceRetentionSweep({ retentionDays: 90, now, dryRun: false });

    expect(report.eligible.some((a) => a.id === eligibleAsset.id)).toBe(true);
    expect(report.eligible.some((a) => a.id === recentAsset.id)).toBe(false);
    expect(report.outcomes.find((o) => o.id === eligibleAsset.id)?.ok).toBe(true);

    expect(await prisma.integrityEvidenceAsset.findUnique({ where: { id: eligibleAsset.id } })).toBeNull();
    // The within-window asset was never even evaluated for deletion — still present.
    expect(await prisma.integrityEvidenceAsset.findUnique({ where: { id: recentAsset.id } })).not.toBeNull();
  });

  it("with no eligible assets, execute mode is a safe no-op", async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    await createEvidenceAsset(recent);

    const report = await runEvidenceRetentionSweep({ retentionDays: 90, now, dryRun: false });
    expect(report.eligible).toEqual([]);
    expect(report.outcomes).toEqual([]);
  });
});
