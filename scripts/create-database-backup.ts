#!/usr/bin/env -S npx tsx
/**
 * `npm run backup:create -- [--execute --environment <label> --output-dir <path>
 * [--confirm-production] [--source-project-ref <ref>] [--source-type <local-generic|supabase-managed>]
 * [--pg-schema <name>]]`
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
 * `--execute` additionally requires a VALID `--environment <label>` and
 * `--output-dir <path>` explicitly — there is no default environment or
 * default output location. `--environment` (in ANY case/whitespace
 * variant of "production" — "Production", "PRODUCTION", " production ",
 * "production " all normalise to the one canonical label "production"
 * before this decision is made, see cliArgs.ts/manifestMetadataValidation.ts)
 * additionally requires `--confirm-production` — this is never inferred
 * from the connection string; a non-"production" label is trusted as
 * the operator's own deliberate statement. `--source-project-ref`, if
 * supplied, is validated against a strict alphanumeric-token pattern —
 * a malformed value (e.g. a connection string pasted into the wrong
 * flag) is refused before any backup starts, never silently accepted.
 *
 * Connects to `BACKUP_SOURCE_DATABASE_URL` (preferred — a dedicated,
 * clearly-named variable distinct from the application's own runtime
 * `DATABASE_URL` pool) or falls back to `DATABASE_URL` if that is unset.
 * The raw connection string is parsed once (scripts/backupCreation/connectionRedaction.ts)
 * and is NEVER logged, NEVER written to the manifest, and NEVER appears
 * in this tool's own console output — only a redacted `host:port/database`
 * description is ever printed. Subprocess stderr is redacted before
 * being logged or stored, in case a subprocess ever echoed the
 * connection string back (e.g. in a "connection refused" message). The
 * source PASSWORD never appears in this process's own subprocess argv
 * either — see scripts/backupCreation/dockerExecInvocation.ts's own doc
 * comment for the bare-name `-e PGPASSWORD` / child-process-environment
 * mechanism this uses instead of `-e PGPASSWORD=<value>`.
 *
 * MECHANISM: dump commands run inside a throwaway, unconfigured
 * "toolbox" Docker container (the same `postgres:16-alpine` image
 * `npm run release:validate`/`npm run backup:verify --restore` already
 * use) purely for its bundled client binaries — the container itself is
 * never used as a database target. This means the operator does not
 * need `pg_dump`/`pg_dumpall`/the Supabase CLI installed on their own
 * machine, only Docker.
 *
 * SOURCE ADAPTER: which dump commands actually run is decided by
 * scripts/backupCreation/sourceAdapters.ts — `local-generic` (raw
 * `pg_dump`/`pg_dumpall`, the path exercised end to end against
 * synthetic local data in this pass) or `supabase-managed` (the
 * Supabase CLI's own `supabase db dump`, which applies Supabase's own
 * managed-schema/reserved-role/Storage-vector-table filtering — **not
 * runtime-tested in this pass, see that module's own
 * SUPABASE_MANAGED_SOURCE_RUNTIME_TEST: DEFERRED note**). Auto-detected
 * from whether a Supabase project reference is known (explicit or
 * derived); overridable with `--source-type`.
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
import { buildContainerExecInvocation } from "./backupCreation/dockerExecInvocation";
import { resolveSourceAdapter, autoDetectSourceAdapterKind, type SourceAdapterKind } from "./backupCreation/sourceAdapters";

function log(message: string): void {
  console.log(`[backup:create] ${redactConnectionStrings(message)}`);
}

function printDryRunInfo(args: ParsedBackupCreateArgs): void {
  log("Mode: DRY RUN / INFORMATION ONLY — no database will be contacted, no Docker container will be started.");
  log("This command creates a logical database backup BUNDLE (roles.sql, schema.sql, data.sql, manifest.json) from BACKUP_SOURCE_DATABASE_URL (preferred) or DATABASE_URL (fallback) — it never restores anything.");
  log("To actually create a backup, pass: --execute --environment <label> --output-dir <path>");
  log('If --environment is "production" (any case/whitespace variant), an additional --confirm-production flag is required — this is never inferred from the connection string.');
  log(`Environment label supplied: ${args.environment ?? "(none)"}`);
  log(`Output directory supplied: ${args.outputDir ?? "(none)"}`);
  log(`Output directory must be an explicit external path, or the dedicated "${DEDICATED_LOCAL_BACKUP_DIR}/" directory inside this repository (gitignored) — no other repository-tracked path is permitted.`);
  log(`Source adapter: auto-detected from a Supabase project reference (explicit --source-project-ref or derived from the connection string) unless --source-type overrides it. See scripts/backupCreation/sourceAdapters.ts — the "supabase-managed" adapter is NOT runtime-tested in this pass.`);
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

/**
 * Runs a dump-stage command inside the toolbox container, connecting
 * OUT to the real backup source. The visible `docker exec` argument
 * list contains only PG* environment-variable NAMES, never the actual
 * values — see dockerExecInvocation.ts's own doc comment for the
 * bare-name-forwarding mechanism this relies on.
 */
