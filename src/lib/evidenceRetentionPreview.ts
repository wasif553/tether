/**
 * Production administration hardening v1, Part E — evidence retention
 * administration preview. See docs/tether-evidence-retention-plan.md.
 *
 * A read-only reporting layer on top of runEvidenceRetentionSweep
 * (src/lib/evidenceRetentionRunner.ts), ALWAYS in dry-run mode — this
 * module has no delete capability at all (it doesn't even import
 * deleteEvidenceAsset). Platform-admin-only surface (see
 * GET /api/platform/evidence-retention-preview) for understanding what a
 * retention sweep WOULD affect before anyone runs the actual CLI tool
 * with --execute.
 */
import { runEvidenceRetentionSweep, resolveEvidenceRetentionDays, type EligibleEvidenceAsset } from "@/lib/evidenceRetentionRunner";

export type EvidenceRetentionPreview = {
  retentionDays: number;
  cutoff: string;
  institutionId: string | null;
  affectedCount: number;
  totalBytes: number;
  oldestCapturedAt: string | null;
  newestCapturedAt: string | null;
  byKind: Record<string, number>;
  /** Always true — this preview NEVER deletes anything; included explicitly so a caller can never mistake this report for an execution result. */
  dryRun: true;
};

function summarizeEligible(eligible: EligibleEvidenceAsset[]): Pick<EvidenceRetentionPreview, "affectedCount" | "totalBytes" | "oldestCapturedAt" | "newestCapturedAt" | "byKind"> {
  if (eligible.length === 0) {
    return { affectedCount: 0, totalBytes: 0, oldestCapturedAt: null, newestCapturedAt: null, byKind: {} };
  }
  // `eligible` is already ordered oldest-first (see
  // findEligibleEvidenceAssetsForDeletion's own orderBy) — never
  // re-sorted here, just read the first/last.
  const totalBytes = eligible.reduce((sum, asset) => sum + asset.byteSize, 0);
  const byKind: Record<string, number> = {};
  for (const asset of eligible) byKind[asset.kind] = (byKind[asset.kind] ?? 0) + 1;
  return {
    affectedCount: eligible.length,
    totalBytes,
    oldestCapturedAt: eligible[0].capturedAt.toISOString(),
    newestCapturedAt: eligible[eligible.length - 1].capturedAt.toISOString(),
    byKind,
  };
}

export async function previewEvidenceRetention(options: { retentionDays?: number; now?: Date; institutionId?: string }): Promise<EvidenceRetentionPreview> {
  const retentionDays = options.retentionDays ?? resolveEvidenceRetentionDays();
  const now = options.now ?? new Date();
  const report = await runEvidenceRetentionSweep({ retentionDays, now, dryRun: true, institutionId: options.institutionId });

  return {
    retentionDays,
    cutoff: report.cutoff.toISOString(),
    institutionId: options.institutionId ?? null,
    ...summarizeEligible(report.eligible),
    dryRun: true,
  };
}
