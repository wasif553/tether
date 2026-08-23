#!/usr/bin/env -S npx tsx
/**
 * `npm run backup:create -- [--execute --environment <label> --output-dir <path>
 * [--confirm-production] [--source-project-ref <ref>] [--pg-schema <name>]]`
 *
 * See docs/database-backup-operations-v1.md for the full operator
 * runbook this tool supports. This tool CREATES a logical database
 * backup bundle only — it never restores anything (see
 * `npm run backup:verify-bundle` / `npm run backup:verify` for
 * verification and restore rehearsal) and is never invoked
 * automatically by anything else in this repo — no cron, no route, no
 * build step.
 *
 * DEFAULT (no `--execute`) is DRY RUN / INFORMATION ONLY: prints what
 * would happen, contacts no database, starts no Docker container.
 * `--execute` additionally requires `--environment <label>` and
 * `--output-dir <path>` explicitly — there is no default environment or
 * default output location. `--environment production` additionally
 * requires `--confirm-production` — this is never inferred from the
 * connection string; a non-"production" label is trusted as the
 * operator's own deliberate statement, exactly as instructed by this
 * tool's own task specification ("do not infer Production merely
 * because DATABASE_URL exists").
 *
 * Connects to `BACKUP_SOURCE_DATABASE_URL` (preferred — a dedicated,
 * clearly-named variable distinct from the application's own runtime
 * `DATABASE_URL` pool) or falls back to `DATABASE_URL` if that is unset.
 * The raw connection string is parsed once (scripts/backupCreation/connectionRedaction.ts)
 * and is NEVER logged, NEVER written to the manifest, and NEVER appears
 * in this tool's own console output — only a redacted `host:port/database`
 * description is ever printed. Subprocess stderr is redacted before
 * being logged or stored, in case a subprocess ever echoed the
 * connection string back (e.g. in a "connection refused" message).
 *
 * MECHANISM: `pg_dump`/`pg_dumpall` are run inside a throwaway,
 * unconfigured "toolbox" Docker container (the same `postgres:16-alpine`
 * image `npm run release:validate`/`npm run backup:verify --restore`
 * already use) purely for its bundled client binaries — the container
 * itself is never used as a database target. This means the operator
 * does not need `pg_dump`/`pg_dumpall` installed on their own machine,
 * only Docker (which every other tool in this repo's release/backup
 * tooling already requires).
 *
 * OUTPUT: a bundle DIRECTORY, never one ambiguous unnamed file —
 * `roles.sql`, `schema.sql`, `data.sql`, `manifest.json`. Written first
 * under a `.<name>.inprogress` temp name and only renamed to its final
 * name once every stage succeeds — a failed or interrupted run can
 * never look like a valid, COMPLETE bundle (see
 * scripts/backupCreation/backupBundleManifest.ts).
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDockerInstalled, isDockerDaemonRunning, findFreeLocalPort, startDisposablePostgresContainer, removeContainer } from "./releaseValidation/docker";
import { runCapture } from "./releaseValidation/processUtil";
import { parseBackupSourceUrl, describeConnectionTargetSafely, deriveSupabaseProjectRefSafely, redactConnectionStrings, type ParsedBackupSourceConnection } from "./backupCreation/connectionRedaction";
import { assertSafeBackupOutputPath, DEDICATED_LOCAL_BACKUP_DIR } from "./backupCreation/outputPathSafety";
import { computeFileSha256 } from "./backupVerification/backupFileChecks";
import { newInProgressManifest, writeBundleManifest, type BackupBundleManifest, type BackupBundleFileEntry } from "./backupCreation/backupBundleManifest";
import { parseBackupCreateArgs, checkBackupCreateExecuteSafety, type ParsedBackupCreateArgs } from "./backupCreation/cliArgs";

function log(message: string): void {
  console.log(`[backup:create] ${redactConnectionStrings(message)}`);
}

function printDryRunInfo(args: ParsedBackupCreateArgs): void {
  log("Mode: DRY RUN / INFORMATION ONLY — no database will be contacted, no Docker container will be started.");
  log("This command creates a logical database backup BUNDLE (roles.sql, schema.sql, data.sql, manifest.json) from BACKUP_SOURCE_DATABASE_URL (preferred) or DATABASE_URL (fallback) — it never restores anything.");
  log("To actually create a backup, pass: --execute --environment <label> --output-dir <path>");
  log('If --environment production, an additional --confirm-production flag is required — this is never inferred from the connection string.');
  log(`Environment label supplied: ${args.environment ?? "(none)"}`);
  log(`Output directory supplied: ${args.outputDir ?? "(none)"}`);
  log(`Output directory must be an explicit external path, or the dedicated "${DEDICATED_LOCAL_BACKUP_DIR}/" directory inside this repository (gitignored) — no other repository-tracked path is permitted.`);
  log(`This does NOT create a backup of Supabase Storage object bytes — database backups and evidence-storage recovery are separate domains (see docs/backup-and-disaster-recovery-runbook-v1.md, Sections 9-10).`);
}

async function readToolVersion(repoRoot: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function readRepositoryCommit(): Promise<string | null> {
  const result = await runCapture("git", ["rev-parse", "HEAD"], { timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  const commit = result.stdout.trim();
  return commit.length > 0 ? commit : null;
}

async function hashFile(filePath: string): Promise<BackupBundleFileEntry> {
  const stats = await fs.stat(filePath);
  const sha256 = await computeFileSha256(filePath);
  return { filename: path.basename(filePath), byteSize: stats.size, sha256 };
}

/** Runs a pg_dump/pg_dumpall command inside the toolbox container, connecting OUT to the real backup source via PG* environment variables (never a connection string on the command line, never logged). */
async function execInToolbox(toolboxContainerName: string, source: ParsedBackupSourceConnection, commandArgs: string[]): Promise<{ ok: boolean; detail: string }> {
  const args = ["exec", "-e", `PGHOST=${source.hostname}`, "-e", `PGPORT=${source.port}`, "-e", `PGUSER=${source.username}`, "-e", `PGPASSWORD=${source.password}`, "-e", `PGDATABASE=${source.database}`, toolboxContainerName, ...commandArgs];
  const result = await runCapture("docker", args, { timeoutMs: 300_000 });
  return { ok: result.code === 0, detail: redactConnectionStrings(result.stderr.trim().slice(0, 2000)) };
}

