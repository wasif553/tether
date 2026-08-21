/**
 * Evidence Backup/Recovery v1 — archive/restore orchestrator. See
 * docs/tether-evidence-archive-plan.md.
 *
 * Manual, operator-triggered only — exposed via `scripts/run-evidence-archive.ts`
 * (`npm run evidence:archive`). Nothing in this codebase calls this
 * automatically: no cron, no route, no build step, no server startup
 * hook. Mirrors the established conventions of
 * src/lib/evidenceRetentionRunner.ts (dry-run by default, never throws
 * for a single-asset failure, PlatformAuditLog on success only) but is
 * otherwise fully independent of it — this module never deletes a
 * primary evidence object or database row.
 *
 * Source of truth remains IntegrityEvidenceAsset metadata + the PRIMARY
 * EvidenceStorageAdapter object (src/lib/evidenceStorage.ts, unmodified
 * by this pass). Every asset is re-verified against its own recorded
 * SHA-256 before it is ever archived, and the archived copy is
 * downloaded and re-verified again after every write — an archive write
 * is never trusted on upload-success alone.
 */
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { resolveEvidenceStorageAdapter } from "@/lib/evidenceStorage";
import {
  resolveEvidenceArchiveStorageAdapter,
  extractSupabaseProjectRef,
  type EvidenceArchiveStorageAdapter,
  type EvidenceArchiveStorageEnv,
} from "@/lib/evidenceArchiveStorage";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

const ARCHIVE_VERIFIED_AUDIT_ACTION = "INTEGRITY_EVIDENCE_ARCHIVE_VERIFIED";
const ARCHIVE_RESTORED_AUDIT_ACTION = "INTEGRITY_EVIDENCE_ARCHIVE_RESTORED";

// Content-type -> extension mapping for archive object keys. Deliberately
// a small private copy rather than importing from aiCameraEvidenceFrame.ts
// or screenShareEvidence.ts (neither currently exports its own copy) —
// this pass makes zero changes to either already-reviewed module. Values
// must stay in sync with ALLOWED_EVIDENCE_FRAME_CONTENT_TYPES /
// ALLOWED_SCREEN_EVIDENCE_CONTENT_TYPES (both are exactly {image/jpeg,
// image/webp} today).
const ARCHIVE_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Deterministic, evidence-asset-scoped key — `evidence/v1/<id>.<ext>`.
 * NEVER includes an archiveRunId or random suffix: the same asset must
 * always resolve to the same archive object regardless of how many times
 * a sweep is (re)run, which is what makes the idempotency check in
 * archiveVerifiedEvidence below meaningful. Contains no student name,
 * email, student id, submissionId, examId, or the primary storageKey —
 * only the asset's own opaque id.
 */
export function generateArchiveObjectKey(evidenceAssetId: string, contentType: string): string {
  const ext = ARCHIVE_CONTENT_TYPE_EXTENSIONS[contentType] ?? "bin";
  return `evidence/v1/${evidenceAssetId}.${ext}`;
}

export type EvidenceArchiveCandidate = {
  id: string;
  kind: string;
  contentType: string;
  byteSize: number;
  sha256: string | null;
  capturedAt: Date;
  storageKey: string;
  institutionId: string;
  examId: string;
  submissionId: string;
  integrityEventId: string;
};

/**
 * `institutionId` is accepted but deliberately NOT exposed as a CLI flag
 * in v1 (see scripts/run-evidence-archive.ts and the architecture-gate
 * decision doc) — at current pilot scale a full, unfiltered archive run
 * is simpler and safer than partial/filtered runs. The parameter exists
 * only for test isolation, mirroring the identical, already-shipped
 * precedent in findEligibleEvidenceAssetsForDeletion
 * (evidenceRetentionRunner.ts), whose own CLI likewise never surfaces it.
 */
