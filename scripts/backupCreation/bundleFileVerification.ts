/**
 * Production database backup creation v1 — per-file bundle verification.
 * See docs/database-backup-operations-v1.md and
 * scripts/verify-backup-bundle.ts.
 *
 * Recomputes a file's actual size/SHA-256 and compares against what the
 * bundle's own manifest declared — the one place that comparison
 * happens, so both a missing file and a tampered/corrupted one are
 * detected the same way, every time.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { computeFileSha256 } from "../backupVerification/backupFileChecks";
import type { BackupBundleFileEntry } from "./backupBundleManifest";

export type BundleFileCheckResult = {
  filename: string;
  expected: BackupBundleFileEntry | null;
  actual: { exists: boolean; byteSize: number | null; sha256: string | null };
  sizeMatches: boolean;
  hashMatches: boolean;
  /** True only when the file exists AND both size and hash match the manifest's declared values. */
  passed: boolean;
};

/**
 * Never throws — a missing file, a manifest with no entry for this
 * filename, or an unreadable file are all ordinary, expected
 * verification-failure outcomes, represented in the returned result.
 */
export async function checkBundleFile(bundleDir: string, filename: string, expected: BackupBundleFileEntry | null): Promise<BundleFileCheckResult> {
  const filePath = path.join(bundleDir, filename);
  let exists = true;
  let byteSize: number | null = null;
  try {
    const stats = await stat(filePath);
    byteSize = stats.size;
  } catch {
    exists = false;
  }

  if (!exists || expected == null) {
    return { filename, expected, actual: { exists, byteSize, sha256: null }, sizeMatches: false, hashMatches: false, passed: false };
  }

  const sha256 = await computeFileSha256(filePath);
  const sizeMatches = byteSize === expected.byteSize;
  const hashMatches = sha256 === expected.sha256;
  return { filename, expected, actual: { exists, byteSize, sha256 }, sizeMatches, hashMatches, passed: sizeMatches && hashMatches };
}
