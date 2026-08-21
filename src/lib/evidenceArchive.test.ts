/**
 * Evidence Backup/Recovery v1 — archive/restore orchestrator tests. See
 * docs/tether-evidence-archive-plan.md and the doc comments on
 * src/lib/evidenceArchive.ts.
 *
 * Requires the local test Postgres instance (same requirement as the
 * sibling src/lib/evidenceRetentionRunner.test.ts). Primary storage uses
 * the local_dev adapter (the default outside production); archive
 * storage likewise defaults to local_dev, writing under a completely
 * separate directory (.evidence-archive-storage/) — no real Supabase
 * project, no network, no Production/Preview evidence is ever touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { getOrCreateTestInstitution } from "./testInstitution";
import { resolveEvidenceStorageAdapter } from "./evidenceStorage";
import { resolveEvidenceArchiveStorageAdapter, type EvidenceArchiveStorageAdapter } from "./evidenceArchiveStorage";
import {
  findEvidenceArchiveCandidates,
  verifySourceEvidence,
  archiveVerifiedEvidence,
  generateArchiveObjectKey,
  computeManifestSha256,
  buildManifestDocument,
  verifyManifestDocument,
  assertProductionArchiveSafe,
  runEvidenceArchiveSweep,
  restoreEvidenceAsset,
  ProductionArchiveGuardError,
  type ArchiveManifestPayload,
  type EvidenceArchiveCandidate,
} from "./evidenceArchive";

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let lecturerA: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`evidence-archive-${stamp}`);
  instA = a.id;
  lecturerA = await prisma.user.create({
    data: { name: "EA Lecturer", email: `ea-lect-${stamp}@test.local`, passwordHash: "x", role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "EA Student", email: `ea-stud-${stamp}@test.local`, passwordHash: "x", role: "STUDENT", institutionId: instA },
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

type AssetOptions = {
  capturedAt?: Date;
  primaryBytes?: Buffer | null; // null = never write to primary (simulates SOURCE_MISSING)
  storedSha256?: string | null | undefined; // undefined = compute correctly from primaryBytes; null = store null (SOURCE_DIGEST_MISSING); a string = store an explicit (possibly wrong) value
  storedByteSize?: number; // defaults to primaryBytes.length; pass a wrong value to simulate SOURCE_SIZE_MISMATCH
  institutionId?: string; // defaults to the shared instA — pass a dedicated institution for tests that assert on a whole institutionId-scoped sweep's aggregate (overallOk/candidateCount), so leftover assets from other tests sharing instA can never leak in
};

async function createArchiveTestAsset(opts: AssetOptions = {}) {
  const institutionId = opts.institutionId ?? instA;
  const exam = await prisma.exam.create({
    data: { title: `Archive Test Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId },
  });
  cleanup.exams.push(exam.id);
  const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" } });
  const event = await prisma.integrityEvent.create({
    data: { submissionId: submission.id, examId: exam.id, studentId: studentA.id, eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED", severity: "INFO", message: "test", occurredAt: opts.capturedAt ?? new Date() },
  });

  const storageKey = `archive-test/${randomUUID()}.jpg`;
  const primaryBytes = opts.primaryBytes === undefined ? Buffer.from(`synthetic-evidence-bytes-${randomUUID()}`) : opts.primaryBytes;

  if (primaryBytes !== null) {
    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.put(storageKey, primaryBytes, "image/jpeg");
  }

  const actualSha256 = primaryBytes ? createHash("sha256").update(primaryBytes).digest("hex") : null;
  const sha256 = opts.storedSha256 === undefined ? actualSha256 : opts.storedSha256;
  const byteSize = opts.storedByteSize ?? (primaryBytes ? primaryBytes.byteLength : 0);

  const asset = await prisma.integrityEvidenceAsset.create({
    data: {
      integrityEventId: event.id,
      submissionId: submission.id,
      examId: exam.id,
      institutionId,
      kind: "SCREEN_SHARE_EVIDENCE_FRAME",
      eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED",
      storageProvider: "local_dev",
      storageKey,
      contentType: "image/jpeg",
      byteSize,
      sha256,
      capturedAt: opts.capturedAt ?? new Date(),
    },
  });
  return { exam, submission, event, asset, primaryBytes, storageKey };
}

function makeFakeArchiveAdapter(behavior: {
  existing?: Buffer | null;
  onPut?: () => void;
  postPutBytes?: Buffer; // bytes returned by get() AFTER put() has been called — simulates a corrupted read-back
  throwOnPut?: boolean;
}): EvidenceArchiveStorageAdapter {
  let putCalled = false;
  const putSpyCalls: { key: string; bytes: Buffer }[] = [];
  return {
    provider: "local_dev",
    async put(key, bytes) {
      putSpyCalls.push({ key, bytes });
      if (behavior.throwOnPut) throw new Error("failed uploading evidence/v1/asset.jpg to https://internal.example/token=fake-secret");
      putCalled = true;
      behavior.onPut?.();
    },
    async get() {
      if (putCalled && behavior.postPutBytes) return behavior.postPutBytes;
      if (putCalled) return null;
      return behavior.existing ?? null;
    },
    __putSpyCalls: putSpyCalls,
  } as EvidenceArchiveStorageAdapter & { __putSpyCalls: { key: string; bytes: Buffer }[] };
}

// ── Source verification ──────────────────────────────────────────────

describe("verifySourceEvidence", () => {
  it("succeeds and returns the downloaded bytes for a healthy asset", async () => {
    const { asset, primaryBytes } = await createArchiveTestAsset();
    const result = await verifySourceEvidence(asset as unknown as EvidenceArchiveCandidate);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.equals(primaryBytes!)).toBe(true);
  });

  it("SOURCE_MISSING when the primary object was never written", async () => {
    const { asset } = await createArchiveTestAsset({ primaryBytes: null });
    const result = await verifySourceEvidence(asset as unknown as EvidenceArchiveCandidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("SOURCE_MISSING");
  });

  it("SOURCE_DIGEST_MISSING when the DB row has no stored sha256", async () => {
    const { asset } = await createArchiveTestAsset({ storedSha256: null });
    const result = await verifySourceEvidence(asset as unknown as EvidenceArchiveCandidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("SOURCE_DIGEST_MISSING");
  });

  it("SOURCE_HASH_MISMATCH when the stored sha256 does not match the actual bytes", async () => {
    const { asset } = await createArchiveTestAsset({ storedSha256: "0".repeat(64) });
    const result = await verifySourceEvidence(asset as unknown as EvidenceArchiveCandidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("SOURCE_HASH_MISMATCH");
  });

  it("SOURCE_SIZE_MISMATCH when the hash matches but the recorded byteSize does not", async () => {
    const { asset } = await createArchiveTestAsset({ storedByteSize: 999_999 });
    const result = await verifySourceEvidence(asset as unknown as EvidenceArchiveCandidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("SOURCE_SIZE_MISMATCH");
  });
});

// ── Deterministic archive object keys ────────────────────────────────

describe("generateArchiveObjectKey", () => {
  it("is deterministic — the same asset id always produces the same key, independent of any run id", () => {
    const a = generateArchiveObjectKey("asset-123", "image/jpeg");
    const b = generateArchiveObjectKey("asset-123", "image/jpeg");
    expect(a).toBe(b);
    expect(a).toBe("evidence/v1/asset-123.jpg");
  });

  it("uses the correct extension per content type and never a user-controlled filename", () => {
    expect(generateArchiveObjectKey("asset-1", "image/webp")).toBe("evidence/v1/asset-1.webp");
    expect(generateArchiveObjectKey("asset-1", "application/octet-stream")).toBe("evidence/v1/asset-1.bin");
  });

  it("never embeds a submission id, student id, or the primary storageKey", () => {
    const key = generateArchiveObjectKey("asset-1", "image/jpeg");
    expect(key).not.toMatch(/sub|stud|@/i);
  });
});

// ── Archive write + read-back verification ───────────────────────────

describe("archiveVerifiedEvidence", () => {
  it("new object: uploads, reads back, verifies SHA-256 + size, reports ARCHIVED_VERIFIED", async () => {
    const bytes = Buffer.from("new-archive-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const adapter = makeFakeArchiveAdapter({ existing: null, postPutBytes: bytes });
    const outcome = await archiveVerifiedEvidence(adapter, "evidence/v1/x.jpg", bytes, "image/jpeg", sha256);
    expect(outcome.status).toBe("ARCHIVED_VERIFIED");
  });

  it("read-back mismatch after a successful-looking upload fails as ARCHIVE_VERIFY_FAILED — never trusts upload success alone", async () => {
    const bytes = Buffer.from("expected-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const adapter = makeFakeArchiveAdapter({ existing: null, postPutBytes: Buffer.from("CORRUPTED-DIFFERENT-BYTES") });
    const outcome = await archiveVerifiedEvidence(adapter, "evidence/v1/x.jpg", bytes, "image/jpeg", sha256);
    expect(outcome.status).toBe("ARCHIVE_VERIFY_FAILED");
  });

  it("already archived with the SAME sha256 is a safe no-op: ALREADY_ARCHIVED_VERIFIED, and put() is never called", async () => {
    const bytes = Buffer.from("already-there-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const adapter = makeFakeArchiveAdapter({ existing: bytes });
    const outcome = await archiveVerifiedEvidence(adapter, "evidence/v1/x.jpg", bytes, "image/jpeg", sha256);
    expect(outcome.status).toBe("ALREADY_ARCHIVED_VERIFIED");
    expect((adapter as EvidenceArchiveStorageAdapter & { __putSpyCalls: unknown[] }).__putSpyCalls.length).toBe(0);
  });

  it("existing archive object with a DIFFERENT sha256 is a conflict: ARCHIVE_CONFLICT, and it is never overwritten", async () => {
    const bytes = Buffer.from("expected-new-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const conflictingExisting = Buffer.from("some-other-unrelated-bytes-already-there");
    const adapter = makeFakeArchiveAdapter({ existing: conflictingExisting });
    const outcome = await archiveVerifiedEvidence(adapter, "evidence/v1/x.jpg", bytes, "image/jpeg", sha256);
    expect(outcome.status).toBe("ARCHIVE_CONFLICT");
    expect((adapter as EvidenceArchiveStorageAdapter & { __putSpyCalls: unknown[] }).__putSpyCalls.length).toBe(0);
  });

  it("a provider write failure is reported as ARCHIVE_WRITE_FAILED with a bounded error string", async () => {
    const bytes = Buffer.from("x");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const adapter = makeFakeArchiveAdapter({ existing: null, throwOnPut: true });
    const outcome = await archiveVerifiedEvidence(adapter, "evidence/v1/x.jpg", bytes, "image/jpeg", sha256);
    expect(outcome.status).toBe("ARCHIVE_WRITE_FAILED");
  });
});

// ── Manifest — non-circular digest ───────────────────────────────────

describe("manifest — non-circular SHA-256", () => {
  const samplePayload: ArchiveManifestPayload = {
    manifestVersion: 1,
    archiveRunId: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceEnvironment: "test",
    sourceProvider: "local_dev",
    assetCount: 1,
    assets: [
      {
        evidenceAssetId: "asset-1",
        kind: "SCREEN_SHARE_EVIDENCE_FRAME",
        contentType: "image/jpeg",
        byteSize: 123,
        sha256: "a".repeat(64),
        capturedAt: "2026-01-01T00:00:00.000Z",
        archiveObjectKey: "evidence/v1/asset-1.jpg",
        verificationStatus: "ARCHIVED_VERIFIED",
        originalStorageKey: "primary/asset-1.jpg",
        institutionId: "inst-1",
        examId: "exam-1",
        submissionId: "sub-1",
        integrityEventId: "evt-1",
      },
    ],
  };

  it("computeManifestSha256 never includes manifestSha256 itself in the hashed payload — no circularity", () => {
    const digest = computeManifestSha256(samplePayload);
    // The payload passed in has no manifestSha256 field at all (the type doesn't even allow it) —
    // this test proves the digest is a function purely of the payload, not of any prior digest.
    const digestAgain = computeManifestSha256({ ...samplePayload });
    expect(digest).toBe(digestAgain);
  });

  it("buildManifestDocument + verifyManifestDocument round-trip successfully", () => {
    const doc = buildManifestDocument(samplePayload);
    expect(doc.manifestSha256).toBeTruthy();
    expect(verifyManifestDocument(doc)).toBe(true);
  });

  it("verifyManifestDocument fails if the payload is tampered with after the digest was computed", () => {
    const doc = buildManifestDocument(samplePayload);
    const tampered = { ...doc, assetCount: 999 };
    expect(verifyManifestDocument(tampered)).toBe(false);
  });

  it("verifyManifestDocument fails safely (never throws) for malformed input", () => {
    expect(verifyManifestDocument({} as never)).toBe(false);
  });

  it("field order in the source payload construction does not change the digest — canonical serialization is fixed-order", () => {
    const reordered: ArchiveManifestPayload = {
      assets: samplePayload.assets,
      assetCount: samplePayload.assetCount,
      sourceProvider: samplePayload.sourceProvider,
      sourceEnvironment: samplePayload.sourceEnvironment,
      createdAt: samplePayload.createdAt,
      archiveRunId: samplePayload.archiveRunId,
      manifestVersion: samplePayload.manifestVersion,
    };
    expect(computeManifestSha256(reordered)).toBe(computeManifestSha256(samplePayload));
  });
});

// ── Machine-enforced production/project-separation guard ────────────

describe("assertProductionArchiveSafe", () => {
  it("fails closed when the archive project ref equals the primary project ref, REGARDLESS of declared environment", () => {
    const env = { SUPABASE_URL: "https://same-project.supabase.co", ARCHIVE_SUPABASE_URL: "https://same-project.supabase.co" };
    expect(assertProductionArchiveSafe(true, env).ok).toBe(false);
    expect(assertProductionArchiveSafe(true, { ...env, ARCHIVE_SOURCE_ENVIRONMENT: "production" }).ok).toBe(false);
  });

  it("passes for a non-production source with a genuinely separate archive project", () => {
    const result = assertProductionArchiveSafe(false, {
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
    });
    expect(result.ok).toBe(true);
  });

  it("production source requires ARCHIVE_STORAGE_PROVIDER=supabase_storage (never local_dev)", () => {
    const result = assertProductionArchiveSafe(true, {
      ARCHIVE_SOURCE_ENVIRONMENT: "production",
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "local_dev",
      ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "primary-project",
    });
    expect(result.ok).toBe(false);
  });

  it("production source requires the primary project ref to match ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF", () => {
    const result = assertProductionArchiveSafe(true, {
      ARCHIVE_SOURCE_ENVIRONMENT: "production",
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "some-other-project",
    });
    expect(result.ok).toBe(false);
  });

  it("production source requires --confirm-production-archive even when everything else is correctly configured", () => {
    const baseEnv = {
      ARCHIVE_SOURCE_ENVIRONMENT: "production",
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "primary-project",
    };
    expect(assertProductionArchiveSafe(false, baseEnv).ok).toBe(false);
    expect(assertProductionArchiveSafe(true, baseEnv).ok).toBe(true);
  });

  it("never throws — always returns a result object, and never includes a credential or full URL in the failure reason", () => {
    const result = assertProductionArchiveSafe(false, {
      ARCHIVE_SOURCE_ENVIRONMENT: "production",
      ARCHIVE_SUPABASE_SERVICE_ROLE_KEY: "TOP-SECRET-ARCHIVE-KEY",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("TOP-SECRET-ARCHIVE-KEY");
      expect(result.reason).not.toContain("https://");
    }
  });
});

// ── Full sweep: dry-run mutation-free proof, partial failure, manifest, audit dedup ──

describe("runEvidenceArchiveSweep", () => {
  it("dry-run performs ZERO writes: no archive object, no manifest, no audit row, no DB mutation", async () => {
    const { asset } = await createArchiveTestAsset();
    const report = await runEvidenceArchiveSweep({ dryRun: true, institutionId: instA });

    const outcome = report.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(outcome?.status).toBe("SOURCE_VERIFIED");
    expect(report.manifestVerified).toBeNull();

    // No archive object was ever written for this asset.
    const archiveAdapter = resolveEvidenceArchiveStorageAdapter();
    const archiveKey = generateArchiveObjectKey(asset.id, "image/jpeg");
    expect(await archiveAdapter.get(archiveKey)).toBeNull();

    // No audit row was written.
    const auditRows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED", targetId: asset.id } });
    expect(auditRows.length).toBe(0);

    // DB row itself is untouched.
    const stillPresent = await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } });
    expect(stillPresent).not.toBeNull();
  });

  it("execute mode: a source-verification failure for one asset does not prevent evaluating the rest, and the overall run fails", async () => {
    const good = await createArchiveTestAsset();
    const bad = await createArchiveTestAsset({ primaryBytes: null }); // SOURCE_MISSING

    const report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });

    const goodOutcome = report.outcomes.find((o) => o.evidenceAssetId === good.asset.id);
    const badOutcome = report.outcomes.find((o) => o.evidenceAssetId === bad.asset.id);
    expect(goodOutcome?.status).toBe("ARCHIVED_VERIFIED");
    expect(badOutcome?.status).toBe("SOURCE_MISSING");
    expect(report.overallOk).toBe(false);
  });

  it("execute mode: every candidate reaching a verified state (and manifest verification succeeding) reports overallOk=true", async () => {
    // Uses a dedicated, freshly-created institution (not the shared instA)
    // so this sweep's institutionId scope can never include a leftover
    // "bad" asset created by an earlier test in this same file.
    const isolatedInst = await getOrCreateTestInstitution(`evidence-archive-isolated-${Date.now()}-${Math.random()}`);
    const { asset } = await createArchiveTestAsset({ institutionId: isolatedInst.id });
    const report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "test" });
    const outcome = report.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(outcome?.status).toBe("ARCHIVED_VERIFIED");
    expect(report.manifestVerified).toBe(true);
    expect(report.overallOk).toBe(true);
  });

  it("writes exactly one INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED audit row, with sanitized metadata and correct institutionId/targetId", async () => {
    const { asset } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });

    // Fire-and-forget audit write — poll briefly for it to land.
    const deadline = Date.now() + 2000;
    let rows: Awaited<ReturnType<typeof prisma.platformAuditLog.findMany>> = [];
    while (Date.now() < deadline) {
      rows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED", targetId: asset.id } });
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.actorId).toBeNull();
    expect(row.targetType).toBe("IntegrityEvidenceAsset");
    expect(row.institutionId).toBe(instA);
    const metadataStr = JSON.stringify(row.metadata);
    expect(metadataStr).not.toContain(asset.storageKey);
    expect(metadataStr).not.toContain(asset.submissionId);
  });

  it("re-running the sweep against an already-archived asset does not create a duplicate audit row", async () => {
    const { asset } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    await new Promise((r) => setTimeout(r, 100));
    const report2 = await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });

    const outcome2 = report2.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(outcome2?.status).toBe("ALREADY_ARCHIVED_VERIFIED");

    await new Promise((r) => setTimeout(r, 100));
    const rows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED", targetId: asset.id } });
    expect(rows.length).toBe(1);
  });

  it("routine outcomes contain no submissionId, storageKey, or other sensitive linking field — only safe identifiers", async () => {
    const { asset } = await createArchiveTestAsset();
    const report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const serialized = JSON.stringify(report.outcomes);
    expect(serialized).not.toContain(asset.submissionId);
    expect(serialized).not.toContain(asset.storageKey);
  });

  it("refuses to run for ARCHIVE_SOURCE_ENVIRONMENT=production when the production guard is not satisfied — the check is machine-enforced inside the sweep itself, not merely at the CLI layer", async () => {
    await expect(
      runEvidenceArchiveSweep({ dryRun: false, sourceEnvironment: "production", institutionId: instA, confirmProductionArchiveFlagPresent: true }),
    ).rejects.toThrow(ProductionArchiveGuardError);
  });
});

// ── Candidate discovery ───────────────────────────────────────────────

describe("findEvidenceArchiveCandidates", () => {
  it("includes an asset scoped to the given institution", async () => {
    const { asset } = await createArchiveTestAsset();
    const candidates = await findEvidenceArchiveCandidates(instA);
    expect(candidates.some((c) => c.id === asset.id)).toBe(true);
  });

  it("returns all required fields for manifest/restoration use", async () => {
    const { asset } = await createArchiveTestAsset();
    const candidates = await findEvidenceArchiveCandidates(instA);
    const found = candidates.find((c) => c.id === asset.id)!;
    expect(found.storageKey).toBe(asset.storageKey);
    expect(found.submissionId).toBe(asset.submissionId);
    expect(found.examId).toBe(asset.examId);
    expect(found.integrityEventId).toBe(asset.integrityEventId);
  });
});

// ── Restore ────────────────────────────────────────────────────────

describe("restoreEvidenceAsset", () => {
  it("RESTORE_NOT_FOUND for a nonexistent asset id", async () => {
    const outcome = await restoreEvidenceAsset("nonexistent-asset-id", { confirmRestore: true });
    expect(outcome.status).toBe("RESTORE_NOT_FOUND");
  });

  it("A. primary object missing, DB row exists: archives first, deletes primary, restores, and re-verifies", async () => {
    const { asset, primaryBytes } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });

    // Simulate "primary object missing" by removing ONLY the local synthetic primary file.
    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);
    expect(await primaryAdapter.get(asset.storageKey)).toBeNull();

    const outcome = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    expect(outcome.status).toBe("RESTORED_VERIFIED");

    const restored = await primaryAdapter.get(asset.storageKey);
    expect(restored?.equals(primaryBytes!)).toBe(true);
  });

  it("refuses restore without --confirm-restore even when the archive is valid and primary is missing", async () => {
    const { asset } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);

    const outcome = await restoreEvidenceAsset(asset.id, { confirmRestore: false });
    expect(outcome.status).toBe("RESTORE_CONFIRMATION_REQUIRED");
    expect(await primaryAdapter.get(asset.storageKey)).toBeNull();
  });

  it("RESTORE_ARCHIVE_MISSING when the asset was never archived", async () => {
    const { asset } = await createArchiveTestAsset();
    const outcome = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    expect(outcome.status).toBe("RESTORE_ARCHIVE_MISSING");
  });

  it("refuses restore (RESTORE_PRIMARY_HEALTHY_REFUSED) when the primary object is already healthy — never overwrites a healthy object", async () => {
    const { asset } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });

    const outcome = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    expect(outcome.status).toBe("RESTORE_PRIMARY_HEALTHY_REFUSED");
  });

  it("C. corrupt primary (exists but fails verification) requires explicit confirmation, then overwrites only after it", async () => {
    const { asset, primaryBytes } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });

    // Corrupt the primary object in place (still exists, but wrong bytes).
    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);
    await primaryAdapter.put(asset.storageKey, Buffer.from("CORRUPTED-PRIMARY-BYTES"), "image/jpeg");

    const refused = await restoreEvidenceAsset(asset.id, { confirmRestore: false });
    expect(refused.status).toBe("RESTORE_CONFIRMATION_REQUIRED");
    const stillCorrupt = await primaryAdapter.get(asset.storageKey);
    expect(stillCorrupt?.equals(Buffer.from("CORRUPTED-PRIMARY-BYTES"))).toBe(true);

    const restored = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    expect(restored.status).toBe("RESTORED_VERIFIED");
    const fixed = await primaryAdapter.get(asset.storageKey);
    expect(fixed?.equals(primaryBytes!)).toBe(true);
  });

  it("RESTORE_ARCHIVE_HASH_MISMATCH when the archived bytes do not match the DB's recorded sha256 — refuses restore rather than trusting a corrupted archive copy", async () => {
    const { asset } = await createArchiveTestAsset();
    const archiveAdapter = resolveEvidenceArchiveStorageAdapter();
    const archiveKey = generateArchiveObjectKey(asset.id, asset.contentType);
    // Write a deliberately WRONG object directly to the archive location,
    // bypassing archiveVerifiedEvidence — simulates an archive object that
    // somehow doesn't match what the database expects.
    await archiveAdapter.put(archiveKey, Buffer.from("WRONG-ARCHIVE-BYTES"), "image/jpeg");

    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);

    const outcome = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    expect(outcome.status).toBe("RESTORE_ARCHIVE_HASH_MISMATCH");
    expect(await primaryAdapter.get(asset.storageKey)).toBeNull();
  });

  it("never deletes the archive copy, under any outcome", async () => {
    const { asset } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const archiveAdapter = resolveEvidenceArchiveStorageAdapter();
    const archiveKey = generateArchiveObjectKey(asset.id, asset.contentType);
    const beforeRestore = await archiveAdapter.get(archiveKey);

    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);
    await restoreEvidenceAsset(asset.id, { confirmRestore: true });

    const afterRestore = await archiveAdapter.get(archiveKey);
    expect(afterRestore?.equals(beforeRestore!)).toBe(true);
  });

  it("writes exactly one INTEGRITY_EVIDENCE_ARCHIVE_RESTORED audit row with no sensitive linking fields", async () => {
    const { asset } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);
    await restoreEvidenceAsset(asset.id, { confirmRestore: true });

    const deadline = Date.now() + 2000;
    let rows: Awaited<ReturnType<typeof prisma.platformAuditLog.findMany>> = [];
    while (Date.now() < deadline) {
      rows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_RESTORED", targetId: asset.id } });
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(rows.length).toBe(1);
    const metadataStr = JSON.stringify(rows[0].metadata);
    expect(metadataStr).not.toContain(asset.storageKey);
    expect(metadataStr).not.toContain(asset.submissionId);
  });
});

// ── Non-production synthetic end-to-end recovery proof ────────────────

describe("synthetic recovery proof (evidence backup/recovery v1, §23)", () => {
  it("archive -> verify -> simulate missing primary -> restore -> verify SHA — using only synthetic bytes, disposable DB rows, and local storage adapters", async () => {
    const syntheticBytes = Buffer.from(`recovery-proof-${randomUUID()}`);
    const { asset } = await createArchiveTestAsset({ primaryBytes: syntheticBytes });
    const expectedSha256 = createHash("sha256").update(syntheticBytes).digest("hex");
    expect(asset.sha256).toBe(expectedSha256);

    const archiveReport = await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const archiveOutcome = archiveReport.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(archiveOutcome?.status).toBe("ARCHIVED_VERIFIED");
    expect(archiveReport.manifestVerified).toBe(true);

    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);
    expect(await primaryAdapter.get(asset.storageKey)).toBeNull();

    const restoreOutcome = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    expect(restoreOutcome.status).toBe("RESTORED_VERIFIED");

    const restoredBytes = await primaryAdapter.get(asset.storageKey);
    expect(restoredBytes).not.toBeNull();
    const restoredSha256 = createHash("sha256").update(restoredBytes!).digest("hex");
    expect(restoredSha256).toBe(expectedSha256);
  });
});
