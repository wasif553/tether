/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the pure output-path safety guard — path arithmetic
 * only, no actual filesystem access.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeBackupOutputPath, DEDICATED_LOCAL_BACKUP_DIR } from "./outputPathSafety";

const REPO_ROOT = path.resolve("C:/fake-repo-root");

describe("assertSafeBackupOutputPath", () => {
  it("[10] rejects an output path inside src/", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, "src", "backups"), REPO_ROOT);
    expect(result.ok).toBe(false);
  });

  it("[10] rejects an output path inside docs/", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, "docs"), REPO_ROOT);
    expect(result.ok).toBe(false);
  });

  it("[10] rejects an output path inside prisma/", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, "prisma"), REPO_ROOT);
    expect(result.ok).toBe(false);
  });

  it("[10] rejects an output path inside apps/", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, "apps", "lockdown"), REPO_ROOT);
    expect(result.ok).toBe(false);
  });

  it("[10] rejects an output path inside .git/", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, ".git"), REPO_ROOT);
    expect(result.ok).toBe(false);
  });

  it("[10] rejects the repository root itself", () => {
    const result = assertSafeBackupOutputPath(REPO_ROOT, REPO_ROOT);
    expect(result.ok).toBe(false);
  });

  it("[10] rejects an arbitrary, unrecognised in-repo path (fails closed, not just a denylist)", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, "some-new-folder"), REPO_ROOT);
    expect(result.ok).toBe(false);
  });

  it("[11] allows the dedicated ignored local-backup directory", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, DEDICATED_LOCAL_BACKUP_DIR), REPO_ROOT);
    expect(result.ok).toBe(true);
  });

  it("[11] allows a subdirectory under the dedicated local-backup directory", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, DEDICATED_LOCAL_BACKUP_DIR, "2026-08-23"), REPO_ROOT);
    expect(result.ok).toBe(true);
  });

  it("allows an explicit path entirely outside the repository", () => {
    const result = assertSafeBackupOutputPath(path.resolve("C:/some/external/backup/location"), REPO_ROOT);
    expect(result.ok).toBe(true);
  });

  it("gives a reason string when rejecting", () => {
    const result = assertSafeBackupOutputPath(path.join(REPO_ROOT, "src"), REPO_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toMatch(/src/);
    }
  });
});