export async function findEvidenceArchiveCandidates(institutionId?: string): Promise<EvidenceArchiveCandidate[]> {
  return prisma.integrityEvidenceAsset.findMany({
    where: institutionId ? { institutionId } : undefined,
    select: {
      id: true,
      kind: true,
      contentType: true,
      byteSize: true,
      sha256: true,
      capturedAt: true,
      storageKey: true,
      institutionId: true,
      examId: true,
      submissionId: true,
      integrityEventId: true,
    },
    orderBy: { capturedAt: "asc" },
  });
}

export type SourceVerificationStatus = "SOURCE_MISSING" | "SOURCE_DIGEST_MISSING" | "SOURCE_HASH_MISMATCH" | "SOURCE_SIZE_MISMATCH";
export type SourceVerificationResult = { ok: true; bytes: Buffer } | { ok: false; status: SourceVerificationStatus };

/**
 * Reads the PRIMARY object (never writes/deletes it) and proves the
 * bytes actually match what IntegrityEvidenceAsset recorded at capture
 * time, before this module will ever consider archiving them. A
 * corrupt/tampered/mismatched object is never archived as if it were
 * trustworthy.
 */
export async function verifySourceEvidence(asset: EvidenceArchiveCandidate): Promise<SourceVerificationResult> {
  const primaryAdapter = resolveEvidenceStorageAdapter();
  const bytes = await primaryAdapter.get(asset.storageKey);
  if (!bytes) return { ok: false, status: "SOURCE_MISSING" };
  if (!asset.sha256) return { ok: false, status: "SOURCE_DIGEST_MISSING" };
  const computedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (computedSha256 !== asset.sha256) return { ok: false, status: "SOURCE_HASH_MISMATCH" };
  if (bytes.byteLength !== asset.byteSize) return { ok: false, status: "SOURCE_SIZE_MISMATCH" };
  return { ok: true, bytes };
}

export type ArchiveWriteStatus =
  | "ARCHIVED_VERIFIED"
  | "ALREADY_ARCHIVED_VERIFIED"
  | "ARCHIVE_WRITE_FAILED"
  | "ARCHIVE_VERIFY_FAILED"
  | "ARCHIVE_CONFLICT";
export type ArchiveWriteOutcome = { status: ArchiveWriteStatus; error?: string };

/**
 * Idempotent, verified archive write for ONE already-source-verified
 * asset. Order: check whether the deterministic key already exists
 * (§10) -> if it does, SHA-verify it (match = safe no-op, mismatch =
 * fail closed, never overwrite) -> otherwise upload (upsert:false at the
 * adapter level) -> download the just-written bytes back and re-verify
 * their SHA-256 + size before ever reporting success (§11). Never
 * trusts a provider's "upload succeeded" response alone.
 */
export async function archiveVerifiedEvidence(
  archiveAdapter: EvidenceArchiveStorageAdapter,
  archiveKey: string,
  bytes: Buffer,
  contentType: string,
  expectedSha256: string,
): Promise<ArchiveWriteOutcome> {
  let existing: Buffer | null;
  try {
    existing = await archiveAdapter.get(archiveKey);
  } catch (err) {
    return { status: "ARCHIVE_WRITE_FAILED", error: err instanceof Error ? err.message : String(err) };
  }
  if (existing) {
    const existingSha256 = createHash("sha256").update(existing).digest("hex");
    if (existingSha256 === expectedSha256 && existing.byteLength === bytes.byteLength) {
      return { status: "ALREADY_ARCHIVED_VERIFIED" };
    }
    // Never overwrite a conflicting existing archive object automatically.
    return { status: "ARCHIVE_CONFLICT" };
  }

  try {
    await archiveAdapter.put(archiveKey, bytes, contentType);
  } catch (err) {
    return { status: "ARCHIVE_WRITE_FAILED", error: err instanceof Error ? err.message : String(err) };
  }

  let readBack: Buffer | null;
  try {
    readBack = await archiveAdapter.get(archiveKey);
  } catch (err) {
    return { status: "ARCHIVE_VERIFY_FAILED", error: err instanceof Error ? err.message : String(err) };
  }
  if (!readBack) return { status: "ARCHIVE_VERIFY_FAILED" };
  const readBackSha256 = createHash("sha256").update(readBack).digest("hex");
  if (readBackSha256 !== expectedSha256 || readBack.byteLength !== bytes.byteLength) {
    return { status: "ARCHIVE_VERIFY_FAILED" };
  }
  return { status: "ARCHIVED_VERIFIED" };
}

