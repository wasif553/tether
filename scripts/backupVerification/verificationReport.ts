/**
 * Production administration hardening v1, Part F — standard,
 * machine-readable backup verification result format. Builds on the
 * existing tooling (backupFileChecks.ts, restoreRehearsal.ts) — see
 * docs/production-backup-restore-runbook.md.
 *
 * A small, local, admin-readable report artifact (JSON file) — never a
 * database table, never uploaded anywhere, never stores Production
 * credentials (nothing in this shape includes a connection string,
 * password, or any secret). Written by scripts/verify-backup.ts via
 * `--report <path>`.
 */
import { writeFile } from "node:fs/promises";
import type { BackupFileVerificationResult } from "./backupFileChecks";
import type { RestoreRehearsalResult } from "./restoreRehearsal";

export const BACKUP_VERIFICATION_REPORT_SCHEMA_VERSION = 1;

export type BackupVerificationReport = {
  schemaVersion: typeof BACKUP_VERIFICATION_REPORT_SCHEMA_VERSION;
  backupFilename: string;
  sizeBytes: number | null;
  sha256: string | null;
  verificationTimestamp: string;
  formatResult: {
    exists: boolean;
    plausibleSize: boolean;
    dumpFormat: string | null;
    passed: boolean;
  };
  disposableRestoreResult: {
    attempted: boolean;
    restoreSucceeded: boolean | null;
    schemaSanityPassed: boolean | null;
    sanityChecks: Array<{ name: string; passed: boolean; detail: string }>;
    errorDetail: string | null;
  };
  /** True only when every attempted check passed — false if anything failed OR was never attempted but required (e.g. --restore requested but format check failed first). */
  overallPassed: boolean;
};

export function buildBackupVerificationReport(params: {
  filePath: string;
  fileResult: BackupFileVerificationResult;
  restoreResult: RestoreRehearsalResult | null;
  now?: Date;
}): BackupVerificationReport {
  const restoreAttempted = params.restoreResult != null;
  const schemaSanityPassed = params.restoreResult ? params.restoreResult.sanityChecks.length > 0 && params.restoreResult.sanityChecks.every((c) => c.passed) : null;

  const overallPassed = params.fileResult.passed && (params.restoreResult == null || params.restoreResult.passed);

  return {
    schemaVersion: BACKUP_VERIFICATION_REPORT_SCHEMA_VERSION,
    backupFilename: params.filePath,
    sizeBytes: params.fileResult.sizeBytes,
    sha256: params.fileResult.sha256,
    verificationTimestamp: (params.now ?? new Date()).toISOString(),
    formatResult: {
      exists: params.fileResult.exists,
      plausibleSize: params.fileResult.plausibleSize,
      dumpFormat: params.fileResult.dumpFormat,
      passed: params.fileResult.passed,
    },
    disposableRestoreResult: {
      attempted: restoreAttempted,
      restoreSucceeded: params.restoreResult?.restoreSucceeded ?? null,
      schemaSanityPassed,
      sanityChecks: params.restoreResult?.sanityChecks ?? [],
      errorDetail: params.restoreResult?.restoreErrorDetail ?? null,
    },
    overallPassed,
  };
}

/** Writes the report as pretty-printed JSON. Never overwrites silently without the caller having chosen the path — this is a plain, explicit file write, no locking/merging logic (each verification run produces its own report). */
export async function writeBackupVerificationReport(report: BackupVerificationReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}
