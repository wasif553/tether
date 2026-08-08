import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBackupVerificationReport, writeBackupVerificationReport, BACKUP_VERIFICATION_REPORT_SCHEMA_VERSION } from "./verificationReport";
import type { BackupFileVerificationResult } from "./backupFileChecks";
import type { RestoreRehearsalResult } from "./restoreRehearsal";

const passingFileResult: BackupFileVerificationResult = {
  filePath: "/tmp/backup.dump",
  exists: true,
  sizeBytes: 50000,
  plausibleSize: true,
  sha256: "abc123",
  dumpFormat: "CUSTOM",
  passed: true,
};

const failingFileResult: BackupFileVerificationResult = {
  filePath: "/tmp/tiny.dump",
  exists: true,
  sizeBytes: 41,
  plausibleSize: false,
  sha256: null,
  dumpFormat: null,
  passed: false,
};

const passingRestoreResult: RestoreRehearsalResult = {
  restoreSucceeded: true,
  restoreErrorDetail: null,
  sanityChecks: [{ name: "public schema has at least one table", passed: true, detail: "3 tables" }],
  passed: true,
};

describe("buildBackupVerificationReport", () => {
  it("marks overallPassed true when file checks pass and no restore was attempted", () => {
    const report = buildBackupVerificationReport({ filePath: "/tmp/backup.dump", fileResult: passingFileResult, restoreResult: null });
    expect(report.overallPassed).toBe(true);
    expect(report.disposableRestoreResult.attempted).toBe(false);
    expect(report.schemaVersion).toBe(BACKUP_VERIFICATION_REPORT_SCHEMA_VERSION);
  });

  it("marks overallPassed false when file checks fail, regardless of restore result", () => {
    const report = buildBackupVerificationReport({ filePath: "/tmp/tiny.dump", fileResult: failingFileResult, restoreResult: null });
    expect(report.overallPassed).toBe(false);
    expect(report.formatResult.passed).toBe(false);
  });

  it("marks overallPassed true only when both file checks AND restore checks pass", () => {
    const report = buildBackupVerificationReport({ filePath: "/tmp/backup.dump", fileResult: passingFileResult, restoreResult: passingRestoreResult });
    expect(report.overallPassed).toBe(true);
    expect(report.disposableRestoreResult.attempted).toBe(true);
    expect(report.disposableRestoreResult.schemaSanityPassed).toBe(true);
  });

  it("marks overallPassed false when file checks pass but restore fails", () => {
    const failedRestore: RestoreRehearsalResult = { restoreSucceeded: false, restoreErrorDetail: "pg_restore exit 1", sanityChecks: [], passed: false };
    const report = buildBackupVerificationReport({ filePath: "/tmp/backup.dump", fileResult: passingFileResult, restoreResult: failedRestore });
    expect(report.overallPassed).toBe(false);
    expect(report.disposableRestoreResult.errorDetail).toBe("pg_restore exit 1");
  });

  it("never includes a connection string, password, or credential field anywhere in the report shape", () => {
    const report = buildBackupVerificationReport({ filePath: "/tmp/backup.dump", fileResult: passingFileResult, restoreResult: passingRestoreResult });
    const serialized = JSON.stringify(report).toLowerCase();
    expect(serialized).not.toMatch(/password|postgresql:\/\/|connectionstring/);
  });
});

describe("writeBackupVerificationReport", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes valid, re-parseable JSON matching the report shape", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "backup-report-test-"));
    const report = buildBackupVerificationReport({ filePath: "/tmp/backup.dump", fileResult: passingFileResult, restoreResult: null });
    const reportPath = path.join(dir, "report.json");
    await writeBackupVerificationReport(report, reportPath);
    const written = JSON.parse(await readFile(reportPath, "utf8"));
    expect(written).toEqual(report);
  });
});