// ---------------------------------------------------------------------------
// Manifest — see docs/tether-evidence-archive-plan.md, "Non-circular
// manifest hash".
// ---------------------------------------------------------------------------

export type ArchiveManifestAssetEntry = {
  evidenceAssetId: string;
  kind: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  capturedAt: string;
  archiveObjectKey: string;
  verificationStatus: string;
  // Protected/private restoration-only fields — never printed to routine
  // CLI output or written to an audit-log row. Safe here ONLY because
  // the manifest itself lives inside the private archive bucket, under
  // the same access control as the archived bytes.
  originalStorageKey: string;
  institutionId: string;
  examId: string;
  submissionId: string;
  integrityEventId: string;
};

export type ArchiveManifestPayload = {
  manifestVersion: number;
  archiveRunId: string;
  createdAt: string;
  sourceEnvironment: string;
  sourceProvider: string;
  assetCount: number;
  assets: ArchiveManifestAssetEntry[];
};

export type ArchiveManifestDocument = ArchiveManifestPayload & { manifestSha256: string };

/**
 * Reconstructs a NEW plain object with an explicit, fixed field order
 * (never relies on whatever order the caller happened to build the
 * payload in) and serializes that — this is the "canonical" form the
 * digest is computed over. Deliberately excludes manifestSha256 itself:
 * hashing a document that already contains its own digest is circular
 * and would make verification meaningless. No third-party canonical-JSON
 * dependency — a small fixed-order serializer is sufficient here and is
 * directly covered by tests.
 */
function canonicalManifestPayloadJson(payload: ArchiveManifestPayload): string {
  const canonical = {
    manifestVersion: payload.manifestVersion,
    archiveRunId: payload.archiveRunId,
    createdAt: payload.createdAt,
    sourceEnvironment: payload.sourceEnvironment,
    sourceProvider: payload.sourceProvider,
    assetCount: payload.assetCount,
    assets: payload.assets.map((a) => ({
      evidenceAssetId: a.evidenceAssetId,
      kind: a.kind,
      contentType: a.contentType,
      byteSize: a.byteSize,
      sha256: a.sha256,
      capturedAt: a.capturedAt,
      archiveObjectKey: a.archiveObjectKey,
      verificationStatus: a.verificationStatus,
      originalStorageKey: a.originalStorageKey,
      institutionId: a.institutionId,
      examId: a.examId,
      submissionId: a.submissionId,
      integrityEventId: a.integrityEventId,
    })),
  };
  return JSON.stringify(canonical);
}

export function computeManifestSha256(payload: ArchiveManifestPayload): string {
  return createHash("sha256").update(canonicalManifestPayloadJson(payload)).digest("hex");
}

export function buildManifestDocument(payload: ArchiveManifestPayload): ArchiveManifestDocument {
  return { ...payload, manifestSha256: computeManifestSha256(payload) };
}

/**
 * Excludes manifestSha256 from the document, reconstructs the canonical
 * payload, recomputes the digest, and compares — the exact inverse of
 * buildManifestDocument. Returns false (never throws) for any malformed
 * input, since this is called against bytes read back from the archive.
 */
export function verifyManifestDocument(doc: ArchiveManifestDocument): boolean {
  try {
    const { manifestSha256, ...payload } = doc;
    return computeManifestSha256(payload as ArchiveManifestPayload) === manifestSha256;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Machine-enforced production/project-separation guard.
// ---------------------------------------------------------------------------

export class ProductionArchiveGuardError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProductionArchiveGuardError";
  }
}