async function execInToolbox(toolboxContainerName: string, source: ParsedBackupSourceConnection, commandArgs: readonly string[]): Promise<{ ok: boolean; detail: string }> {
  const invocation = buildContainerExecInvocation(toolboxContainerName, source, commandArgs);
  // Cast: ExecEnv is intentionally the wider Record<string, string | undefined>
  // (see dockerExecInvocation.ts's own doc comment) so that module stays
  // easy to unit-test with a minimal base env; NodeJS.ProcessEnv's extra
  // required fields (e.g. NODE_ENV, from Next.js's own global
  // augmentation) are a TypeScript-only formality here — at runtime this
  // is always built from `...process.env` plus the PG* overrides, which
  // already has NODE_ENV set.
  const result = await runCapture("docker", invocation.args, { timeoutMs: 300_000, env: invocation.env as NodeJS.ProcessEnv });
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
  // From here on, use the VALIDATED, canonical values — never the raw
  // operator-typed args.environment/args.sourceProjectRef.
  const environment = safety.environment!;

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
  log(`Environment label: ${environment} | pg schema: ${args.pgSchema}`);

  const sourceProjectRef = safety.sourceProjectRef ?? deriveSupabaseProjectRefSafely(source);
  const sourceAdapterKind: SourceAdapterKind = (args.sourceType as SourceAdapterKind | null) ?? autoDetectSourceAdapterKind(sourceProjectRef);
  const sourceAdapter = resolveSourceAdapter(sourceAdapterKind);
  log(`Source adapter: ${sourceAdapter.kind}${sourceAdapter.kind === "supabase-managed" ? " (NOT runtime-tested against a real Supabase CLI/project in this pass — see docs/database-backup-operations-v1.md)" : ""}`);

  if (!(await isDockerInstalled())) {
    log("Docker is not installed — required to run dump commands inside a throwaway toolbox container.");
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

  const toolVersion = await readToolVersion(repoRoot);
  const repositoryCommit = await readRepositoryCommit();

  let manifest: BackupBundleManifest = newInProgressManifest({
    backupId,
    createdAt: now,
    sourceEnvironmentLabel: environment,
    sourceProjectRef,
    toolVersion,
    repositoryCommit,
  });
  await writeBundleManifest(tmpDirPath, manifest);

  const runId = crypto.randomBytes(6).toString("hex");
  const toolboxContainerName = `tether-backup-create-toolbox-${runId}`;
  // The toolbox container's own database/credentials are never used —
  // only its bundled client binaries, invoked via `docker exec`
  // connecting OUT to the real backup source. A throwaway password is
  // still required by the postgres:16-alpine image's own startup, so a
  // random one is generated and immediately irrelevant.
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

    const rolesCommand = sourceAdapter.rolesDumpCommand("/tmp/roles.sql");
    const rolesResult = await execInToolbox(toolboxContainerName, source, rolesCommand.commandArgs);
    if (!rolesResult.ok) {
      await fail(`Roles dump (${sourceAdapter.kind}) failed: ${rolesResult.detail}`);
      process.exitCode = 1;
      return;
    }

    const schemaCommand = sourceAdapter.schemaDumpCommand(args.pgSchema, "/tmp/schema.sql");
    const schemaResult = await execInToolbox(toolboxContainerName, source, schemaCommand.commandArgs);
    if (!schemaResult.ok) {
      await fail(`Schema dump (${sourceAdapter.kind}) failed: ${schemaResult.detail}`);
      process.exitCode = 1;
      return;
    }

    const dataCommand = sourceAdapter.dataDumpCommand(args.pgSchema, "/tmp/data.sql");
    const dataResult = await execInToolbox(toolboxContainerName, source, dataCommand.commandArgs);
    if (!dataResult.ok) {
      await fail(`Data dump (${sourceAdapter.kind}) failed: ${dataResult.detail}`);
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
