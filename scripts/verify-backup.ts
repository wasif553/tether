#!/usr/bin/env -S npx tsx
/**
 * `npm run backup:verify -- <path-to-dump-file> [--restore]` — see
 * docs/production-backup-restore-runbook.md.
 *
 * File-level checks (existence, plausible size, checksum, format
 * detection) always run. The disposable-restore rehearsal only runs when
 * `--restore` is passed AND every file-level check passed — never restores
 * a file that already failed the cheaper checks, and never restores into
 * anything but a throwaway local Docker Postgres container (see
 * restoreRehearsal.ts's own doc comment for the structural guarantee that
 * this can never reach Production).
 *
 * This tool never connects to, reads from, or has any knowledge of how
 * the dump file was PRODUCED — it verifies a dump file that already
 * exists on disk. Producing the actual production backup remains a
 * separate, existing operational step (see the runbook).
 */
import path from "node:path";
import { verifyBackupFile } from "./backupVerification/backupFileChecks";
import { runRestoreRehearsal } from "./backupVerification/restoreRehearsal";

function log(message: string): void {
  console.log(`[backup:verify] ${message}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const restoreRequested = args.includes("--restore");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    log("Usage: npm run backup:verify -- <path-to-dump-file> [--restore]");
    process.exitCode = 1;
    return;
  }

  const resolvedPath = path.resolve(filePath);
  log(`Verifying backup file: ${resolvedPath}`);

  const fileResult = await verifyBackupFile(resolvedPath);

  log(`  exists: ${fileResult.exists}`);
  log(`  size: ${fileResult.sizeBytes ?? "n/a"} bytes (plausible: ${fileResult.plausibleSize})`);
  log(`  dump format: ${fileResult.dumpFormat ?? "n/a"}`);
  log(`  SHA-256: ${fileResult.sha256 ?? "n/a"}`);

  if (!fileResult.passed) {
    log("File-level verification FAILED — refusing to proceed to a restore rehearsal, even if --restore was passed.");
    printResult({ fileResult, restoreResult: null, overallPassed: false });
    process.exitCode = 1;
    return;
  }
  log("File-level verification PASSED.");

  if (!restoreRequested) {
    log("--restore not passed — skipping the disposable-restore rehearsal (file-level checks only).");
    printResult({ fileResult, restoreResult: null, overallPassed: true });
    process.exitCode = 0;
    return;
  }

  log("Running disposable-restore rehearsal (this starts a throwaway local Docker Postgres container)...");
  const restoreResult = await runRestoreRehearsal(resolvedPath, fileResult.dumpFormat!);
  log(`  restore succeeded: ${restoreResult.restoreSucceeded}`);
  if (restoreResult.restoreErrorDetail) log(`  restore error: ${restoreResult.restoreErrorDetail}`);
  for (const check of restoreResult.sanityChecks) {
    log(`  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }

  const overallPassed = fileResult.passed && restoreResult.passed;
  printResult({ fileResult, restoreResult, overallPassed });
  process.exitCode = overallPassed ? 0 : 1;
}

function printResult(summary: { fileResult: unknown; restoreResult: unknown; overallPassed: boolean }): void {
  log("── Verification record ──────────────────────────");
  log(JSON.stringify(summary, null, 2));
  log(summary.overallPassed ? "backup:verify PASSED" : "backup:verify FAILED");
  log("──────────────────────────────────────────────────");
}

main().catch((err) => {
  log(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