async function main(): Promise<void> {
  const args = parseBackupCreateArgs(process.argv.slice(2));

  if (!args.execute) {
    printDryRunInfo(args);
    process.exitCode = 0;
    return;
  }

  const safety = checkBackupCreateExecuteSafety(args);
  if (!safety.ok) {
    log(`Refusing to execute: ${safety.reason}`);
    process.exitCode = 1;
    return;
  }

  const repoRoot = path.resolve(__dirname, "..");
  const pathSafety = assertSafeBackupOutputPath(args.outputDir!, repoRoot);
  if (!pathSafety.ok) {
    log(`Refusing to execute: ${pathSafety.reason}`);
    process.exitCode = 1;
    return;
  }

  const rawSourceUrl = process.env.BACKUP_SOURCE_DATABASE_URL || process.env.DATABASE_URL;
  if (!rawSourceUrl) {
    log("Refusing to execute: neither BACKUP_SOURCE_DATABASE_URL nor DATABASE_URL is set in the environment.");
    process.exitCode = 1;
    return;
  }
  const source = parseBackupSourceUrl(rawSourceUrl);
  if (!source) {
    log("Refusing to execute: the configured backup-source connection string could not be parsed as a postgres:// / postgresql:// URL.");
    process.exitCode = 1;
    return;
  }
  log(`Backup source (redacted): ${describeConnectionTargetSafely(source)}`);
  log(`Environment label: ${args.environment} | pg schema: ${args.pgSchema}`);

  if (!(await isDockerInstalled())) {
    log("Docker is not installed — required to run pg_dump/pg_dumpall inside a throwaway toolbox container.");
    process.exitCode = 1;
    return;
  }
  if (!(await isDockerDaemonRunning())) {
    log("Docker is installed but the daemon is not running.");
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const backupId = now.toISOString().replace(/[:.]/g, "-");
  const outputRoot = path.resolve(args.outputDir!);
  await fs.mkdir(outputRoot, { recursive: true });
  const tmpDirName = `.database-backup-${backupId}.inprogress`;
  const tmpDirPath = path.join(outputRoot, tmpDirName);
  await fs.mkdir(tmpDirPath, { recursive: true });

  const sourceProjectRef = args.sourceProjectRef ?? deriveSupabaseProjectRefSafely(source);
  const toolVersion = await readToolVersion(repoRoot);
  const repositoryCommit = await readRepositoryCommit();

  let manifest: BackupBundleManifest = newInProgressManifest({
    backupId,
    createdAt: now,
    sourceEnvironmentLabel: args.environment!,
    sourceProjectRef,
    toolVersion,
    repositoryCommit,
  });
  await writeBundleManifest(tmpDirPath, manifest);

  const runId = crypto.randomBytes(6).toString("hex");
  const toolboxContainerName = `tether-backup-create-toolbox-${runId}`;
  // The toolbox container's own database/credentials are never used —
  // only its bundled pg_dump/pg_dumpall binaries, invoked via `docker
  // exec` connecting OUT to the real backup source. A throwaway
  // password is still required by the postgres:16-alpine image's own
  // startup, so a random one is generated and immediately irrelevant.
  const toolboxDbName = `unused_toolbox_${runId}`;
  const toolboxUser = `toolbox_user_${runId}`;
  const toolboxPassword = crypto.randomBytes(24).toString("base64url");

  async function fail(reason: string): Promise<void> {
    manifest = { ...manifest, status: "FAILED", failureDetail: redactConnectionStrings(reason).slice(0, 4000) };
    await writeBundleManifest(tmpDirPath, manifest);
    const failedDirPath = path.join(outputRoot, `database-backup-${backupId}.FAILED`);
    await fs.rename(tmpDirPath, failedDirPath);
    log(`Backup FAILED: ${reason}`);
    log(`Diagnostic bundle preserved (never silently deleted) at: ${failedDirPath}`);
  }

  try {
    const toolboxPort = await findFreeLocalPort();
    await startDisposablePostgresContainer({ containerName: toolboxContainerName, runId, databaseName: toolboxDbName, username: toolboxUser, password: toolboxPassword, hostPort: toolboxPort });

    const rolesResult = await execInToolbox(toolboxContainerName, source, ["pg_dumpall", "--roles-only", "-f", "/tmp/roles.sql"]);
    if (!rolesResult.ok) {
      await fail(`pg_dumpall --roles-only failed: ${rolesResult.detail}`);
      process.exitCode = 1;
      return;
    }
    // --clean --if-exists: pg_dump's schema-only output for a named schema
    // (e.g. "public") includes a CREATE SCHEMA statement — every fresh
    // Postgres database already has its own "public" schema, so restoring
    // this dump into a fresh/disposable target would otherwise fail with
    // "schema already exists" on that one line. --clean/--if-exists makes
    // the dump idempotent (DROP IF EXISTS ... CASCADE before each CREATE)
    // against both a fresh target and one that already has prior content
    // from an earlier restore attempt — the correct behaviour for a
    // disaster-recovery restore, which is expected to replace whatever is
    // at the target, not merge with it.
    const schemaResult = await execInToolbox(toolboxContainerName, source, ["pg_dump", "--schema-only", "--schema", args.pgSchema, "--clean", "--if-exists", "-f", "/tmp/schema.sql"]);
    if (!schemaResult.ok) {
      await fail(`pg_dump --schema-only failed: ${schemaResult.detail}`);
      process.exitCode = 1;
      return;
    }
    const dataResult = await execInToolbox(toolboxContainerName, source, ["pg_dump", "--data-only", "--schema", args.pgSchema, "-f", "/tmp/data.sql"]);
    if (!dataResult.ok) {
      await fail(`pg_dump --data-only failed: ${dataResult.detail}`);
      process.exitCode = 1;
      return;
    }

    for (const [key, filename] of [
      ["roles", "roles.sql"],
      ["schema", "schema.sql"],
      ["data", "data.sql"],
    ] as const) {
      const copyResult = await runCapture("docker", ["cp", `${toolboxContainerName}:/tmp/${filename}`, path.join(tmpDirPath, filename)], { timeoutMs: 60_000 });
      if (copyResult.code !== 0) {
        await fail(`Failed to copy ${filename} out of the toolbox container: ${copyResult.stderr.trim().slice(0, 1000)}`);
        process.exitCode = 1;
        return;
      }
      const entry = await hashFile(path.join(tmpDirPath, filename));
      manifest = { ...manifest, files: { ...manifest.files, [key]: entry } };
      await writeBundleManifest(tmpDirPath, manifest);
      log(`  ${filename}: ${entry.byteSize} bytes, sha256 ${entry.sha256}`);
    }

    manifest = { ...manifest, status: "COMPLETE" };
    await writeBundleManifest(tmpDirPath, manifest);

    const finalDirPath = path.join(outputRoot, `database-backup-${backupId}`);
    await fs.rename(tmpDirPath, finalDirPath);

    log(`Backup COMPLETE: ${finalDirPath}`);
    log(`Verify it with: npm run backup:verify-bundle -- ${finalDirPath}`);
    process.exitCode = 0;
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await removeContainer(toolboxContainerName);
  }
}

main().catch((err) => {
  log(`Unexpected error: ${redactConnectionStrings(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
});
