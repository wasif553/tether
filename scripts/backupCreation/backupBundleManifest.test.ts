/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the manifest module. Writes/reads real temp files
 * under the OS temp directory (never inside this repository) — no
 * database, no Docker.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newInProgressManifest, writeBundleManifest, readBundleManifest, isCompleteBundle, BACKUP_BUNDLE_MANIFEST_SCHEMA_VERSION, type BackupBundleManifest } from "./backupBundleManifest";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-manifest-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function sampleManifest(overrides: Partial<BackupBundleManifest> = {}): BackupBundleManifest {
  const base = newInProgressManifest({
    backupId: "2026-08-23T00-00-00-000Z",
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    sourceEnvironmentLabel: "local-test",
    sourceProjectRef: null,
    toolVersion: "0.1.0",
    repositoryCommit: "deadbeef",
  });
  return { ...base, ...overrides };
}

describe("newInProgressManifest", () => {
  it("starts as IN_PROGRESS with no files recorded", () => {
    const manifest = sampleManifest();
    expect(manifest.status).toBe("IN_PROGRESS");
    expect(manifest.files.schema).toBeNull();
    expect(manifest.files.data).toBeNull();
    expect(manifest.files.roles).toBeNull();
    expect(manifest.manifestSchemaVersion).toBe(BACKUP_BUNDLE_MANIFEST_SCHEMA_VERSION);
  });

  it("[5] contains no field capable of holding a credential — every field is a plain identifier, timestamp, or file descriptor", () => {
    const manifest = sampleManifest({
      files: {
        roles: { filename: "roles.sql", byteSize: 123, sha256: "a".repeat(64) },
        schema: { filename: "schema.sql", byteSize: 456, sha256: "b".repeat(64) },
        data: { filename: "data.sql", byteSize: 789, sha256: "c".repeat(64) },
      },
      status: "COMPLETE",
    });
    const serialised = JSON.stringify(manifest);
    expect(serialised).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(serialised).not.toMatch(/password/i);
    expect(serialised).not.toMatch(/DATABASE_URL/);
    expect(serialised).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("isCompleteBundle", () => {
  it("[8] a bundle with status IN_PROGRESS is never complete", () => {
    const manifest = sampleManifest({ status: "IN_PROGRESS" });
    expect(isCompleteBundle(manifest)).toBe(false);
  });

  it("[9] a bundle with status FAILED is never complete", () => {
    const manifest = sampleManifest({ status: "FAILED", failureDetail: "schema dump failed" });
    expect(isCompleteBundle(manifest)).toBe(false);
  });

  it("[8] a bundle marked COMPLETE but missing a required file entry is not actually complete", () => {
    const manifest = sampleManifest({
      status: "COMPLETE",
      files: {
        roles: { filename: "roles.sql", byteSize: 10, sha256: "a".repeat(64) },
        schema: { filename: "schema.sql", byteSize: 10, sha256: "b".repeat(64) },
        data: null, // missing
      },
    });
    expect(isCompleteBundle(manifest)).toBe(false);
  });

  it("[6][7] a bundle with status COMPLETE and all three files (each hashed and sized) is complete", () => {
    const manifest = sampleManifest({
      status: "COMPLETE",
      files: {
        roles: { filename: "roles.sql", byteSize: 111, sha256: "a".repeat(64) },
        schema: { filename: "schema.sql", byteSize: 222, sha256: "b".repeat(64) },
        data: { filename: "data.sql", byteSize: 333, sha256: "c".repeat(64) },
      },
    });
    expect(isCompleteBundle(manifest)).toBe(true);
    expect(manifest.files.roles!.sha256).toHaveLength(64);
    expect(manifest.files.schema!.byteSize).toBeGreaterThan(0);
    expect(manifest.files.data!.byteSize).toBeGreaterThan(0);
  });
});

describe("writeBundleManifest / readBundleManifest", () => {
  it("round-trips a manifest through disk", async () => {
    const manifest = sampleManifest({ status: "COMPLETE", files: { roles: { filename: "roles.sql", byteSize: 1, sha256: "a".repeat(64) }, schema: { filename: "schema.sql", byteSize: 1, sha256: "b".repeat(64) }, data: { filename: "data.sql", byteSize: 1, sha256: "c".repeat(64) } } });
    await writeBundleManifest(tmpDir, manifest);
    const result = await readBundleManifest(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).toEqual(manifest);
  });

  it("[14] reports a clear failure when manifest.json is missing", async () => {
    const result = await readBundleManifest(tmpDir);
    expect(result.ok).toBe(false);
  });

  it("[14] reports a clear failure when manifest.json is not valid JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "manifest.json"), "{ this is not json", "utf8");
    const result = await readBundleManifest(tmpDir);
    expect(result.ok).toBe(false);
  });

  it("[14] reports a clear failure when the JSON doesn't match the expected manifest shape", async () => {
    await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify({ unrelated: "shape" }), "utf8");
    const result = await readBundleManifest(tmpDir);
    expect(result.ok).toBe(false);
  });
});
