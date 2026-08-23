/**
 * Production database backup creation v1 — bundle verification report.
 * Mirrors scripts/backupVerification/verificationReport.ts's own shape
 * and conventions for the single-file case. A small, local,
 * admin-readable JSON artifact — never a database table, never uploaded
 * anywhere, never stores Production credentials.
 */
import { writeFile } from "node:fs/promises";
import type { BundleFileCheckResult } from "./bundleFileVerification";

export const BUNDLE_VERIFICATION_REPORT_SCHEMA_VERSION = 1;

export type BundleVerificationReport = {
  schemaVersion: typeof BUNDLE_VERIFICATION_REPORT_SCHEMA_VERSION;
  bundleDir: string;
  verificationTimestamp: string;
  manifestFound: boolean;
  manifestStatus: string | null;
  fileChecks: BundleFileCheckResult[];
  disposableRestoreResult: {
    attempted: boolean;
    restoreSucceeded: boolean | null;
    sanityChecksPassed: boolean | null;
    sanityChecks: Array<{ name: string; passed: boolean; detail: string }>;
    errorDetail: string | null;
  };
  overallPassed: boolean;
};

export async function writeBundleVerificationReport(report: BundleVerificationReport, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(report, null, 2) + "\n", "utf8");
}
