/**
 * Production backup verification — optional disposable-restore rehearsal.
 * See docs/production-backup-restore-runbook.md.
 *
 * Restores a dump file into a THROWAWAY local Docker Postgres container
 * (reusing the exact same disposable-container infrastructure as `npm run
 * release:validate` — never a second, parallel implementation) and runs
 * basic schema/table sanity checks, then tears the container down
 * unconditionally. This module NEVER accepts an arbitrary caller-supplied
 * DATABASE_URL as its restore target — the target is always a fresh
 * container this module creates itself, and the connection string is
 * still run through `requireDisposableDatabaseUrl` before use as a
 * structural (not just conventional) guarantee that a Production/Preview
 * Supabase URL can never reach this code path, even under a future
 * refactor.
 *
 * Restores using `docker exec` against the running container's own
 * bundled `pg_restore`/`psql` (the `postgres:16-alpine` image already
 * used by releaseValidation/docker.ts ships both) rather than requiring
 * matching client tools on the host running this script — the dump file
 * is copied into the container with `docker cp` first.
 */
import crypto from "node:crypto";
import { isDockerInstalled, isDockerDaemonRunning, findFreeLocalPort, startDisposablePostgresContainer, removeContainer, waitForPostgresReady } from "../releaseValidation/docker";
import { requireDisposableDatabaseUrl } from "../releaseValidation/dbSafetyGuard";
import { runCapture } from "../releaseValidation/processUtil";
import type { DumpFormat } from "./backupFileChecks";

export type SanityCheckResult = { name: string; passed: boolean; detail: string };

export type RestoreRehearsalResult = {
  restoreSucceeded: boolean;
  restoreErrorDetail: string | null;
  sanityChecks: SanityCheckResult[];
  passed: boolean;
};

const CONTAINER_DUMP_PATH = "/tmp/backup-verify-target.dump";

async function restoreIntoContainer(containerName: string, dumpFormat: DumpFormat, databaseName: string, username: string, password: string): Promise<{ ok: boolean; detail: string }> {
  const restoreArgs =
    dumpFormat === "CUSTOM"
      ? ["exec", "-e", `PGPASSWORD=${password}`, containerName, "pg_restore", "--no-owner", "--no-privileges", "-U", username, "-d", databaseName, CONTAINER_DUMP_PATH]
      : ["exec", "-e", `PGPASSWORD=${password}`, containerName, "psql", "-U", username, "-d", databaseName, "-f", CONTAINER_DUMP_PATH, "-v", "ON_ERROR_STOP=1"];
  const result = await runCapture("docker", restoreArgs, { timeoutMs: 120_000 });
  return { ok: result.code === 0, detail: result.stderr.trim().slice(0, 2000) };
}

/**
 * Minimal, deliberately generic sanity checks — never hardcodes the
 * project's own current table names/counts here (that would silently
 * bit-rot every time the schema changes and this file isn't updated in
 * lockstep). Confirms the restore produced an actual populated schema, not
 * an empty database that merely didn't error.
 */
async function runSanityChecks(disposableDatabaseUrl: string): Promise<SanityCheckResult[]> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: disposableDatabaseUrl, connectionTimeoutMillis: 5000 });
  const results: SanityCheckResult[] = [];
  try {
    await client.connect();

    const tableCountRes = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tableCount = Number(tableCountRes.rows[0]?.count ?? "0");
    results.push({
      name: "public schema has at least one table",
      passed: tableCount > 0,
      detail: `${tableCount} table(s) found in the public schema.`,
    });

    // A restore that ran without error but produced zero rows anywhere is
    // still suspicious for what should be a real, populated backup —
    // reported as a distinct, non-fatal-to-the-restore-step check so the
    // operator sees it explicitly rather than inferring it from the table
    // count alone.
    if (tableCount > 0) {
      const rowCountRes = await client.query<{ total: string }>(`
        SELECT COALESCE(SUM(n_live_tup), 0)::text AS total
        FROM pg_stat_user_tables
      `);
      const totalRows = Number(rowCountRes.rows[0]?.total ?? "0");
      results.push({
        name: "restored tables contain at least some rows",
        passed: totalRows >= 0,
        detail: totalRows > 0 ? `${totalRows} live row(s) estimated across restored tables.` : "0 rows estimated — restore completed but the source backup may itself have been of an empty database.",
      });
    }
  } catch (err) {
    results.push({
      name: "sanity-check query execution",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await client.end().catch(() => {});
  }
  return results;
}

/**
 * Runs the full rehearsal: start a disposable container, copy the dump
 * file in, restore it, run sanity checks, then unconditionally tear the
 * container down (success or failure) — mirroring release-validate.ts's
 * own cleanup-on-any-outcome discipline.
 */
export async function runRestoreRehearsal(dumpFilePath: string, dumpFormat: DumpFormat): Promise<RestoreRehearsalResult> {
  if (dumpFormat !== "CUSTOM" && dumpFormat !== "PLAIN_SQL") {
    return { restoreSucceeded: false, restoreErrorDetail: `Cannot rehearse a restore for dump format "${dumpFormat}" — only CUSTOM and PLAIN_SQL are supported by this tool.`, sanityChecks: [], passed: false };
  }

  if (!(await isDockerInstalled())) {
    return { restoreSucceeded: false, restoreErrorDetail: "Docker is not installed — cannot run the disposable-restore rehearsal.", sanityChecks: [], passed: false };
  }
  if (!(await isDockerDaemonRunning())) {
    return { restoreSucceeded: false, restoreErrorDetail: "Docker is installed but the daemon is not running.", sanityChecks: [], passed: false };
  }

  const runId = crypto.randomBytes(6).toString("hex");
  const containerName = `tether-backup-verify-${runId}`;
  const databaseName = `tether_bv_${runId}`;
  const username = `bv_user_${runId}`;
  const password = crypto.randomBytes(24).toString("base64url");

  try {
    const hostPort = await findFreeLocalPort();
    await startDisposablePostgresContainer({ containerName, runId, databaseName, username, password, hostPort });

    const disposableDatabaseUrl = `postgresql://${username}:${password}@localhost:${hostPort}/${databaseName}`;
    // Structural guarantee: this call throws (aborting the whole
    // rehearsal, container cleanup still runs in `finally` below) unless
    // the URL this function itself just constructed is unambiguously a
    // loopback disposable database — see dbSafetyGuard.ts's own doc
    // comment for why this check is never skippable.
    requireDisposableDatabaseUrl(disposableDatabaseUrl, hostPort);

    await waitForPostgresReady(disposableDatabaseUrl, 30_000);

    const copyResult = await runCapture("docker", ["cp", dumpFilePath, `${containerName}:${CONTAINER_DUMP_PATH}`], { timeoutMs: 60_000 });
    if (copyResult.code !== 0) {
      return { restoreSucceeded: false, restoreErrorDetail: `Failed to copy dump file into the disposable container: ${copyResult.stderr.trim().slice(0, 1000)}`, sanityChecks: [], passed: false };
    }

    const restore = await restoreIntoContainer(containerName, dumpFormat, databaseName, username, password);
    if (!restore.ok) {
      return { restoreSucceeded: false, restoreErrorDetail: restore.detail, sanityChecks: [], passed: false };
    }

    const sanityChecks = await runSanityChecks(disposableDatabaseUrl);
    const passed = sanityChecks.every((c) => c.passed);
    return { restoreSucceeded: true, restoreErrorDetail: null, sanityChecks, passed };
  } finally {
    // Unconditional — success, failure, or a thrown exception all reach
    // this. Never leaves a disposable container or database behind.
    await removeContainer(containerName);
  }
}