export type ProductionArchiveGuardEnv = EvidenceArchiveStorageEnv & {
  ARCHIVE_SOURCE_ENVIRONMENT?: string;
  ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF?: string;
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
};

export type ProductionArchiveGuardResult =
  | { ok: true; primaryProjectRef: string | null; archiveProjectRef: string | null }
  | { ok: false; reason: string; primaryProjectRef: string | null; archiveProjectRef: string | null };

/**
 * Machine-enforced, not merely a printed confirmation prompt — this
 * function is called from inside runEvidenceArchiveSweep itself
 * (defense in depth: even a caller that bypasses the CLI cannot skip
 * it), and it fails closed unless every one of the following holds:
 *
 *   1. UNIVERSAL, regardless of declared environment: the archive
 *      project must never resolve to the same Supabase project as the
 *      primary. A same-project "backup" shares the primary's own
 *      service-role blast radius and is not a real backup at all (see
 *      docs/tether-evidence-archive-plan.md's own rejection of Option A
 *      on exactly this basis).
 *   2. Only when ARCHIVE_SOURCE_ENVIRONMENT === "production" (an
 *      operator-declared statement of intent — deliberately NOT derived
 *      from NODE_ENV/VERCEL_ENV, since this tool is meant to run from an
 *      operator workstation, not a Vercel deployment):
 *        a. the archive provider must be a real remote destination
 *           (never local_dev — a filesystem archive is not durable/
 *           shareable and defeats the purpose for a real production
 *           archive, mirroring evidenceStorage.ts's own equivalent
 *           production guard for the PRIMARY adapter);
 *        b. the primary project ref must match the operator-configured
 *           ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF (catches a stray/
 *           wrong-project primary config before it can silently archive
 *           the wrong data as if it were production);
 *        c. --confirm-production-archive must have been explicitly
 *           passed.
 */
export function assertProductionArchiveSafe(
  confirmProductionArchiveFlagPresent: boolean,
  env: ProductionArchiveGuardEnv = process.env,
): ProductionArchiveGuardResult {
  const primaryUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const archiveUrl = env.ARCHIVE_SUPABASE_URL;
  const primaryProjectRef = extractSupabaseProjectRef(primaryUrl);
  const archiveProjectRef = extractSupabaseProjectRef(archiveUrl);

  if (archiveProjectRef && primaryProjectRef && archiveProjectRef === primaryProjectRef) {
    return {
      ok: false,
      reason: "Archive Supabase project is the same as the primary Supabase project — refusing to use the primary project as its own backup.",
      primaryProjectRef,
      archiveProjectRef,
    };
  }

  if (env.ARCHIVE_SOURCE_ENVIRONMENT !== "production") {
    return { ok: true, primaryProjectRef, archiveProjectRef };
  }

  if (!archiveProjectRef || env.ARCHIVE_STORAGE_PROVIDER !== "supabase_storage") {
    return {
      ok: false,
      reason: "ARCHIVE_SOURCE_ENVIRONMENT=production requires a configured, real (supabase_storage) archive destination.",
      primaryProjectRef,
      archiveProjectRef,
    };
  }
  if (!env.ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF || primaryProjectRef !== env.ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF) {
    return {
      ok: false,
      reason: "Primary Supabase project ref does not match the configured ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF.",
      primaryProjectRef,
      archiveProjectRef,
    };
  }
  if (!confirmProductionArchiveFlagPresent) {
    return {
      ok: false,
      reason: "Production archive execution requires --confirm-production-archive.",
      primaryProjectRef,
      archiveProjectRef,
    };
  }
  return { ok: true, primaryProjectRef, archiveProjectRef };
}

// ---------------------------------------------------------------------------
// Sweep orchestrator.
// ---------------------------------------------------------------------------

