#!/usr/bin/env -S npx tsx
/**
 * `npm run evidence:archive -- [--execute] [--confirm-production-archive]`
 *   or
 * `npm run evidence:archive -- --restore-asset <evidenceAssetId> [--confirm-restore] [--confirm-production-restore]`
 *
 * Manual, operator-triggered evidence archive/restore tool. See
 * docs/tether-evidence-archive-plan.md and the doc comments on
 * src/lib/evidenceArchive.ts.
 *
 * ARCHIVE MODE (default): dry-run unless --execute is passed. Whenever
 * the ACTUAL configured primary Supabase project matches the configured
 * ARCHIVE_EXPECTED_PRIMARY_PROJECT_REF (i.e. this genuinely IS the
 * Production primary — determined solely from real environment
 * configuration, never from any argument this script passes), --execute
 * additionally requires --confirm-production-archive AND a genuinely
 * separate archive Supabase project — enforced in code
 * (assertProductionArchiveSafe), not merely by this script's own
 * argument parsing, so a caller cannot bypass it by invoking the library
 * function directly. Exactly like scripts/run-evidence-retention.ts,
 * this script adds no additional safety rail beyond that and does not
 * attempt to detect a Production DATABASE_URL — running it against
 * Production is always a deliberate operator action against whatever
 * environment is currently configured.
 *
 * RESTORE MODE (--restore-asset): restores exactly one evidence asset's
 * bytes from the archive back to primary storage. Never automatic, never
 * bulk, never overwrites a healthy primary object, never deletes the
 * archive copy. Uses the SAME production guard as archive execute — a
 * restore against the configured Production primary project additionally
 * requires --confirm-production-restore, on top of the ordinary
 * --confirm-restore already required for any restore. See
 * restoreEvidenceAsset's own doc comment for the supported scenarios.
 */
import { runEvidenceArchiveSweep, restoreEvidenceAsset, ProductionArchiveGuardError } from "../src/lib/evidenceArchive";

function log(message: string): void {
  console.log(`[evidence:archive] ${message}`);
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function runRestore(evidenceAssetId: string, args: string[]): Promise<void> {
  const confirmRestore = args.includes("--confirm-restore");
  const confirmProductionRestore = args.includes("--confirm-production-restore");
  log(`Restore requested for asset ${evidenceAssetId}. Confirmation: ${confirmRestore ? "provided" : "NOT provided"}.`);
  const outcome = await restoreEvidenceAsset(evidenceAssetId, { confirmRestore, confirmProductionRestore });
  log(`Result: ${outcome.status}`);
  if (outcome.error) log(`  detail: ${outcome.error}`);
  if (outcome.status === "RESTORE_CONFIRMATION_REQUIRED") {
    log("Re-run with --confirm-restore to actually write the restored bytes to primary storage.");
  }
  if (outcome.status === "RESTORE_PRODUCTION_GUARD_FAILED") {
    log("This targets the configured Production primary project — re-run with --confirm-production-restore in addition to --confirm-restore.");
  }
  if (outcome.status === "RESTORED_VERIFIED_AUDIT_FAILED") {
    log("Bytes were restored and verified, but the audit record could not be written — operational reconciliation is required.");
  }
  process.exitCode = outcome.status === "RESTORED_VERIFIED" ? 0 : 1;
}

async function runArchive(args: string[]): Promise<void> {
  const execute = args.includes("--execute");
  const confirmProductionArchive = args.includes("--confirm-production-archive");
  const sourceEnvironment = process.env.ARCHIVE_SOURCE_ENVIRONMENT ?? "unspecified";

  // This is only the caller-declared label. For a genuine Production
  // execute run, the sweep itself overrides it — see the "Effective
  // source environment" line printed after the run.
  log(`Declared source label: ${sourceEnvironment}`);
  log(execute ? "Mode: EXECUTE — evidence will be archived." : "Mode: DRY RUN — nothing will be archived (pass --execute to actually archive).");

  let report;
  try {
    report = await runEvidenceArchiveSweep({ dryRun: !execute, sourceEnvironment, confirmProductionArchiveFlagPresent: confirmProductionArchive });
  } catch (err) {
    if (err instanceof ProductionArchiveGuardError) {
      log(`Refusing to execute: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  log(`Archive run id: ${report.archiveRunId}`);
  log(`Effective source environment: ${report.sourceEnvironment}`);
  log(`Evaluated ${report.candidateCount} evidence asset(s).`);
  for (const outcome of report.outcomes) {
    const auditSuffix = outcome.auditStatus ? `, audit: ${outcome.auditStatus}` : "";
    log(`  ${outcome.evidenceAssetId} (${outcome.kind}, captured ${outcome.capturedAt.toISOString()}, ${outcome.byteSize} bytes): ${outcome.status}${auditSuffix}`);
  }

  if (!execute) {
    log("Dry run complete. Re-run with --execute to actually archive these assets.");
    process.exitCode = 0;
    return;
  }

  log(`Manifest run status: ${report.runStatus ?? "unknown"}`);
  log(`Manifest verified: ${report.manifestVerified === true}`);
  log(`Overall run status: ${report.overallOk ? "OK" : "FAILED — one or more assets did not reach a fully archived-and-audited state"}`);
  process.exitCode = report.overallOk ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const restoreAssetId = parseFlagValue(args, "--restore-asset");

  if (restoreAssetId) {
    await runRestore(restoreAssetId, args);
    return;
  }

  await runArchive(args);
}

main().catch((err) => {
  log(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
