#!/usr/bin/env -S npx tsx
/**
 * `npm run backup:verify-bundle -- <bundle-dir> [--restore] [--report <path>]`
 *
 * Bundle-aware counterpart to `npm run backup:verify` (which verifies a
 * single dump file — see docs/production-backup-restore-runbook.md).
 * This verifies a backup BUNDLE directory produced by
 * `npm run backup:create` (`roles.sql`, `schema.sql`, `data.sql`,
 * `manifest.json`):
 *
 * 1. Reads and parses the manifest — refuses to proceed if it's missing,
 *    malformed, or the bundle's own status is not COMPLETE (an
 *    IN_PROGRESS or FAILED bundle is never treated as verifiable).
 * 2. For each file the manifest declares, recomputes its SHA-256 and
 *    byte size and compares against the manifest's recorded values —
 *    detects both a missing file and a tampered/corrupted one.
 * 3. With `--restore`, additionally rehearses restoring the bundle
 *    (roles → schema → data, in that order) into a throwaway local
 *    Docker Postgres container — reusing the exact same disposable-
 *    container/sanity-check infrastructure the single-file verifier
 *    uses (scripts/backupCreation/bundleRestoreRehearsal.ts), never a
 *    parallel implementation.
 *
 * This tool never restores into Production, under any circumstance —
 * see bundleRestoreRehearsal.ts's own doc comment for the structural
 * guarantee.
 */
import path from "node:path";
import { readBundleManifest, isCompleteBundle } from "./backupCreation/backupBundleManifest";
import { runBundleRestoreRehearsal } from "./backupCreation/bundleRestoreRehearsal";
import { redactConnectionStrings } from "./backupCreation/connectionRedaction";
import { checkBundleFile, type BundleFileCheckResult } from "./backupCreation/bundleFileVerification";
import { writeBundleVerificationReport, type BundleVerificationReport, BUNDLE_VERIFICATION_REPORT_SCHEMA_VERSION } from "./backupCreation/bundleVerificationReport";

function log(message: string): void {
  console.log(`[backup:verify-bundle] ${redactConnectionStrings(message)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const restoreRequested = args.includes("--restore");
  const reportFlagIndex = args.indexOf("--report");
  const reportPath = reportFlagIndex >= 0 ? args[reportFlagIndex + 1] : null;
  const bundleDirArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--report");

  if (!bundleDirArg) {
    log("Usage: npm run backup:verify-bundle -- <bundle-dir> [--restore] [--report <path>]");
    process.exitCode = 1;
    return;
  }

  const bundleDir = path.resolve(bundleDirArg);
  log(`Verifying backup bundle: ${bundleDir}`);

  const manifestResult = await readBundleManifest(bundleDir);
  if (!manifestResult.ok) {
    log(`Manifest could not be read: ${manifestResult.reason}`);
    const report: BundleVerificationReport = {
      schemaVersion: BUNDLE_VERIFICATION_REPORT_SCHEMA_VERSION,
      bundleDir,
      verificationTimestamp: new Date().toISOString(),
      manifestFound: false,
      manifestStatus: null,
      fileChecks: [],
      disposableRestoreResult: { attempted: false, restoreSucceeded: null, sanityChecksPassed: null, sanityChecks: [], errorDetail: null },
      overallPassed: false,
    };
    if (reportPath) await writeBundleVerificationReport(report, reportPath);
    process.exitCode = 1;
    return;
  }

  const { manifest } = manifestResult;
  log(`Manifest status: ${manifest.status}`);

  if (!isCompleteBundle(manifest)) {
    log(`Bundle is not COMPLETE (status: ${manifest.status}) — refusing to treat it as verified.${manifest.failureDetail ? ` Failure detail: ${manifest.failureDetail}` : ""}`);
    const report: BundleVerificationReport = {
      schemaVersion: BUNDLE_VERIFICATION_REPORT_SCHEMA_VERSION,
      bundleDir,
      verificationTimestamp: new Date().toISOString(),
      manifestFound: true,
      manifestStatus: manifest.status,
      fileChecks: [],
      disposableRestoreResult: { attempted: false, restoreSucceeded: null, sanityChecksPassed: null, sanityChecks: [], errorDetail: null },
      overallPassed: false,
    };
    if (reportPath) await writeBundleVerificationReport(report, reportPath);
    process.exitCode = 1;
    return;
  }

  const fileChecks: BundleFileCheckResult[] = [];
  for (const [filename, expected] of [
    ["roles.sql", manifest.files.roles],
    ["schema.sql", manifest.files.schema],
    ["data.sql", manifest.files.data],
  ] as const) {
    const result = await checkBundleFile(bundleDir, filename, expected);
    fileChecks.push(result);
    log(`  ${filename}: exists=${result.actual.exists} sizeMatches=${result.sizeMatches} hashMatches=${result.hashMatches}`);
  }
  const allFilesPassed = fileChecks.every((c) => c.passed);
  if (!allFilesPassed) log("File-level bundle verification FAILED — refusing to proceed to a restore rehearsal, even if --restore was passed.");

  let disposableRestoreResult: BundleVerificationReport["disposableRestoreResult"] = { attempted: false, restoreSucceeded: null, sanityChecksPassed: null, sanityChecks: [], errorDetail: null };

  if (allFilesPassed && restoreRequested) {
    log("Running disposable bundle-restore rehearsal (this starts a throwaway local Docker Postgres container)...");
    const restoreResult = await runBundleRestoreRehearsal(bundleDir);
    disposableRestoreResult = {
      attempted: true,
      restoreSucceeded: restoreResult.restoreSucceeded,
      sanityChecksPassed: restoreResult.sanityChecks.length > 0 ? restoreResult.sanityChecks.every((c) => c.passed) : null,
      sanityChecks: restoreResult.sanityChecks,
      errorDetail: restoreResult.restoreErrorDetail,
    };
    log(`  restore succeeded: ${restoreResult.restoreSucceeded}`);
    if (restoreResult.restoreErrorDetail) log(`  restore error: ${restoreResult.restoreErrorDetail}`);
    for (const check of restoreResult.sanityChecks) {
      log(`  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    }
  } else if (!restoreRequested) {
    log("--restore not passed — skipping the disposable-restore rehearsal (file-level checks only).");
  }

  const overallPassed = allFilesPassed && (!disposableRestoreResult.attempted || (disposableRestoreResult.restoreSucceeded === true && disposableRestoreResult.sanityChecksPassed === true));

  const report: BundleVerificationReport = {
    schemaVersion: BUNDLE_VERIFICATION_REPORT_SCHEMA_VERSION,
    bundleDir,
    verificationTimestamp: new Date().toISOString(),
    manifestFound: true,
    manifestStatus: manifest.status,
    fileChecks,
    disposableRestoreResult,
    overallPassed,
  };

  log("── Bundle verification record (standard machine-readable format) ──────────────────────────");
  log(JSON.stringify(report, null, 2));
  log(report.overallPassed ? "backup:verify-bundle PASSED" : "backup:verify-bundle FAILED");
  log("──────────────────────────────────────────────────");

  if (reportPath) {
    await writeBundleVerificationReport(report, reportPath);
    log(`Report written to: ${path.resolve(reportPath)}`);
  }

  process.exitCode = overallPassed ? 0 : 1;
}

main().catch((err) => {
  log(`Unexpected error: ${redactConnectionStrings(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
});