export type ArchiveAssetOutcomeStatus = SourceVerificationStatus | ArchiveWriteStatus | "SOURCE_VERIFIED";

export type ArchiveAssetOutcome = {
  evidenceAssetId: string;
  kind: string;
  capturedAt: Date;
  byteSize: number;
  status: ArchiveAssetOutcomeStatus;
  error?: string;
};

export type ArchiveSweepReport = {
  archiveRunId: string;
  createdAt: Date;
  sourceEnvironment: string;
  dryRun: boolean;
  candidateCount: number;
  outcomes: ArchiveAssetOutcome[];
  /** true only if EVERY candidate reached ARCHIVED_VERIFIED/ALREADY_ARCHIVED_VERIFIED (execute mode) — or every candidate passed source verification (dry-run mode, informational only). */
  overallOk: boolean;
  /** null in dry-run (no manifest is ever written); true/false in execute mode. */
  manifestVerified: boolean | null;
};

/**
 * The one entry point a caller (the CLI, or a future operator tool)
 * should use. `dryRun: true` (the default) only downloads and
 * source-verifies each candidate — it NEVER touches the archive
 * destination, writes a manifest, writes an audit row, or modifies the
 * database or primary storage in any way (see the "dry-run performs no
 * writes" tests). Only `dryRun: false` calls assertProductionArchiveSafe
 * and, if it passes, actually archives anything.
 */
