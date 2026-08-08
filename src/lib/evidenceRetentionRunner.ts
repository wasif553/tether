/**
 * Evidence retention runner (pilot operations + distribution readiness
 * v1). See docs/tether-data-and-privacy-register.md and
 * docs/secure-exam-evidence-review-audit-v1.md (area 13), which
 * documents the prior state accurately: "no time-based retention window
 * is implemented anywhere — no delete route, no scheduler/cron,
 * EvidenceStorageAdapter.delete() is never called from application
 * code."
 *
 * This module provides that missing piece — but ONLY as a reusable,
 * directly-invocable function. **Nothing in this codebase calls this
 * automatically.** No route, no cron, no build step, no server startup
 * hook invokes `runEvidenceRetentionSweep`. It is exposed for manual/
 * operator-triggered use via `scripts/run-evidence-retention.ts` (dry-run
 * by default, requires an explicit `--execute` flag to actually delete
 * anything), and is left unwired into any automatic trigger deliberately
 * — activating scheduled deletion in Production is an institutional
 * policy decision (what retention period is actually appropriate/
 * required) that this pass does not make on the institution's behalf.
 *
 * Age-based on `IntegrityEvidenceAsset.capturedAt` — there is no
 * `expiresAt`/`retainUntil` column on the schema (confirmed by direct
 * audit; see the privacy register), so this deliberately does NOT
 * require a schema change: eligibility is computed at sweep time from
 * the existing `capturedAt` timestamp and a configurable retention
 * window, not from a stored expiry.
 *
 * Deletion order is storage-first, then the database row: if the storage
 * delete fails, the row survives and remains eligible on the next sweep
 * (retryable, and the object was never deleted so nothing was lost). If
 * the storage delete succeeds but the subsequent DB delete fails, the row
 * becomes an orphan pointing at an already-deleted object — a retry finds
 * it still eligible, and its storage delete call is a no-op against an
 * already-missing key (both adapters treat delete-of-missing-key as
 * success, not an error — see evidenceStorage.ts). The reverse ordering
 * (DB row deleted first) was deliberately rejected: a storage-delete
 * failure after that would leave a sensitive image file with no
 * remaining database reference to it anywhere in the application —
 * unreachable, undiscoverable, and never retried.
 */
import { prisma } from "@/lib/prisma";
import { resolveEvidenceStorageAdapter } from "@/lib/evidenceStorage";

const DEFAULT_EVIDENCE_RETENTION_DAYS = 90;

/** Missing/malformed/non-positive values fall back to the safe default — mirrors the established env-var + typed-resolver convention (see systemCheckConfig.ts). */
export function resolveEvidenceRetentionDays(): number {
  const raw = process.env.EVIDENCE_RETENTION_DAYS;
  const parsed = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EVIDENCE_RETENTION_DAYS;
  return parsed;
}

export type EligibleEvidenceAsset = {
  id: string;
  storageProvider: string;
  storageKey: string;
  capturedAt: Date;
  submissionId: string;
  examId: string;
  institutionId: string;
  kind: string;
};

/** Pure read — never deletes anything itself. `now` is always passed explicitly (never `new Date()` read internally) so this is deterministically testable. */
export async function findEligibleEvidenceAssetsForDeletion(retentionDays: number, now: Date): Promise<EligibleEvidenceAsset[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return prisma.integrityEvidenceAsset.findMany({
    where: { capturedAt: { lt: cutoff } },
    select: { id: true, storageProvider: true, storageKey: true, capturedAt: true, submissionId: true, examId: true, institutionId: true, kind: true },
    orderBy: { capturedAt: "asc" },
  });
}

export type DeleteEvidenceAssetOutcome = { id: string; ok: true } | { id: string; ok: false; error: string };

/**
 * Deletes ONE evidence asset: storage object first, then the database
 * row (see this module's own doc comment for why this ordering). Never
 * throws — every failure is represented in the returned outcome, so a
 * sweep over many assets can continue past a single failure rather than
 * aborting the whole run.
 */
export async function deleteEvidenceAsset(asset: Pick<EligibleEvidenceAsset, "id" | "storageKey">): Promise<DeleteEvidenceAssetOutcome> {
  try {
    const adapter = resolveEvidenceStorageAdapter();
    await adapter.delete(asset.storageKey);
  } catch (err) {
    return { id: asset.id, ok: false, error: `storage delete failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await prisma.integrityEvidenceAsset.delete({ where: { id: asset.id } });
  } catch (err) {
    // The underlying storage object is already gone at this point — the
    // row is now an orphan (see doc comment above for why this is the
    // safer failure mode than the reverse ordering).
    return { id: asset.id, ok: false, error: `database delete failed after storage delete succeeded: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { id: asset.id, ok: true };
}

export type EvidenceRetentionSweepReport = {
  retentionDays: number;
  cutoff: Date;
  evaluatedCount: number;
  eligible: EligibleEvidenceAsset[];
  /** Empty in dry-run mode — nothing is deleted, so nothing to report deleting. */
  outcomes: DeleteEvidenceAssetOutcome[];
  dryRun: boolean;
};

/**
 * The one entry point a caller (the CLI script, or a future operator
 * tool) should use. `dryRun: true` (the default) only evaluates and
 * reports what WOULD be deleted — never calls deleteEvidenceAsset. Only
 * `dryRun: false` actually deletes anything, and even then only what
 * `findEligibleEvidenceAssetsForDeletion` returned at the start of this
 * call (never re-queries mid-sweep, so a sweep's behavior is a
 * consistent snapshot).
 */
export async function runEvidenceRetentionSweep(options: { retentionDays?: number; now?: Date; dryRun: boolean }): Promise<EvidenceRetentionSweepReport> {
  const retentionDays = options.retentionDays ?? resolveEvidenceRetentionDays();
  const now = options.now ?? new Date();
  const eligible = await findEligibleEvidenceAssetsForDeletion(retentionDays, now);

  const outcomes: DeleteEvidenceAssetOutcome[] = [];
  if (!options.dryRun) {
    for (const asset of eligible) {
      outcomes.push(await deleteEvidenceAsset(asset));
    }
  }

  return {
    retentionDays,
    cutoff: new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000),
    evaluatedCount: eligible.length,
    eligible,
    outcomes,
    dryRun: options.dryRun,
  };
}
