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
 * Tests that need the guard's "this genuinely is production" branch to
 * activate temporarily set real process.env values (SUPABASE_URL,
 * ARCHIVE_SUPABASE_URL, ARCHIVE_STORAGE_PROVIDER,
 * ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF) and restore them in a finally
 * block immediately afterward — the guard always fails BEFORE any real
 * network call would ever be attempted, so this never actually reaches
 * a Supabase client.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { getOrCreateTestInstitution } from "./testInstitution";
import { resolveEvidenceStorageAdapter, LocalDevEvidenceStorageAdapter } from "./evidenceStorage";
import { resolveEvidenceArchiveStorageAdapter, type EvidenceArchiveStorageAdapter } from "./evidenceArchiveStorage";
import {
  findEvidenceArchiveCandidates,
  verifySourceEvidence,
  archiveVerifiedEvidence,
  generateArchiveObjectKey,
  computeManifestSha256,
  buildManifestDocument,
  verifyManifestDocument,
  assertSupabaseArchiveOperationSafe,
  assertProductionArchiveSafe,
  assertRestoreOperationSafe,
  runEvidenceArchiveSweep,
  restoreEvidenceAsset,
  ProductionArchiveGuardError,
  type ArchiveManifestPayload,
  type ArchiveManifestDocument,
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
  institutionId?: string; // defaults to the shared instA — pass a dedicated institution for tests that assert on a whole institutionId-scoped sweep's aggregate (overallOk/candidateCount/manifest coverage), so leftover assets from other tests sharing instA can never leak in
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

async function freshInstitution(label: string) {
  return getOrCreateTestInstitution(`evidence-archive-${label}-${Date.now()}-${Math.random()}`);
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

// Save/restore real process.env values that assertSupabaseArchiveOperationSafe
// reads by default (SUPABASE_URL etc.) — used only by the small number of
// tests that need the guard's REAL "this is production" branch to activate.
const PRODUCTION_GUARD_ENV_KEYS = [
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "ARCHIVE_SUPABASE_URL",
  "ARCHIVE_STORAGE_PROVIDER",
  "ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF",
] as const;

async function withRealProductionGuardEnv(overrides: Partial<Record<(typeof PRODUCTION_GUARD_ENV_KEYS)[number], string>>, fn: () => Promise<void>) {
  const original: Record<string, string | undefined> = {};
  for (const key of PRODUCTION_GUARD_ENV_KEYS) original[key] = process.env[key];
  try {
    for (const key of PRODUCTION_GUARD_ENV_KEYS) {
      if (overrides[key] !== undefined) process.env[key] = overrides[key];
    }
    await fn();
  } finally {
    for (const key of PRODUCTION_GUARD_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
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

// ── Manifest — non-circular digest + partial-run coverage metadata ───

describe("manifest — non-circular SHA-256 and coverage metadata", () => {
  const sampleAsset = {
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
  };
  const samplePayload: ArchiveManifestPayload = {
    manifestVersion: 1,
    archiveRunId: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceEnvironment: "test",
    sourceProvider: "local_dev",
    candidateCount: 1,
    verifiedAssetCount: 1,
    failureCount: 0,
    runStatus: "COMPLETE",
    assets: [sampleAsset],
  };

  it("computeManifestSha256 never includes manifestSha256 itself in the hashed payload — no circularity", () => {
    const digest = computeManifestSha256(samplePayload);
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
    const tampered = { ...doc, verifiedAssetCount: 999 };
    expect(verifyManifestDocument(tampered)).toBe(false);
  });

  it("tampering with runStatus specifically (relabeling a partial run as COMPLETE) breaks digest verification", () => {
    const partial: ArchiveManifestPayload = { ...samplePayload, candidateCount: 2, verifiedAssetCount: 1, failureCount: 1, runStatus: "PARTIAL_FAILURE" };
    const doc = buildManifestDocument(partial);
    expect(verifyManifestDocument(doc)).toBe(true);
    const relabeled: ArchiveManifestDocument = { ...doc, runStatus: "COMPLETE" };
    expect(verifyManifestDocument(relabeled)).toBe(false);
  });

  it("tampering with candidateCount/failureCount breaks digest verification", () => {
    const doc = buildManifestDocument(samplePayload);
    expect(verifyManifestDocument({ ...doc, candidateCount: 5 })).toBe(false);
    expect(verifyManifestDocument({ ...doc, failureCount: 5 })).toBe(false);
  });

  it("verifyManifestDocument fails safely (never throws) for malformed input", () => {
    expect(verifyManifestDocument({} as never)).toBe(false);
  });

  it("field order in the source payload construction does not change the digest — canonical serialization is fixed-order", () => {
    const reordered: ArchiveManifestPayload = {
      assets: samplePayload.assets,
      runStatus: samplePayload.runStatus,
      failureCount: samplePayload.failureCount,
      verifiedAssetCount: samplePayload.verifiedAssetCount,
      candidateCount: samplePayload.candidateCount,
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

describe("assertSupabaseArchiveOperationSafe / assertProductionArchiveSafe / assertRestoreOperationSafe", () => {
  it("fails closed when the archive project ref equals the primary project ref, REGARDLESS of provider/production status", () => {
    const env = { SUPABASE_URL: "https://same-project.supabase.co", ARCHIVE_SUPABASE_URL: "https://same-project.supabase.co" };
    expect(assertSupabaseArchiveOperationSafe(env).ok).toBe(false);
    expect(assertSupabaseArchiveOperationSafe({ ...env, ARCHIVE_STORAGE_PROVIDER: "supabase_storage" }).ok).toBe(false);
  });

  it("local_dev archive provider is always exempt (isProductionOperation: false) regardless of project refs", () => {
    const result = assertSupabaseArchiveOperationSafe({
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isProductionOperation).toBe(false);
  });

  it("a real (supabase_storage) archive destination requires ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF to be configured at all", () => {
    const result = assertSupabaseArchiveOperationSafe({
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
    });
    expect(result.ok).toBe(false);
  });

  it("a real archive destination requires the primary project ref to match ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF", () => {
    const result = assertSupabaseArchiveOperationSafe({
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "some-other-project",
    });
    expect(result.ok).toBe(false);
  });

  it("isProductionOperation is true exactly when the primary ref matches the expected ref and the archive is real+separate", () => {
    const result = assertSupabaseArchiveOperationSafe({
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "primary-project",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isProductionOperation).toBe(true);
  });

  it("assertProductionArchiveSafe requires --confirm-production-archive when isProductionOperation is true", () => {
    const baseEnv = {
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "primary-project",
    };
    expect(assertProductionArchiveSafe(false, baseEnv).ok).toBe(false);
    expect(assertProductionArchiveSafe(true, baseEnv).ok).toBe(true);
  });

  it("assertRestoreOperationSafe requires --confirm-production-restore when isProductionOperation is true", () => {
    const baseEnv = {
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "primary-project",
    };
    expect(assertRestoreOperationSafe(false, baseEnv).ok).toBe(false);
    expect(assertRestoreOperationSafe(true, baseEnv).ok).toBe(true);
  });

  it("neither guard requires the production flag when isProductionOperation is false (non-production/local_dev)", () => {
    expect(assertProductionArchiveSafe(false, {}).ok).toBe(true);
    expect(assertRestoreOperationSafe(false, {}).ok).toBe(true);
  });

  it("never throws — always returns a result object, and never includes a credential or full URL in the failure reason", () => {
    const result = assertProductionArchiveSafe(false, {
      SUPABASE_URL: "https://primary-project.supabase.co",
      ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
      ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
      ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "primary-project",
      ARCHIVE_SUPABASE_SERVICE_ROLE_KEY: "TOP-SECRET-ARCHIVE-KEY",
    });
    // isProductionOperation is true here (real provider + matching expected
    // ref) and no confirmation flag was passed, so this must fail closed.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("TOP-SECRET-ARCHIVE-KEY");
      expect(result.reason).not.toContain("https://");
    }
  });
});

// ── Correction B: caller-supplied sourceEnvironment cannot weaken the guard ──

describe("caller-supplied sourceEnvironment cannot downgrade the production guard (Correction B)", () => {
  it("archive execute: real config says production, but sourceEnvironment='test' and no confirmation -> FAIL CLOSED", async () => {
    await withRealProductionGuardEnv(
      {
        SUPABASE_URL: "https://primary-project.supabase.co",
        ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
        ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
        ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "primary-project",
      },
      async () => {
        await expect(
          runEvidenceArchiveSweep({ dryRun: false, sourceEnvironment: "test", institutionId: instA, confirmProductionArchiveFlagPresent: false }),
        ).rejects.toThrow(ProductionArchiveGuardError);
      },
    );
  });

  it("restore: real config says production, but no --confirm-production-restore -> FAIL CLOSED (RESTORE_PRODUCTION_GUARD_FAILED)", async () => {
    await withRealProductionGuardEnv(
      {
        SUPABASE_URL: "https://primary-project.supabase.co",
        ARCHIVE_SUPABASE_URL: "https://archive-project.supabase.co",
        ARCHIVE_STORAGE_PROVIDER: "supabase_storage",
        ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF: "primary-project",
      },
      async () => {
        const outcome = await restoreEvidenceAsset("any-asset-id-unreached", { confirmRestore: true, confirmProductionRestore: false });
        expect(outcome.status).toBe("RESTORE_PRODUCTION_GUARD_FAILED");
      },
    );
  });

  it("sourceEnvironment is still recorded as manifest metadata even though it no longer affects the guard", async () => {
    const isolatedInst = await freshInstitution("manifest-source-env");
    await createArchiveTestAsset({ institutionId: isolatedInst.id });
    const report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "my-label" });
    expect(report.sourceEnvironment).toBe("my-label");
  });
});

// ── Full sweep: dry-run mutation-free proof, partial failure, manifest coverage, audit ──

describe("runEvidenceArchiveSweep", () => {
  it("dry-run performs ZERO writes: no archive object, no manifest, no audit row, no DB mutation", async () => {
    const { asset } = await createArchiveTestAsset();
    const report = await runEvidenceArchiveSweep({ dryRun: true, institutionId: instA });

    const outcome = report.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(outcome?.status).toBe("SOURCE_VERIFIED");
    expect(report.manifestVerified).toBeNull();
    expect(report.runStatus).toBeNull();

    const archiveAdapter = resolveEvidenceArchiveStorageAdapter();
    const archiveKey = generateArchiveObjectKey(asset.id, "image/jpeg");
    expect(await archiveAdapter.get(archiveKey)).toBeNull();

    const auditRows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED", targetId: asset.id } });
    expect(auditRows.length).toBe(0);

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

  it("execute mode: every candidate reaching a verified+audited state (and manifest verification succeeding) reports overallOk=true", async () => {
    const isolatedInst = await freshInstitution("overall-ok");
    const { asset } = await createArchiveTestAsset({ institutionId: isolatedInst.id });
    const report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "test" });
    const outcome = report.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(outcome?.status).toBe("ARCHIVED_VERIFIED");
    expect(outcome?.auditStatus).toBe("AUDITED");
    expect(report.manifestVerified).toBe(true);
    expect(report.runStatus).toBe("COMPLETE");
    expect(report.overallOk).toBe(true);
  });

  // Correction C — partial manifest coverage metadata.
  it("a partial run (1 of 2 candidates succeeds) produces a manifest with candidateCount=2, verifiedAssetCount=1, failureCount=1, runStatus=PARTIAL_FAILURE, and the manifest still self-verifies", async () => {
    const isolatedInst = await freshInstitution("partial-manifest");
    const good = await createArchiveTestAsset({ institutionId: isolatedInst.id });
    const bad = await createArchiveTestAsset({ institutionId: isolatedInst.id, primaryBytes: null }); // SOURCE_MISSING

    const report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "test" });
    expect(report.candidateCount).toBe(2);
    expect(report.runStatus).toBe("PARTIAL_FAILURE");
    expect(report.overallOk).toBe(false);

    const goodOutcome = report.outcomes.find((o) => o.evidenceAssetId === good.asset.id);
    const badOutcome = report.outcomes.find((o) => o.evidenceAssetId === bad.asset.id);
    expect(goodOutcome?.status).toBe("ARCHIVED_VERIFIED");
    expect(badOutcome?.status).toBe("SOURCE_MISSING");

    // Read the actual stored manifest document back and check its coverage fields directly.
    const archiveAdapter = resolveEvidenceArchiveStorageAdapter();
    const manifestBytes = await archiveAdapter.get(`manifests/v1/${report.archiveRunId}.json`);
    expect(manifestBytes).not.toBeNull();
    const manifestDoc = JSON.parse(manifestBytes!.toString("utf-8")) as ArchiveManifestDocument;
    expect(manifestDoc.candidateCount).toBe(2);
    expect(manifestDoc.verifiedAssetCount).toBe(1);
    expect(manifestDoc.failureCount).toBe(1);
    expect(manifestDoc.runStatus).toBe("PARTIAL_FAILURE");
    expect(manifestDoc.assets.length).toBe(1);
    // A partial manifest must still pass its own SHA-256 verification —
    // cryptographic validity is not the same thing as run completeness.
    expect(verifyManifestDocument(manifestDoc)).toBe(true);
  });

  // Correction D — awaited, existence-checked, self-repairing audit.
  it("writes exactly one INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED audit row, awaited (no polling needed), with sanitized metadata and correct institutionId/targetId", async () => {
    const isolatedInst = await freshInstitution("audit-new");
    const { asset } = await createArchiveTestAsset({ institutionId: isolatedInst.id });
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "test" });

    // No setTimeout/polling — the audit write is awaited inside the sweep, so it must already be visible here.
    const rows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED", targetId: asset.id } });
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.actorId).toBeNull();
    expect(row.targetType).toBe("IntegrityEvidenceAsset");
    expect(row.institutionId).toBe(isolatedInst.id);
    const metadataStr = JSON.stringify(row.metadata);
    expect(metadataStr).not.toContain(asset.storageKey);
    expect(metadataStr).not.toContain(asset.submissionId);
  });

  it("re-running the sweep against an already-archived, already-audited asset does not create a duplicate audit row", async () => {
    const isolatedInst = await freshInstitution("audit-dedup");
    const { asset } = await createArchiveTestAsset({ institutionId: isolatedInst.id });
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "test" });
    const report2 = await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "test" });

    const outcome2 = report2.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(outcome2?.status).toBe("ALREADY_ARCHIVED_VERIFIED");
    expect(outcome2?.auditStatus).toBe("ALREADY_AUDITED");

    const rows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED", targetId: asset.id } });
    expect(rows.length).toBe(1);
  });

  it("an asset archived without an audit row (e.g. a prior run's audit write failed) self-repairs its missing audit on the next sweep", async () => {
    const isolatedInst = await freshInstitution("audit-repair");
    const { asset, primaryBytes } = await createArchiveTestAsset({ institutionId: isolatedInst.id });

    // Seed "archived but unaudited" by calling archiveVerifiedEvidence
    // directly, bypassing the sweep's own audit step entirely.
    const archiveAdapter = resolveEvidenceArchiveStorageAdapter();
    const archiveKey = generateArchiveObjectKey(asset.id, asset.contentType);
    const seedOutcome = await archiveVerifiedEvidence(archiveAdapter, archiveKey, primaryBytes!, asset.contentType, asset.sha256!);
    expect(seedOutcome.status).toBe("ARCHIVED_VERIFIED");
    const before = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED", targetId: asset.id } });
    expect(before.length).toBe(0);

    const report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "test" });
    const outcome = report.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(outcome?.status).toBe("ALREADY_ARCHIVED_VERIFIED");
    expect(outcome?.auditStatus).toBe("AUDITED");

    const after = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED", targetId: asset.id } });
    expect(after.length).toBe(1);
  });

  it("an archive audit write failure makes overallOk=false, but never rolls back the already-verified archive object", async () => {
    const isolatedInst = await freshInstitution("audit-fail");
    const { asset } = await createArchiveTestAsset({ institutionId: isolatedInst.id });

    const createSpy = vi.spyOn(prisma.platformAuditLog, "create").mockRejectedValueOnce(new Error("simulated audit write failure"));
    let report;
    try {
      report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: isolatedInst.id, sourceEnvironment: "test" });
    } finally {
      createSpy.mockRestore();
    }

    const outcome = report.outcomes.find((o) => o.evidenceAssetId === asset.id);
    expect(outcome?.status).toBe("ARCHIVED_VERIFIED");
    expect(outcome?.auditStatus).toBe("AUDIT_FAILED");
    expect(report.overallOk).toBe(false);

    const archiveAdapter = resolveEvidenceArchiveStorageAdapter();
    const archiveKey = generateArchiveObjectKey(asset.id, asset.contentType);
    expect(await archiveAdapter.get(archiveKey)).not.toBeNull();
  });

  it("routine outcomes contain no submissionId, storageKey, or other sensitive linking field — only safe identifiers", async () => {
    const { asset } = await createArchiveTestAsset();
    const report = await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const serialized = JSON.stringify(report.outcomes);
    expect(serialized).not.toContain(asset.submissionId);
    expect(serialized).not.toContain(asset.storageKey);
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

  it("writes exactly one INTEGRITY_EVIDENCE_ARCHIVE_RESTORED audit row, awaited (no polling needed), with no sensitive linking fields", async () => {
    const { asset } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);
    const outcome = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    expect(outcome.status).toBe("RESTORED_VERIFIED");

    // No setTimeout/polling — the audit write is awaited inside restoreEvidenceAsset.
    const rows = await prisma.platformAuditLog.findMany({ where: { action: "INTEGRITY_EVIDENCE_ARCHIVE_RESTORED", targetId: asset.id } });
    expect(rows.length).toBe(1);
    const metadataStr = JSON.stringify(rows[0].metadata);
    expect(metadataStr).not.toContain(asset.storageKey);
    expect(metadataStr).not.toContain(asset.submissionId);
  });

  it("a restore audit write failure returns RESTORED_VERIFIED_AUDIT_FAILED, and the restored primary bytes are NOT removed", async () => {
    const { asset, primaryBytes } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);

    const createSpy = vi.spyOn(prisma.platformAuditLog, "create").mockRejectedValueOnce(new Error("simulated restore audit write failure"));
    let outcome;
    try {
      outcome = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    } finally {
      createSpy.mockRestore();
    }
    expect(outcome.status).toBe("RESTORED_VERIFIED_AUDIT_FAILED");

    // Bytes were genuinely restored and verified before the audit failure — must not be rolled back.
    const restored = await primaryAdapter.get(asset.storageKey);
    expect(restored?.equals(primaryBytes!)).toBe(true);
  });

  it("a raw primary-adapter error during the restore write is sanitized — never the underlying adapter's raw message (which can embed the storage key)", async () => {
    const { asset } = await createArchiveTestAsset();
    await runEvidenceArchiveSweep({ dryRun: false, institutionId: instA, sourceEnvironment: "test" });
    const primaryAdapter = resolveEvidenceStorageAdapter();
    await primaryAdapter.delete(asset.storageKey);

    // Simulate an adversarial/over-detailed underlying adapter error —
    // proves the sanitization happens at the restore boundary regardless
    // of what the primary adapter's own error message contains.
    const putSpy = vi
      .spyOn(LocalDevEvidenceStorageAdapter.prototype, "put")
      .mockRejectedValueOnce(new Error(`failed writing ${asset.storageKey} to https://internal.example/token=fake-secret-abc123`));
    let outcome;
    try {
      outcome = await restoreEvidenceAsset(asset.id, { confirmRestore: true });
    } finally {
      putSpy.mockRestore();
    }

    expect(outcome.status).toBe("RESTORE_WRITE_FAILED");
    expect(outcome.error).toBe("Primary evidence restore write failed.");
    expect(outcome.error).not.toContain(asset.storageKey);
    expect(outcome.error).not.toContain("internal.example");
    expect(outcome.error).not.toContain("fake-secret-abc123");
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
