/**
 * scripts/backupCreation/bundleRestoreRehearsal.ts — static/structural
 * regression guards over the Postgres-17 restore-target fix. No Docker
 * is invoked here; the real end-to-end restore exercise (against a
 * disposable Postgres source, using the real pinned Supabase CLI) is a
 * separate, manually-run synthetic exercise — see
 * docs/database-backup-operations-v1.md's "Current status" section.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLE_RESTORE_REHEARSAL_POSTGRES_IMAGE } from "./bundleRestoreRehearsal";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const bundleRestoreRehearsalSource = fs.readFileSync(path.join(REPO_ROOT, "scripts", "backupCreation", "bundleRestoreRehearsal.ts"), "utf8");
const singleFileRestoreRehearsalSource = fs.readFileSync(path.join(REPO_ROOT, "scripts", "backupVerification", "restoreRehearsal.ts"), "utf8");
const releaseValidateSource = fs.readFileSync(path.join(REPO_ROOT, "scripts", "release-validate.ts"), "utf8");
const createBackupSource = fs.readFileSync(path.join(REPO_ROOT, "scripts", "create-database-backup.ts"), "utf8");

describe("[2] bundle restore rehearsal explicitly requests postgres:17-alpine", () => {
  it("BUNDLE_RESTORE_REHEARSAL_POSTGRES_IMAGE is exactly postgres:17-alpine", () => {
    expect(BUNDLE_RESTORE_REHEARSAL_POSTGRES_IMAGE).toBe("postgres:17-alpine");
  });

  it("startDisposablePostgresContainer is called with image: BUNDLE_RESTORE_REHEARSAL_POSTGRES_IMAGE", () => {
    expect(bundleRestoreRehearsalSource).toMatch(/startDisposablePostgresContainer\(\{[^}]*image:\s*BUNDLE_RESTORE_REHEARSAL_POSTGRES_IMAGE/);
  });
});

describe("[3][4] every other disposable-container caller retains the shared default (no explicit image override)", () => {
  it("the single-file restore verifier (scripts/backupVerification/restoreRehearsal.ts) does not pass an image option", () => {
    expect(singleFileRestoreRehearsalSource).not.toMatch(/image:/);
  });

  it("release-validate.ts does not pass an image option", () => {
    expect(releaseValidateSource).not.toMatch(/image:/);
  });

  it("create-database-backup.ts's own local-generic toolbox container does not pass an image option", () => {
    expect(createBackupSource).not.toMatch(/image:/);
  });
});

describe("[7][8] restore target remains structurally disposable-only — no regression from this fix", () => {
  it("bundleRestoreRehearsal.ts still imports and calls requireDisposableDatabaseUrl", () => {
    expect(bundleRestoreRehearsalSource).toMatch(/import \{ requireDisposableDatabaseUrl \}/);
    expect(bundleRestoreRehearsalSource).toMatch(/requireDisposableDatabaseUrl\(disposableDatabaseUrl, hostPort\)/);
  });

  it("runBundleRestoreRehearsal still takes only a bundleDir path — no caller-supplied restore DATABASE_URL parameter", () => {
    expect(bundleRestoreRehearsalSource).toMatch(/export async function runBundleRestoreRehearsal\(bundleDir: string\)/);
  });

  it("the disposable database URL is still built by this module itself from a freshly generated random username/password, never accepted as an argument", () => {
    expect(bundleRestoreRehearsalSource).toMatch(/const disposableDatabaseUrl = `postgresql:\/\/\$\{username\}:\$\{password\}@localhost:\$\{hostPort\}\/\$\{databaseName\}`/);
  });
});
