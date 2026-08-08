import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkBackupFileExists,
  isPlausibleBackupSize,
  computeFileSha256,
  detectDumpFormat,
  verifyBackupFile,
  MIN_PLAUSIBLE_BACKUP_BYTES,
} from "./backupFileChecks";
import { createHash } from "node:crypto";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "backup-verify-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("checkBackupFileExists", () => {
  it("reports exists:false for a missing file — never throws", async () => {
    const result = await checkBackupFileExists(path.join(dir, "does-not-exist.dump"));
    expect(result).toEqual({ exists: false });
  });

  it("reports exists:true with the real size for a present file", async () => {
    const filePath = path.join(dir, "present.dump");
    await writeFile(filePath, Buffer.alloc(1234));
    const result = await checkBackupFileExists(filePath);
    expect(result).toEqual({ exists: true, sizeBytes: 1234 });
  });
});

describe("isPlausibleBackupSize — the direct fix for the 41-byte incident", () => {
  it("rejects a 41-byte file (the exact historical incident size)", () => {
    expect(isPlausibleBackupSize(41)).toBe(false);
  });

  it("rejects 0 bytes", () => {
    expect(isPlausibleBackupSize(0)).toBe(false);
  });

  it("accepts a size at or above the default minimum", () => {
    expect(isPlausibleBackupSize(MIN_PLAUSIBLE_BACKUP_BYTES)).toBe(true);
    expect(isPlausibleBackupSize(MIN_PLAUSIBLE_BACKUP_BYTES + 1)).toBe(true);
  });

  it("honours a caller-supplied minimum instead of the default", () => {
    expect(isPlausibleBackupSize(500, 1000)).toBe(false);
    expect(isPlausibleBackupSize(1500, 1000)).toBe(true);
  });
});

describe("computeFileSha256", () => {
  it("matches Node's own crypto hash of the same bytes", async () => {
    const filePath = path.join(dir, "hash-me.txt");
    const content = Buffer.from("some deterministic backup-verification test content", "utf8");
    await writeFile(filePath, content);
    const expected = createHash("sha256").update(content).digest("hex");
    expect(await computeFileSha256(filePath)).toBe(expected);
  });
});

describe("detectDumpFormat", () => {
  it("recognises a pg_dump custom-format header (PGDMP magic bytes)", async () => {
    const filePath = path.join(dir, "custom.dump");
    await writeFile(filePath, Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(100)]));
    expect(await detectDumpFormat(filePath)).toBe("CUSTOM");
  });

  it("recognises a pg_dump plain-SQL header comment", async () => {
    const filePath = path.join(dir, "plain.sql");
    await writeFile(filePath, "--\n-- PostgreSQL database dump\n--\n\nCREATE TABLE foo (id int);\n", "utf8");
    expect(await detectDumpFormat(filePath)).toBe("PLAIN_SQL");
  });

  it("reports UNKNOWN for a file that matches neither signature — e.g. a truncated/corrupted dump", async () => {
    const filePath = path.join(dir, "garbage.dump");
    await writeFile(filePath, Buffer.from("not a real dump at all, just some other bytes"));
    expect(await detectDumpFormat(filePath)).toBe("UNKNOWN");
  });

  it("reports UNKNOWN for an empty file", async () => {
    const filePath = path.join(dir, "empty.dump");
    await writeFile(filePath, Buffer.alloc(0));
    expect(await detectDumpFormat(filePath)).toBe("UNKNOWN");
  });
});

describe("verifyBackupFile — the combined gate", () => {
  it("fails closed for a missing file", async () => {
    const result = await verifyBackupFile(path.join(dir, "nope.dump"));
    expect(result.passed).toBe(false);
    expect(result.exists).toBe(false);
  });

  it("fails closed for a tiny (41-byte) file, without even attempting to hash/sniff it", async () => {
    const filePath = path.join(dir, "tiny.dump");
    await writeFile(filePath, Buffer.alloc(41, "x"));
    const result = await verifyBackupFile(filePath);
    expect(result.passed).toBe(false);
    expect(result.plausibleSize).toBe(false);
    expect(result.sha256).toBeNull();
    expect(result.dumpFormat).toBeNull();
  });

  it("fails closed for a large file with malformed/unrecognisable content", async () => {
    const filePath = path.join(dir, "large-garbage.dump");
    await writeFile(filePath, Buffer.alloc(MIN_PLAUSIBLE_BACKUP_BYTES + 500, "z"));
    const result = await verifyBackupFile(filePath);
    expect(result.plausibleSize).toBe(true);
    expect(result.dumpFormat).toBe("UNKNOWN");
    expect(result.passed).toBe(false);
  });

  it("passes for a plausible, well-formed plain-SQL dump", async () => {
    const filePath = path.join(dir, "good.sql");
    const body = "--\n-- PostgreSQL database dump\n--\n\n" + "CREATE TABLE foo (id int);\n".repeat(500);
    await writeFile(filePath, body, "utf8");
    const result = await verifyBackupFile(filePath);
    expect(result.passed).toBe(true);
    expect(result.dumpFormat).toBe("PLAIN_SQL");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("passes for a plausible custom-format dump", async () => {
    const filePath = path.join(dir, "good.dump");
    await writeFile(filePath, Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(MIN_PLAUSIBLE_BACKUP_BYTES)]));
    const result = await verifyBackupFile(filePath);
    expect(result.passed).toBe(true);
    expect(result.dumpFormat).toBe("CUSTOM");
  });
});
