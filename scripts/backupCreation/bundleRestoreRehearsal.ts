/**
 * Production database backup creation v1 — bundle restore rehearsal. See
 * docs/database-backup-operations-v1.md.
 *
 * Reuses the exact same disposable-container infrastructure and sanity
 * checks as `scripts/backupVerification/restoreRehearsal.ts` (which
 * restores a single dump file) — this module is the multi-file
 * equivalent for a backup BUNDLE (roles.sql, schema.sql, data.sql
 * restored in that order into one disposable container), never a
 * parallel reimplementation of the container lifecycle or sanity
 * checks. Like the single-file version, this NEVER accepts a
 * caller-supplied database connection string as its restore target —
 * the target is always a fresh disposable container this module
 * creates itself, run through the same `requireDisposableDatabaseUrl`
 * structural guarantee.
 */
import crypto from "node:crypto";
import path from "node:path";
import { isDockerInstalled, isDockerDaemonRunning, findFreeLocalPort, startDisposablePostgresContainer, removeContainer, waitForPostgresReady } from "../releaseValidation/docker";
import { requireDisposableDatabaseUrl } from "../releaseValidation/dbSafetyGuard";
import { runCapture } from "../releaseValidation/processUtil";
import { runSanityChecks, type SanityCheckResult } from "../backupVerification/restoreRehearsal";
import { redactConnectionStrings } from "./connectionRedaction";

export type BundleRestoreRehearsalResult = {
  restoreSucceeded: boolean;
  restoreErrorDetail: string | null;
  sanityChecks: SanityCheckResult[];
  passed: boolean;
};

const CONTAINER_BUNDLE_DIR = "/tmp/bundle-restore-rehearsal";

async function restoreSqlFile(containerName: string, username: string, password: string, databaseName: string, containerFilePath: string, options: { stopOnError: boolean }): Promise<{ ok: boolean; detail: string }> {
  const args = ["exec", "-e", `PGPASSWORD=${password}`, containerName, "psql", "-U", username, "-d", databaseName, "-f", containerFilePath, "-v", `ON_ERROR_STOP=${options.stopOnError ? "1" : "0"}`];
  const result = await runCapture("docker", args, { timeoutMs: 120_000 });
  return { ok: result.code === 0, detail: redactConnectionStrings(result.stderr.trim().slice(0, 2000)) };
}

/**
 * Restores `<bundleDir>/roles.sql`, then `schema.sql`, then `data.sql`
 * (in that order — roles before schema, since a schema/data dump can
 * reference role names for ownership/grants) into a throwaway local
 * Docker Postgres container, runs the same sanity checks the single-file
 * rehearsal uses, then unconditionally tears the container down.
 *
 * `roles.sql` is restored with `ON_ERROR_STOP=0` — a fresh disposable
 * container already has its own default roles (e.g. the superuser this
 * module creates), so "role already exists" errors from a roles dump are
 * expected and non-fatal; `schema.sql` and `data.sql` are restored with
 * `ON_ERROR_STOP=1`, where any error is a genuine restore failure.
 */
export async function runBundleRestoreRehearsal(bundleDir: string): Promise<BundleRestoreRehearsalResult> {
  if (!(await isDockerInstalled())) {
    return { restoreSucceeded: false, restoreErrorDetail: "Docker is not installed — cannot run the disposable-restore rehearsal.", sanityChecks: [], passed: false };
  }
  if (!(await isDockerDaemonRunning())) {
    return { restoreSucceeded: false, restoreErrorDetail: "Docker is installed but the daemon is not running.", sanityChecks: [], passed: false };
  }

  const runId = crypto.randomBytes(6).toString("hex");
  const containerName = `tether-bundle-restore-${runId}`;
  const databaseName = `tether_br_${runId}`;
  const username = `br_user_${runId}`;
  const password = crypto.randomBytes(24).toString("base64url");

  try {
    const hostPort = await findFreeLocalPort();
    await startDisposablePostgresContainer({ containerName, runId, databaseName, username, password, hostPort });

    const disposableDatabaseUrl = `postgresql://${username}:${password}@localhost:${hostPort}/${databaseName}`;
    requireDisposableDatabaseUrl(disposableDatabaseUrl, hostPort);

    await waitForPostgresReady(disposableDatabaseUrl, 30_000);

    const mkdirResult = await runCapture("docker", ["exec", containerName, "mkdir", "-p", CONTAINER_BUNDLE_DIR], { timeoutMs: 15_000 });
    if (mkdirResult.code !== 0) {
      return { restoreSucceeded: false, restoreErrorDetail: `Failed to prepare the disposable container: ${redactConnectionStrings(mkdirResult.stderr.trim().slice(0, 1000))}`, sanityChecks: [], passed: false };
    }

    for (const filename of ["roles.sql", "schema.sql", "data.sql"]) {
      const hostPath = path.join(bundleDir, filename);
      const copyResult = await runCapture("docker", ["cp", hostPath, `${containerName}:${CONTAINER_BUNDLE_DIR}/${filename}`], { timeoutMs: 60_000 });
      if (copyResult.code !== 0) {
        return { restoreSucceeded: false, restoreErrorDetail: `Failed to copy ${filename} into the disposable container: ${redactConnectionStrings(copyResult.stderr.trim().slice(0, 1000))}`, sanityChecks: [], passed: false };
      }
    }

    const rolesRestore = await restoreSqlFile(containerName, username, password, databaseName, `${CONTAINER_BUNDLE_DIR}/roles.sql`, { stopOnError: false });
    // Roles restore is best-effort (see doc comment) — its own failure is not fatal to the rehearsal, but is reported.

    const schemaRestore = await restoreSqlFile(containerName, username, password, databaseName, `${CONTAINER_BUNDLE_DIR}/schema.sql`, { stopOnError: true });
    if (!schemaRestore.ok) {
      return { restoreSucceeded: false, restoreErrorDetail: `Schema restore failed: ${schemaRestore.detail}${rolesRestore.ok ? "" : ` (roles restore also reported errors, which may be expected: ${rolesRestore.detail})`}`, sanityChecks: [], passed: false };
    }

    const dataRestore = await restoreSqlFile(containerName, username, password, databaseName, `${CONTAINER_BUNDLE_DIR}/data.sql`, { stopOnError: true });
    if (!dataRestore.ok) {
      return { restoreSucceeded: false, restoreErrorDetail: `Data restore failed: ${dataRestore.detail}`, sanityChecks: [], passed: false };
    }

    const sanityChecks = await runSanityChecks(disposableDatabaseUrl);
    const passed = sanityChecks.every((c) => c.passed);
    return { restoreSucceeded: true, restoreErrorDetail: null, sanityChecks, passed };
  } finally {
    await removeContainer(containerName);
  }
}
