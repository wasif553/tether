/**
 * Production database backup creation v1 — backup bundle manifest. See
 * docs/database-backup-operations-v1.md.
 *
 * A backup bundle is a directory (`schema.sql`, `data.sql`, `roles.sql`,
 * `manifest.json`), never one ambiguous unnamed file. This module owns
 * the manifest's shape and its read/write, so `scripts/create-database-backup.ts`
 * (the writer) and `scripts/verify-backup-bundle.ts` (the reader) can
 * never silently drift apart on the schema.
 *
 * **This module's own types do NOT, by themselves, prevent a secret
 * from ending up in this manifest** — `sourceEnvironmentLabel` and
 * `sourceProjectRef` are plain `string` fields, and TypeScript's type
 * system has no way to express "not a connection string." What
 * actually makes every field here non-secret operational metadata is
 * `scripts/backupCreation/manifestMetadataValidation.ts`: every value
 * that reaches this manifest is validated against a strict ALLOWLIST
 * pattern (`checkBackupCreateExecuteSafety` in `cliArgs.ts` runs this
 * validation, and refuses `--execute` outright on a malformed value —
 * see that module) BEFORE it is ever passed to `newInProgressManifest`
 * below. `failureDetail` is the one exception: it is redacted
 * operational diagnostic text produced by the tool itself (via
 * `redactConnectionStrings`), not operator-supplied metadata, and
 * carries the same "never a raw, unredacted subprocess error" guarantee
 * documented on that field.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const BACKUP_BUNDLE_MANIFEST_SCHEMA_VERSION = 1;
export const BACKUP_BUNDLE_MANIFEST_FILENAME = "manifest.json";

export type BackupBundleFileEntry = {
  filename: string;
  byteSize: number;
  sha256: string;
};

export type BackupBundleStatus = "IN_PROGRESS" | "COMPLETE" | "FAILED";

export type BackupBundleManifest = {
  manifestSchemaVersion: typeof BACKUP_BUNDLE_MANIFEST_SCHEMA_VERSION;
  backupId: string;
  createdAt: string;
  /** Operator-supplied, e.g. "production", "local-test" — validated and normalised (trimmed, lowercased) by `validateEnvironmentLabel` before it ever reaches this field; never inferred from the connection string. */
  sourceEnvironmentLabel: string;
  /** Explicitly supplied by the operator and validated by `validateSourceProjectRef`, or safely derived from a Supabase hostname/pooler-username pattern — never a connection string. Null if neither is available. */
  sourceProjectRef: string | null;
  toolVersion: string | null;
  repositoryCommit: string | null;
  files: {
    schema: BackupBundleFileEntry | null;
    data: BackupBundleFileEntry | null;
    roles: BackupBundleFileEntry | null;
  };
  status: BackupBundleStatus;
  /** Redacted diagnostic text — set only when status is FAILED. Never a raw subprocess error that could echo a connection string; callers must redact before assigning this field. */
  failureDetail: string | null;
  verification: {
    verifiedAt: string | null;
    verifiedResult: "PASS" | "FAIL" | null;
  };
};

export function newInProgressManifest(params: {
  backupId: string;
  createdAt: Date;
  sourceEnvironmentLabel: string;
  sourceProjectRef: string | null;
  toolVersion: string | null;
  repositoryCommit: string | null;
}): BackupBundleManifest {
  return {
    manifestSchemaVersion: BACKUP_BUNDLE_MANIFEST_SCHEMA_VERSION,
    backupId: params.backupId,
    createdAt: params.createdAt.toISOString(),
    sourceEnvironmentLabel: params.sourceEnvironmentLabel,
    sourceProjectRef: params.sourceProjectRef,
    toolVersion: params.toolVersion,
    repositoryCommit: params.repositoryCommit,
    files: { schema: null, data: null, roles: null },
    status: "IN_PROGRESS",
    failureDetail: null,
    verification: { verifiedAt: null, verifiedResult: null },
  };
}

/** A bundle is only usable (restorable, verifiable) when status is COMPLETE and all three required files are present — never inferred from status alone, in case a manifest was hand-edited or corrupted. */
export function isCompleteBundle(manifest: BackupBundleManifest): boolean {
  return manifest.status === "COMPLETE" && manifest.files.schema != null && manifest.files.data != null && manifest.files.roles != null;
}

export async function writeBundleManifest(bundleDir: string, manifest: BackupBundleManifest): Promise<void> {
  await writeFile(path.join(bundleDir, BACKUP_BUNDLE_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export type ReadManifestResult = { ok: true; manifest: BackupBundleManifest } | { ok: false; reason: string };

/** Never throws — a missing or malformed manifest is an ordinary, expected verification-failure outcome, not a crash. */
export async function readBundleManifest(bundleDir: string): Promise<ReadManifestResult> {
  const manifestPath = path.join(bundleDir, BACKUP_BUNDLE_MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return { ok: false, reason: `No ${BACKUP_BUNDLE_MANIFEST_FILENAME} found at ${manifestPath}.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${BACKUP_BUNDLE_MANIFEST_FILENAME} is not valid JSON.` };
  }
  if (typeof parsed !== "object" || parsed === null || !("manifestSchemaVersion" in parsed) || !("files" in parsed) || !("status" in parsed)) {
    return { ok: false, reason: `${BACKUP_BUNDLE_MANIFEST_FILENAME} does not match the expected backup-bundle manifest shape.` };
  }
  return { ok: true, manifest: parsed as BackupBundleManifest };
}
