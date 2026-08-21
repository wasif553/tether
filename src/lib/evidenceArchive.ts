/**
 * Evidence Backup/Recovery v1 — archive/restore orchestrator. See
 * docs/tether-evidence-archive-plan.md.
 *
 * Manual, operator-triggered only — exposed via `scripts/run-evidence-archive.ts`
 * (`npm run evidence:archive`). Nothing in this codebase calls this
 * automatically: no cron, no route, no build step, no server startup
 * hook. Mirrors the established conventions of
 * src/lib/evidenceRetentionRunner.ts (dry-run by default, never throws
 * for a single-asset failure) but is otherwise fully independent of it —
 * this module never deletes a primary evidence object or database row.
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
// manifest hash" and "Partial-run coverage metadata".
// ---------------------------------------------------------------------------

export type ArchiveManifestRunStatus = "COMPLETE" | "PARTIAL_FAILURE";

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
  /** Total candidates evaluated by this run — including ones that failed source verification and were never archived. */
  candidateCount: number;
  /** Candidates that reached ARCHIVED_VERIFIED or ALREADY_ARCHIVED_VERIFIED — equals assets.length. */
  verifiedAssetCount: number;
  /** candidateCount - verifiedAssetCount. */
  failureCount: number;
  /**
   * "COMPLETE" only when EVERY candidate reached a verified archive
   * state; "PARTIAL_FAILURE" otherwise. The manifest still only ever
   * contains entries for successfully verified assets (see `assets`) —
   * this field is what makes an incomplete run unambiguous even though
   * the manifest document itself still verifies cryptographically. A
   * partial manifest must never be mistaken for a complete one merely
   * because its own SHA-256 checks out.
   */
  runStatus: ArchiveManifestRunStatus;
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
 * directly covered by tests. EVERY payload field, including the coverage
 * metadata (candidateCount/verifiedAssetCount/failureCount/runStatus),
 * participates in the digest — tampering with any of them (e.g. relabeling
 * a PARTIAL_FAILURE run as COMPLETE) breaks verification.
 */
function canonicalManifestPayloadJson(payload: ArchiveManifestPayload): string {
  const canonical = {
    manifestVersion: payload.manifestVersion,
    archiveRunId: payload.archiveRunId,
    createdAt: payload.createdAt,
    sourceEnvironment: payload.sourceEnvironment,
    sourceProvider: payload.sourceProvider,
    candidateCount: payload.candidateCount,
    verifiedAssetCount: payload.verifiedAssetCount,
    failureCount: payload.failureCount,
    runStatus: payload.runStatus,
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
// Machine-enforced production/project-separation guard — shared by BOTH
// archive execute and restore, so the two can never drift out of sync.
// See docs/tether-evidence-archive-plan.md, "Security corrections v1".
// ---------------------------------------------------------------------------

export type ArchiveOperationGuardEnv = EvidenceArchiveStorageEnv & {
  ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF?: string;
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
};

export type ArchiveOperationGuardResult =
  | { ok: true; isProductionOperation: boolean; primaryProjectRef: string | null; archiveProjectRef: string | null }
  | { ok: false; reason: string; primaryProjectRef: string | null; archiveProjectRef: string | null };

/**
 * The one place "is this a real, production-configured Supabase archive
 * operation" is decided. Deliberately takes NO caller-supplied
 * environment label as input — "is this Production" is derived SOLELY
 * from actual, operator-configured environment (SUPABASE_URL vs
 * ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF), never from a function argument
 * like `sourceEnvironment`. A caller cannot downgrade the safety
 * decision by passing (or omitting) a "test" label — see the security
 * corrections in docs/tether-evidence-archive-plan.md for why this
 * replaced the earlier, caller-influenceable design.
 *
 * Universal invariant (checked regardless of provider/production status):
 * the archive project must never resolve to the same Supabase project as
 * the primary.
 *
 * For any REAL (supabase_storage) archive destination, ALL of the
 * following must additionally hold or the operation fails closed:
 *   - the primary project ref must be resolvable
 *   - the archive project ref must be resolvable
 *   - ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF must be configured
 *   - the primary project ref must equal ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF
 * When all of the above hold, `isProductionOperation` is true — this
 * pilot's architecture has exactly one legitimate real-Supabase
 * deployment target, so "using real Supabase storage that matches the
 * configured expected project" IS the definition of a production-grade
 * operation, and every such operation requires its caller's own
 * production-specific confirmation flag on top of this guard (see
 * assertProductionArchiveSafe / restore's own guard usage below).
 *
 * `local_dev` archive operations are exempt from all of the above —
 * dev/test only, no production concept applies, no confirmation flag
 * required.
 */
export function assertSupabaseArchiveOperationSafe(env: ArchiveOperationGuardEnv = process.env): ArchiveOperationGuardResult {
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

  const isRealArchiveDestination = env.ARCHIVE_STORAGE_PROVIDER === "supabase_storage";
  if (!isRealArchiveDestination) {
    return { ok: true, isProductionOperation: false, primaryProjectRef, archiveProjectRef };
  }

  if (!primaryProjectRef) {
    return { ok: false, reason: "Primary Supabase project ref could not be resolved.", primaryProjectRef, archiveProjectRef };
  }
  if (!archiveProjectRef) {
    return { ok: false, reason: "Archive Supabase project ref could not be resolved.", primaryProjectRef, archiveProjectRef };
  }
  const expectedPrimaryProjectRef = env.ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF;
  if (!expectedPrimaryProjectRef) {
    return {
      ok: false,
      reason: "ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF is not configured — required for any real Supabase archive/restore operation.",
      primaryProjectRef,
      archiveProjectRef,
    };
  }
  if (primaryProjectRef !== expectedPrimaryProjectRef) {
    return {
      ok: false,
      reason: "Primary Supabase project ref does not match the configured ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF.",
      primaryProjectRef,
      archiveProjectRef,
    };
  }

  return { ok: true, isProductionOperation: true, primaryProjectRef, archiveProjectRef };
}

export class ProductionArchiveGuardError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProductionArchiveGuardError";
  }
}

