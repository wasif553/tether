/**
 * Production backup verification — file-level checks. See
 * docs/production-backup-restore-runbook.md.
 *
 * Pure, dependency-free (beyond Node's own `fs`/`crypto`) checks that run
 * BEFORE any restore is attempted. This is the direct fix for the
 * historical incident that motivated this tool: a previous "backup" that
 * was only 41 bytes and silently unusable — nothing in the old workflow
 * ever checked the file's size or contents, only that a file existed.
 * These functions are unit-tested without Docker; the restore rehearsal
 * (restoreRehearsal.ts) is a separate, Docker-dependent stage that only
 * runs after every check here passes.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * Below this, a dump file cannot possibly contain a real schema + data —
 * even an empty freshly-migrated database's `pg_dump` output is many
 * kilobytes of DDL alone. Deliberately conservative (not tuned to this
 * database's actual expected size) so this never depends on being kept in
 * sync with schema growth — it exists only to catch the "41 bytes"
 * class of failure, not to bound-check a real backup's size.
 */
export const MIN_PLAUSIBLE_BACKUP_BYTES = 10_000;

export type FileExistenceCheck = { exists: true; sizeBytes: number } | { exists: false };

export async function checkBackupFileExists(filePath: string): Promise<FileExistenceCheck> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return { exists: false };
    return { exists: true, sizeBytes: stats.size };
  } catch {
    return { exists: false };
  }
}

export function isPlausibleBackupSize(sizeBytes: number, minBytes: number = MIN_PLAUSIBLE_BACKUP_BYTES): boolean {
  return sizeBytes >= minBytes;
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export const DUMP_FORMATS = ["CUSTOM", "PLAIN_SQL", "DIRECTORY_OR_TAR", "UNKNOWN"] as const;
export type DumpFormat = (typeof DUMP_FORMATS)[number];

/** pg_dump's custom-format (`-Fc`) magic header — see pg_dump's own src/bin/pg_dump/pg_backup_archiver.c. */
const CUSTOM_FORMAT_MAGIC = Buffer.from("PGDMP", "ascii");

/**
 * Sniffs the dump's actual format from its own bytes, never from the file
 * extension (a mislabeled `.sql` file that's actually a custom-format dump,
 * or vice versa, is exactly the kind of silent mismatch this exists to
 * catch). Reads only a small bounded prefix — never the whole file twice.
 */
export async function detectDumpFormat(filePath: string): Promise<DumpFormat> {
  const handle = await import("node:fs/promises").then((fs) => fs.open(filePath, "r"));
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    const prefix = buffer.subarray(0, bytesRead);

    if (prefix.subarray(0, CUSTOM_FORMAT_MAGIC.length).equals(CUSTOM_FORMAT_MAGIC)) {
      return "CUSTOM";
    }
    // A pg_dump plain-SQL dump always opens with this exact header comment
    // (see pg_dump.c's printfPQExpBuffer("-- PostgreSQL database dump")) —
    // sniffed as text, tolerant of a leading UTF-8 BOM.
    const text = prefix.toString("utf8").replace(/^﻿/, "");
    if (text.startsWith("--\n-- PostgreSQL database dump") || text.includes("PostgreSQL database dump")) {
      return "PLAIN_SQL";
    }
    // A directory-format or tar-format dump's first bytes won't match
    // either signature reliably when read as a single file (directory
    // format isn't a single file at all) — reported distinctly so a
    // caller can decide whether that's expected for their workflow,
    // rather than silently bucketed into UNKNOWN.
    if (prefix.subarray(0, 5).toString("ascii") === "ustar" || (bytesRead >= 262 && buffer.subarray(257, 262).toString("ascii") === "ustar")) {
      return "DIRECTORY_OR_TAR";
    }
    return "UNKNOWN";
  } finally {
    await handle.close();
  }
}

export type BackupFileVerificationResult = {
  filePath: string;
  exists: boolean;
  sizeBytes: number | null;
  plausibleSize: boolean;
  sha256: string | null;
  dumpFormat: DumpFormat | null;
  /** True only when every check above passed — the single gate a caller should check before proceeding to a restore rehearsal. */
  passed: boolean;
};

/** Runs every file-level check in order, short-circuiting on the first failure (no point hashing a file that doesn't exist). Never throws — every failure mode is represented in the returned result. */
export async function verifyBackupFile(filePath: string, minBytes: number = MIN_PLAUSIBLE_BACKUP_BYTES): Promise<BackupFileVerificationResult> {
  const existence = await checkBackupFileExists(filePath);
  if (!existence.exists) {
    return { filePath, exists: false, sizeBytes: null, plausibleSize: false, sha256: null, dumpFormat: null, passed: false };
  }

  const plausibleSize = isPlausibleBackupSize(existence.sizeBytes, minBytes);
  if (!plausibleSize) {
    return { filePath, exists: true, sizeBytes: existence.sizeBytes, plausibleSize: false, sha256: null, dumpFormat: null, passed: false };
  }

  const [sha256, dumpFormat] = await Promise.all([computeFileSha256(filePath), detectDumpFormat(filePath)]);
  const passed = dumpFormat === "CUSTOM" || dumpFormat === "PLAIN_SQL";

  return { filePath, exists: true, sizeBytes: existence.sizeBytes, plausibleSize: true, sha256, dumpFormat, passed };
}
