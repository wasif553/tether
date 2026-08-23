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

/** The one PlatformAuditLog action name for this runner's deletions — see createPlatformAuditLog's callers elsewhere for the established SCREAMING_SNAKE_CASE, past-tense convention. */
const RETENTION_DELETED_AUDIT_ACTION = "INTEGRITY_EVIDENCE_RETENTION_DELETED";

/**
 * Conservative pilot-fallback default — see
 * docs/privacy-and-evidence-retention-v1.md, Section 18 (Class A target:
 * institution review/appeal period + 30 days; 180 days after final
 * submission is the proposed operational fallback where no
 * institution-specific period has been agreed). This is only the
 * fallback used when EVIDENCE_RETENTION_DAYS is unset/invalid — an
 * institution-specific period should be supplied explicitly wherever one
 * has been agreed, not left to this default.
 */
const DEFAULT_EVIDENCE_RETENTION_DAYS = 180;

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
  byteSize: number;
};

/**
 * Pure read — never deletes anything itself. `now` is always passed
 * explicitly (never `new Date()` read internally) so this is
 * deterministically testable. `institutionId`, when provided, scopes the
 * query to that institution only. The CLI script
 * (scripts/run-evidence-retention.ts) supports it for dry runs and
 * *requires* it for `--execute` (see scripts/evidenceRetention/cliArgs.ts)
 * — this function itself still accepts an unscoped (deployment-wide)
 * query for dry-run/preview use and for any future non-CLI caller; the
 * CLI-level requirement is a caller-side safety rail, not a change to
 * this function's own contract.
 */
export async function findEligibleEvidenceAssetsForDeletion(retentionDays: number, now: Date, institutionId?: string): Promise<EligibleEvidenceAsset[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return prisma.integrityEvidenceAsset.findMany({
    where: { capturedAt: { lt: cutoff }, ...(institutionId ? { institutionId } : {}) },
    select: { id: true, storageProvider: true, storageKey: true, capturedAt: true, submissionId: true, examId: true, institutionId: true, kind: true, byteSize: true },
    orderBy: { capturedAt: "asc" },
  });
}

export type DeleteEvidenceAssetOutcome = { id: string; ok: true } | { id: string; ok: false; error: string };

/**
 * Deletes ONE evidence asset: storage object first, then the database
 * row + its deletion audit record together (see this module's own doc
 * comment for why storage-then-DB is the safer ordering). Never throws —
 * every failure is represented in the returned outcome, so a sweep over
 * many assets can continue past a single failure rather than aborting the
 * whole run.
 *
 * The DB-row delete and the PlatformAuditLog write run inside ONE Prisma
 * transaction: a high-consequence evidence deletion must never
 * successfully disappear from the database without its audit record, so
 * if the audit write fails the row delete rolls back too — the row
 * remains, and the (already storage-deleted) object stays eligible for a
 * retry, which is safe because both storage adapters treat delete-of-
 * missing-key as success (see the module doc comment).
 *
 * `actorId: null` — this CLI has no cryptographically-authenticated human
 * operator session to attribute the action to; claiming a specific
 * identity here would be false. Audit metadata is deliberately minimal
 * and non-identifying: no storageKey, submissionId, studentId, or any
 * other student-linkable field — see Section 5 of the safety-audit pass
 * this was built in.
 */
export async function deleteEvidenceAsset(
  asset: EligibleEvidenceAsset,
  context: { retentionDays: number; cutoff: Date },
): Promise<DeleteEvidenceAssetOutcome> {
  try {
    const adapter = resolveEvidenceStorageAdapter();
    await adapter.delete(asset.storageKey);
  } catch (err) {
    return { id: asset.id, ok: false, error: `storage delete failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.integrityEvidenceAsset.delete({ where: { id: asset.id } });
      await tx.platformAuditLog.create({
        data: {
          actorId: null,
          action: RETENTION_DELETED_AUDIT_ACTION,
          targetType: "IntegrityEvidenceAsset",
          targetId: asset.id,
          institutionId: asset.institutionId,
          metadata: {
            kind: asset.kind,
            capturedAt: asset.capturedAt.toISOString(),
            trigger: "manual_retention",
            retentionDays: context.retentionDays,
            cutoff: context.cutoff.toISOString(),
          },
        },
      });
    });
  } catch (err) {
    // The underlying storage object is already gone at this point, but the
    // transaction above rolled back — the DB row (and thus its audit
    // trail) either both exist or neither does, never a row deleted with
    // no audit record. The row remains eligible on the next sweep;
    // deleting an already-missing storage object is a no-op, not an error.
    return { id: asset.id, ok: false, error: `database delete + audit transaction failed after storage delete succeeded: ${err instanceof Error ? err.message : String(err)}` };
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
export async function runEvidenceRetentionSweep(options: { retentionDays?: number; now?: Date; dryRun: boolean; institutionId?: string }): Promise<EvidenceRetentionSweepReport> {
  const retentionDays = options.retentionDays ?? resolveEvidenceRetentionDays();
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const eligible = await findEligibleEvidenceAssetsForDeletion(retentionDays, now, options.institutionId);

  const outcomes: DeleteEvidenceAssetOutcome[] = [];
  if (!options.dryRun) {
    for (const asset of eligible) {
      outcomes.push(await deleteEvidenceAsset(asset, { retentionDays, cutoff }));
    }
  }

  return {
    retentionDays,
    cutoff,
    evaluatedCount: eligible.length,
    eligible,
    outcomes,
    dryRun: options.dryRun,
  };
}