/** Archive-execute-specific wrapper around the shared guard: additionally requires --confirm-production-archive whenever isProductionOperation is true. */
export function assertProductionArchiveSafe(
  confirmProductionArchiveFlagPresent: boolean,
  env: ArchiveOperationGuardEnv = process.env,
): ArchiveOperationGuardResult {
  const base = assertSupabaseArchiveOperationSafe(env);
  if (!base.ok) return base;
  if (base.isProductionOperation && !confirmProductionArchiveFlagPresent) {
    return {
      ok: false,
      reason: "This operation targets the configured Production primary project — archive execution requires --confirm-production-archive.",
      primaryProjectRef: base.primaryProjectRef,
      archiveProjectRef: base.archiveProjectRef,
    };
  }
  return base;
}

/** Restore-specific wrapper around the shared guard: additionally requires --confirm-production-restore whenever isProductionOperation is true (in addition to the caller's own --confirm-restore, checked separately in restoreEvidenceAsset). */
export function assertRestoreOperationSafe(
  confirmProductionRestoreFlagPresent: boolean,
  env: ArchiveOperationGuardEnv = process.env,
): ArchiveOperationGuardResult {
  const base = assertSupabaseArchiveOperationSafe(env);
  if (!base.ok) return base;
  if (base.isProductionOperation && !confirmProductionRestoreFlagPresent) {
    return {
      ok: false,
      reason: "This operation targets the configured Production primary project — restore requires --confirm-production-restore (in addition to --confirm-restore).",
      primaryProjectRef: base.primaryProjectRef,
      archiveProjectRef: base.archiveProjectRef,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Archive audit — awaited, existence-checked, self-repairing. See
// docs/tether-evidence-archive-plan.md, "Audit persistence corrections".
// ---------------------------------------------------------------------------

export type ArchiveAuditStatus = "AUDITED" | "ALREADY_AUDITED" | "AUDIT_FAILED";

/**
 * AWAITED (never fire-and-forget) and existence-checked BEFORE writing —
 * this is what makes it safe to call for both ARCHIVED_VERIFIED (a truly
 * new archive) and ALREADY_ARCHIVED_VERIFIED (a rerun against a
 * previously-archived asset): a rerun that finds an existing audit row
 * reports ALREADY_AUDITED and writes nothing further, while a rerun that
 * finds the object already archived but its audit row MISSING (e.g. the
 * archive succeeded on an earlier run whose audit write itself failed)
 * self-repairs by creating the missing row. Never deletes or modifies
 * the already-archived object regardless of audit outcome.
 */
async function ensureArchiveAudit(
  candidate: EvidenceArchiveCandidate,
  archiveProvider: string,
  archiveRunId: string,
  verificationStatus: string,
): Promise<ArchiveAuditStatus> {
  const existing = await prisma.platformAuditLog.findFirst({
    where: { action: ARCHIVE_VERIFIED_AUDIT_ACTION, targetId: candidate.id },
    select: { id: true },
  });
  if (existing) return "ALREADY_AUDITED";

  try {
    await createPlatformAuditLog({
      actorId: null,
      action: ARCHIVE_VERIFIED_AUDIT_ACTION,
      targetType: "IntegrityEvidenceAsset",
      targetId: candidate.id,
      institutionId: candidate.institutionId,
      metadata: { kind: candidate.kind, byteSize: candidate.byteSize, archiveProvider, archiveRunId, verificationStatus },
    });
    return "AUDITED";
  } catch {
    return "AUDIT_FAILED";
  }
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
  /** Only set for ARCHIVED_VERIFIED/ALREADY_ARCHIVED_VERIFIED outcomes in execute mode — see ensureArchiveAudit. */
  auditStatus?: ArchiveAuditStatus;
};

export type ArchiveSweepReport = {
  archiveRunId: string;
  createdAt: Date;
  sourceEnvironment: string;
  dryRun: boolean;
  candidateCount: number;
  outcomes: ArchiveAssetOutcome[];
  /**
   * true only if EVERY candidate reached ARCHIVED_VERIFIED/ALREADY_ARCHIVED_VERIFIED
   * AND its audit is AUDITED/ALREADY_AUDITED AND the manifest itself
   * verified (execute mode) — or every candidate passed source
   * verification (dry-run mode, informational only). A failed archive
   * audit makes the overall run report failure even though the archive
   * object itself was written and verified correctly — see
   * ensureArchiveAudit's own doc comment for why the object is never
   * rolled back merely because its audit failed.
   */
  overallOk: boolean;
  /** null in dry-run (no manifest is ever written); true/false in execute mode. */
  manifestVerified: boolean | null;
  /** Mirrors the manifest's own runStatus — null in dry-run. */
  runStatus: ArchiveManifestRunStatus | null;
};

/**
 * The one entry point a caller (the CLI, or a future operator tool)
 * should use. `dryRun: true` (the default) only downloads and
 * source-verifies each candidate — it NEVER touches the archive
 * destination, writes a manifest, writes an audit row, or modifies the
 * database or primary storage in any way (see the "dry-run performs no
 * writes" tests). Only `dryRun: false` calls assertProductionArchiveSafe
 * and, if it passes, actually archives anything.
 *
 * `sourceEnvironment` is recorded as manifest/report metadata, but it is
 * NOT trusted as-is: it has no effect on the production guard (see
 * assertSupabaseArchiveOperationSafe's own doc comment) — a caller
 * cannot weaken the guard by passing sourceEnvironment="test" (or
 * omitting it) against a primary project that actually matches
 * ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF. And, in execute mode, the
 * caller-supplied label cannot even be RECORDED as anything other than
 * "production" once the guard's own machine-derived
 * `isProductionOperation` is true — the permanent manifest's provenance
 * must never be able to say "test"/"unspecified" for a run that the
 * guard itself determined targets the configured Production primary
 * project. Only when `isProductionOperation` is false (local_dev/non-
 * production) does the caller's own label pass through unchanged, purely
 * as informational metadata.
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
  let effectiveSourceEnvironment = options.sourceEnvironment ?? "unspecified";

  let archiveAdapter: EvidenceArchiveStorageAdapter | null = null;
  if (!options.dryRun) {
    const guard = assertProductionArchiveSafe(options.confirmProductionArchiveFlagPresent ?? false);
    if (!guard.ok) throw new ProductionArchiveGuardError(guard.reason);
    // Machine-derived provenance overrides any caller-supplied label —
    // see this function's own doc comment above.
    if (guard.isProductionOperation) effectiveSourceEnvironment = "production";
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
    const outcome: ArchiveAssetOutcome = { ...base, status: writeOutcome.status, error: writeOutcome.error };
    outcomes.push(outcome);

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
      // Awaited — never fire-and-forget (see ensureArchiveAudit). Runs for
      // BOTH new and already-archived outcomes so a prior run's failed
      // audit write self-repairs on this rerun.
      outcome.auditStatus = await ensureArchiveAudit(candidate, archiveAdapter!.provider, archiveRunId, writeOutcome.status);
    }
  }

  let manifestVerified: boolean | null = null;
  let runStatus: ArchiveManifestRunStatus | null = null;
  if (!options.dryRun) {
    const verifiedAssetCount = manifestAssets.length;
    const failureCount = candidates.length - verifiedAssetCount;
    runStatus = failureCount === 0 ? "COMPLETE" : "PARTIAL_FAILURE";

    const payload: ArchiveManifestPayload = {
      manifestVersion: 1,
      archiveRunId,
      createdAt: now.toISOString(),
      sourceEnvironment: effectiveSourceEnvironment,
      sourceProvider: archiveAdapter!.provider,
      candidateCount: candidates.length,
      verifiedAssetCount,
      failureCount,
      runStatus,
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
  }

  const overallOk = options.dryRun
    ? outcomes.every((o) => o.status === "SOURCE_VERIFIED")
    : outcomes.every(
        (o) =>
          (o.status === "ARCHIVED_VERIFIED" || o.status === "ALREADY_ARCHIVED_VERIFIED") &&
          (o.auditStatus === "AUDITED" || o.auditStatus === "ALREADY_AUDITED"),
      ) && manifestVerified === true;

  return {
    archiveRunId,
    createdAt: now,
    sourceEnvironment: effectiveSourceEnvironment,
    dryRun: options.dryRun,
    candidateCount: candidates.length,
    outcomes,
    overallOk,
    manifestVerified,
    runStatus,
  };
}

// ---------------------------------------------------------------------------
// Restore — minimum pilot capability only. See docs/tether-evidence-archive-plan.md,
// "DB_METADATA_RECONSTRUCTION: MANUAL_RECOVERY_PROCEDURE / NOT AUTOMATED" —
// this NEVER recreates an IntegrityEvidenceAsset/IntegrityEvent/Submission/
// Exam row; it only ever writes bytes back to the PRIMARY storage adapter
// for an asset whose database row already exists.
// ---------------------------------------------------------------------------

export type RestoreStatus =
  | "RESTORE_PRODUCTION_GUARD_FAILED"
  | "RESTORE_NOT_FOUND"
  | "RESTORE_ARCHIVE_MISSING"
  | "RESTORE_DB_DIGEST_MISSING"
  | "RESTORE_ARCHIVE_HASH_MISMATCH"
  | "RESTORE_PRIMARY_HEALTHY_REFUSED"
  | "RESTORE_CONFIRMATION_REQUIRED"
  | "RESTORE_WRITE_FAILED"
  | "RESTORE_VERIFY_FAILED"
  | "RESTORED_VERIFIED"
  | "RESTORED_VERIFIED_AUDIT_FAILED";
export type RestoreOutcome = { status: RestoreStatus; error?: string };

// Fixed, bounded messages only — the underlying primary adapter's own
// error messages (e.g. Supabase's "upload failed for \"<key>\": ...", or
// local_dev's "Unsafe evidence storage key: \"<key>\"") can embed the raw
// storageKey and/or a raw provider message. Restore never forwards
// err.message from a primary-adapter call, regardless of provider —
// sanitized here at the restore boundary rather than by touching the
// already-frozen evidenceStorage.ts.
const RESTORE_WRITE_FAILED_MESSAGE = "Primary evidence restore write failed.";
const RESTORE_VERIFY_FAILED_MESSAGE = "Primary evidence restore verification failed.";

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
 *
 * Uses the SAME shared project-separation guard as archive execute
 * (assertRestoreOperationSafe / assertSupabaseArchiveOperationSafe) — a
 * restore against the configured Production primary project additionally
 * requires `confirmProductionRestore`, on top of the ordinary
 * `confirmRestore` flag already required for any restore (missing or
 * corrupt primary alike).
 */
export async function restoreEvidenceAsset(
  evidenceAssetId: string,
  options: { confirmRestore: boolean; confirmProductionRestore?: boolean },
): Promise<RestoreOutcome> {
  const guard = assertRestoreOperationSafe(options.confirmProductionRestore ?? false);
  if (!guard.ok) return { status: "RESTORE_PRODUCTION_GUARD_FAILED", error: guard.reason };

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
  } catch {
    return { status: "RESTORE_WRITE_FAILED", error: RESTORE_WRITE_FAILED_MESSAGE };
  }

  let rereadPrimary: Buffer | null;
  try {
    rereadPrimary = await primaryAdapter.get(asset.storageKey);
  } catch {
    rereadPrimary = null;
  }
  if (!rereadPrimary) return { status: "RESTORE_VERIFY_FAILED", error: RESTORE_VERIFY_FAILED_MESSAGE };
  const rereadSha256 = createHash("sha256").update(rereadPrimary).digest("hex");
  if (rereadSha256 !== asset.sha256 || rereadPrimary.byteLength !== asset.byteSize) {
    return { status: "RESTORE_VERIFY_FAILED", error: RESTORE_VERIFY_FAILED_MESSAGE };
  }

  // AWAITED — never fire-and-forget. Bytes are already restored and
  // verified at this point; an audit-write failure is reported distinctly
  // (RESTORED_VERIFIED_AUDIT_FAILED) rather than silently swallowed, but
  // never rolls back or removes the now-healthy primary object.
  try {
    await createPlatformAuditLog({
      actorId: null,
      action: ARCHIVE_RESTORED_AUDIT_ACTION,
      targetType: "IntegrityEvidenceAsset",
      targetId: asset.id,
      institutionId: asset.institutionId,
      metadata: { kind: asset.kind, byteSize: asset.byteSize },
    });
    return { status: "RESTORED_VERIFIED" };
  } catch {
    return { status: "RESTORED_VERIFIED_AUDIT_FAILED" };
  }
}