export async function runEvidenceArchiveSweep(options: {
  dryRun: boolean;
  sourceEnvironment?: string;
  archiveRunId?: string;
  now?: Date;
  confirmProductionArchiveFlagPresent?: boolean;
  institutionId?: string;
}): Promise<ArchiveSweepReport> {
  const now = options.now ?? new Date();
  const archiveRunId = options.archiveRunId ?? randomUUID();
  const sourceEnvironment = options.sourceEnvironment ?? "unspecified";

  let archiveAdapter: EvidenceArchiveStorageAdapter | null = null;
  if (!options.dryRun) {
    const guard = assertProductionArchiveSafe(options.confirmProductionArchiveFlagPresent ?? false, {
      ...process.env,
      ARCHIVE_SOURCE_ENVIRONMENT: sourceEnvironment,
    });
    if (!guard.ok) throw new ProductionArchiveGuardError(guard.reason);
    archiveAdapter = resolveEvidenceArchiveStorageAdapter();
  }

  const candidates = await findEvidenceArchiveCandidates(options.institutionId);
  const outcomes: ArchiveAssetOutcome[] = [];
  const manifestAssets: ArchiveManifestAssetEntry[] = [];

  for (const candidate of candidates) {
    const base = { evidenceAssetId: candidate.id, kind: candidate.kind, capturedAt: candidate.capturedAt, byteSize: candidate.byteSize };
    const verification = await verifySourceEvidence(candidate);
    if (!verification.ok) {
      outcomes.push({ ...base, status: verification.status });
      continue;
    }

    if (options.dryRun) {
      outcomes.push({ ...base, status: "SOURCE_VERIFIED" });
      continue;
    }

    const archiveKey = generateArchiveObjectKey(candidate.id, candidate.contentType);
    const writeOutcome = await archiveVerifiedEvidence(archiveAdapter!, archiveKey, verification.bytes, candidate.contentType, candidate.sha256!);
    outcomes.push({ ...base, status: writeOutcome.status, error: writeOutcome.error });

    if (writeOutcome.status === "ARCHIVED_VERIFIED" || writeOutcome.status === "ALREADY_ARCHIVED_VERIFIED") {
      manifestAssets.push({
        evidenceAssetId: candidate.id,
        kind: candidate.kind,
        contentType: candidate.contentType,
        byteSize: candidate.byteSize,
        sha256: candidate.sha256!,
        capturedAt: candidate.capturedAt.toISOString(),
        archiveObjectKey: archiveKey,
        verificationStatus: writeOutcome.status,
        originalStorageKey: candidate.storageKey,
        institutionId: candidate.institutionId,
        examId: candidate.examId,
        submissionId: candidate.submissionId,
        integrityEventId: candidate.integrityEventId,
      });
    }
  }

  let manifestVerified: boolean | null = null;
  if (!options.dryRun) {
    const payload: ArchiveManifestPayload = {
      manifestVersion: 1,
      archiveRunId,
      createdAt: now.toISOString(),
      sourceEnvironment,
      sourceProvider: archiveAdapter!.provider,
      assetCount: manifestAssets.length,
      assets: manifestAssets,
    };
    const manifestDocument = buildManifestDocument(payload);
    const manifestKey = `manifests/v1/${archiveRunId}.json`;
    try {
      await archiveAdapter!.put(manifestKey, Buffer.from(JSON.stringify(manifestDocument)), "application/json");
      const readBack = await archiveAdapter!.get(manifestKey);
      manifestVerified = readBack ? verifyManifestDocument(JSON.parse(readBack.toString("utf-8"))) : false;
    } catch {
      manifestVerified = false;
    }

    // Audit only NEWLY archived assets (ARCHIVED_VERIFIED) — never
    // ALREADY_ARCHIVED_VERIFIED reruns, which would otherwise create an
    // unbounded number of duplicate audit rows every time the sweep is
    // re-run against a stable, already-archived dataset. This is a
    // deliberate, documented choice (see docs/tether-evidence-archive-plan.md).
    for (const outcome of outcomes) {
      if (outcome.status !== "ARCHIVED_VERIFIED") continue;
      const candidate = candidates.find((c) => c.id === outcome.evidenceAssetId);
      if (!candidate) continue;
      createPlatformAuditLog({
        actorId: null,
        action: ARCHIVE_VERIFIED_AUDIT_ACTION,
        targetType: "IntegrityEvidenceAsset",
        targetId: candidate.id,
        institutionId: candidate.institutionId,
        metadata: {
          kind: candidate.kind,
          byteSize: candidate.byteSize,
          archiveProvider: archiveAdapter!.provider,
          archiveRunId,
          verificationStatus: outcome.status,
        },
      }).catch(() => {});
    }
  }

  const overallOk = options.dryRun
    ? outcomes.every((o) => o.status === "SOURCE_VERIFIED")
    : outcomes.every((o) => o.status === "ARCHIVED_VERIFIED" || o.status === "ALREADY_ARCHIVED_VERIFIED") && manifestVerified === true;

  return { archiveRunId, createdAt: now, sourceEnvironment, dryRun: options.dryRun, candidateCount: candidates.length, outcomes, overallOk, manifestVerified };
}

// ---------------------------------------------------------------------------
// Restore — minimum pilot capability only. See docs/tether-evidence-archive-plan.md,
// "DB_METADATA_RECONSTRUCTION: MANUAL_RECOVERY_PROCEDURE / NOT AUTOMATED" —
// this NEVER recreates an IntegrityEvidenceAsset/IntegrityEvent/Submission/
// Exam row; it only ever writes bytes back to the PRIMARY storage adapter
// for an asset whose database row already exists.
// ---------------------------------------------------------------------------

export type RestoreStatus =
  | "RESTORE_NOT_FOUND"
  | "RESTORE_ARCHIVE_MISSING"
  | "RESTORE_DB_DIGEST_MISSING"
  | "RESTORE_ARCHIVE_HASH_MISMATCH"
  | "RESTORE_PRIMARY_HEALTHY_REFUSED"
  | "RESTORE_CONFIRMATION_REQUIRED"
  | "RESTORE_WRITE_FAILED"
  | "RESTORE_VERIFY_FAILED"
  | "RESTORED_VERIFIED";
export type RestoreOutcome = { status: RestoreStatus; error?: string };

