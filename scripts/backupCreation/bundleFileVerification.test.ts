/**
 * Production Database Backup Creation v1 — see
 * docs/database-backup-operations-v1.md.
 *
 * Unit tests over the per-file bundle-verification module, using real
 * temp files under the OS temp directory (never inside this repository)
 * — no database, no Docker.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBundleFile } from "./bundleFileVerification";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-file-verify-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFileAndDescribe(filename: string, contents: string) {
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, contents, "utf8");
  const sha256 = createHash("sha256").update(contents, "utf8").digest("hex");
  return { filename, byteSize: Buffer.byteLength(contents, "utf8"), sha256 };
}

describe("checkBundleFile", () => {
  it("passes when the file's actual size/hash match the manifest's declared values", async () => {
    const expected = await writeFileAndDescribe("schema.sql", "CREATE TABLE foo (id int);");
    const result = await checkBundleFile(tmpDir, "schema.sql", expected);
    expect(result.passed).toBe(true);
    expect(result.sizeMatches).toBe(true);
    expect(result.hashMatches).toBe(true);
    expect(result.actual.exists).toBe(true);
  });

  it("[12] detects a tampered file (hash mismatch, size may or may not change)", async () => {
    const expected = await writeFileAndDescribe("schema.sql", "CREATE TABLE foo (id int);");
    // Tamper with the file after the manifest was "recorded" — same length, different content.
    await fs.writeFile(path.join(tmpDir, "schema.sql"), "CREATE TABLE bar (id int);", "utf8");
    const result = await checkBundleFile(tmpDir, "schema.sql", expected);
    expect(result.passed).toBe(false);
    expect(result.hashMatches).toBe(false);
    expect(result.actual.exists).toBe(true);
  });

  it("[12] detects tampering that changes the file's size too", async () => {
    const expected = await writeFileAndDescribe("data.sql", "INSERT INTO foo VALUES (1);");
    await fs.writeFile(path.join(tmpDir, "data.sql"), "INSERT INTO foo VALUES (1); -- appended", "utf8");
    const result = await checkBundleFile(tmpDir, "data.sql", expected);
    expect(result.passed).toBe(false);
    expect(result.sizeMatches).toBe(false);
    expect(result.hashMatches).toBe(false);
  });

  it("[13] detects a missing file", async () => {
    const expected = { filename: "roles.sql", byteSize: 42, sha256: "a".repeat(64) };
    const result = await checkBundleFile(tmpDir, "roles.sql", expected);
    expect(result.passed).toBe(false);
    expect(result.actual.exists).toBe(false);
    expect(result.actual.sha256).toBeNull();
  });

  it("fails when the manifest declares no entry for this file at all", async () => {
    await fs.writeFile(path.join(tmpDir, "schema.sql"), "CREATE TABLE foo (id int);", "utf8");
    const result = await checkBundleFile(tmpDir, "schema.sql", null);
    expect(result.passed).toBe(false);
  });
});