/**
 * Restores ONE evidence asset's bytes from the archive back to primary
 * storage. Explicit, single-asset, operator-invoked only — never
 * automatic, never bulk. Supports exactly two pilot scenarios:
 *   A. primary object missing, IntegrityEvidenceAsset row still exists
 *   C. primary object exists but fails SHA-256 verification (corrupt),
 *      metadata still exists
 * A healthy, verified-correct primary object is always refused (never
 * overwritten) regardless of confirmation. The archive copy is never
 * deleted by this function, under any outcome.
 */
export async function restoreEvidenceAsset(evidenceAssetId: string, options: { confirmRestore: boolean }): Promise<RestoreOutcome> {
  const asset = await prisma.integrityEvidenceAsset.findUnique({
    where: { id: evidenceAssetId },
    select: { id: true, contentType: true, sha256: true, byteSize: true, storageKey: true, institutionId: true, kind: true },
  });
  if (!asset) return { status: "RESTORE_NOT_FOUND" };
  if (!asset.sha256) return { status: "RESTORE_DB_DIGEST_MISSING" };

  const archiveAdapter = resolveEvidenceArchiveStorageAdapter();
  const archiveKey = generateArchiveObjectKey(asset.id, asset.contentType);
  let archiveBytes: Buffer | null;
  try {
    archiveBytes = await archiveAdapter.get(archiveKey);
  } catch {
    archiveBytes = null;
  }
  if (!archiveBytes) return { status: "RESTORE_ARCHIVE_MISSING" };

  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  if (archiveSha256 !== asset.sha256 || archiveBytes.byteLength !== asset.byteSize) {
    return { status: "RESTORE_ARCHIVE_HASH_MISMATCH" };
  }

  const primaryAdapter = resolveEvidenceStorageAdapter();
  const existingPrimary = await primaryAdapter.get(asset.storageKey);
  if (existingPrimary) {
    const existingSha256 = createHash("sha256").update(existingPrimary).digest("hex");
    const primaryHealthy = existingSha256 === asset.sha256 && existingPrimary.byteLength === asset.byteSize;
    if (primaryHealthy) return { status: "RESTORE_PRIMARY_HEALTHY_REFUSED" };
  }
  if (!options.confirmRestore) return { status: "RESTORE_CONFIRMATION_REQUIRED" };

  try {
    // A corrupt primary object must be removed before put() can write the
    // restored bytes — the primary adapter's put() always uses
    // upsert:false (see evidenceStorage.ts, unmodified by this pass), so
    // writing to an already-occupied key would otherwise fail. This
    // delete only ever runs after (a) explicit --confirm-restore and (b)
    // the archive bytes have already been proven correct against the
    // database's own recorded SHA-256, above.
    if (existingPrimary) {
      await primaryAdapter.delete(asset.storageKey);
    }
    await primaryAdapter.put(asset.storageKey, archiveBytes, asset.contentType);
  } catch (err) {
    return { status: "RESTORE_WRITE_FAILED", error: err instanceof Error ? err.message : String(err) };
  }

  let rereadPrimary: Buffer | null;
  try {
    rereadPrimary = await primaryAdapter.get(asset.storageKey);
  } catch {
    rereadPrimary = null;
  }
  if (!rereadPrimary) return { status: "RESTORE_VERIFY_FAILED" };
  const rereadSha256 = createHash("sha256").update(rereadPrimary).digest("hex");
  if (rereadSha256 !== asset.sha256 || rereadPrimary.byteLength !== asset.byteSize) {
    return { status: "RESTORE_VERIFY_FAILED" };
  }

  createPlatformAuditLog({
    actorId: null,
    action: ARCHIVE_RESTORED_AUDIT_ACTION,
    targetType: "IntegrityEvidenceAsset",
    targetId: asset.id,
    institutionId: asset.institutionId,
    metadata: { kind: asset.kind, byteSize: asset.byteSize },
  }).catch(() => {});

  return { status: "RESTORED_VERIFIED" };
}
