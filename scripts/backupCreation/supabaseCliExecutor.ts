/**
 * Production database backup creation v1 — Supabase-managed source
 * execution boundary. See docs/database-backup-operations-v1.md and
 * sourceAdapters.ts's own doc comment.
 *
 * The `supabase-managed` adapter's commands (`sourceAdapters.ts`) are
 * Supabase CLI argv, not `docker exec` argv — they must run the
 * project-pinned Supabase CLI directly on the HOST, never inside the
 * `postgres:16-alpine` toolbox container (`scripts/releaseValidation/docker.ts`),
 * which provides Postgres client binaries only and does not contain the
 * Supabase CLI runtime at all. This module IS that host execution
 * boundary — `scripts/create-database-backup.ts` never spawns the
 * Supabase CLI itself, only through the functions here.
 *
 * PINNED CLI, NOT AN UNPINNED DOWNLOAD: the Supabase CLI is an explicit
 * `devDependency` (`"supabase"` in package.json, exact-pinned, tracked in
 * package-lock.json) — `resolveSupabaseCliBinaryPath` resolves
 * `node_modules/.bin/supabase[.cmd]`, the binary `npm install` placed
 * there. This deliberately never falls back to `npx supabase` (which
 * would silently download and run whatever the latest published version
 * happens to be at the moment of execution — unpinned, and a supply-chain
 * risk this repository does not accept for a tool that touches a
 * Production credential).
 *
 * READ-ONLY BY CONSTRUCTION — NO `supabase link`: an earlier version of
 * this module ran `supabase link --project-ref <ref>` before dumping.
 * That was withdrawn: `link` is not a guaranteed read-only operation —
 * observed Supabase CLI behaviour includes issuing statements such as
 * `CREATE SCHEMA IF NOT EXISTS supabase_migrations` and `CREATE TABLE IF
 * NOT EXISTS supabase_migrations.schema_migrations ...` (and later CLI
 * versions may also ensure/alter migration-history columns) — a
 * Production database BACKUP tool must not modify Production migration
 * metadata as a side effect of preparing to read it. This module now
 * invokes only two Supabase CLI subcommands anywhere in the backup path:
 * `init` (purely local — writes `supabase/config.toml` into the
 * temporary workspace, contacts no project) and `db dump --db-url ...`
 * (a read/export operation). It never invokes `link`, `db push`, `db
 * pull`, `db reset`, `migration repair`, `migration up`, `config push`,
 * `projects create`/`delete`, or any Storage-mutating command — see
 * `supabaseCliExecutor.test.ts`'s own regression guard for this.
 *
 * CREDENTIAL TRANSPORT: the real source database password is read from
 * the already-parsed backup-source connection and passed to the CLI
 * subprocess only via that subprocess's own `PGPASSWORD` environment
 * variable — never as a CLI flag (`--password`/`-p` would put the value
 * directly in the subprocess's own argv, the same exposure
 * `dockerExecInvocation.ts` exists to avoid for the `local-generic`
 * path) and never embedded in the `--db-url` argument itself (see
 * `supabaseDatabaseUrl.ts`, which builds the PASSWORDLESS url this
 * module passes on argv). The pinned CLI's own `db dump --db-url <url>`
 * honours `PGPASSWORD` via its libpq-compatible connection-string
 * parser whenever the url itself supplies no password — verified
 * directly against this repository's pinned CLI, not merely assumed
 * from documentation (see this module's own doc comment on
 * `runSupabaseManagedDumpSequence` and
 * docs/database-backup-operations-v1.md's "Current status" section for
 * the exact runtime-test result). No `SUPABASE_ACCESS_TOKEN` and no
 * separate `SUPABASE_DB_PASSWORD` environment variable is required for
 * database backup creation — the one authoritative source credential
 * remains `BACKUP_SOURCE_DATABASE_URL` (preferred) /
 * `DATABASE_URL` (fallback), parsed once in
 * `scripts/create-database-backup.ts`.
 *
 * TEMPORARY WORKSPACE: `supabase db dump`/`supabase init` load local CLI
 * config from a Supabase project directory. Every command here runs
 * against `--workdir <dir>`, where `dir` is a fresh `fs.mkdtemp`-created
 * directory OUTSIDE this repository (under the OS temp directory) —
 * never this repository's own working directory, which has no Supabase
 * configuration of its own to protect but must never gain one as a side
 * effect of running a backup. `supabase init --force --yes` populates
 * that directory's own local `supabase/config.toml` — purely local
 * scaffolding, no network contact, no project link, nothing persisted
 * outside the temporary directory. The workspace is removed
 * unconditionally (`finally`) whether the dump sequence succeeds or
 * fails, and is never committed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDockerInstalled, isDockerDaemonRunning } from "../releaseValidation/docker";
import { runCapture } from "../releaseValidation/processUtil";
import { redactConnectionStrings } from "./connectionRedaction";
import { buildPasswordlessSupabaseCliDatabaseUrl } from "./supabaseDatabaseUrl";
import type { DumpStageCommand } from "./sourceAdapters";

export type SupabaseCliPreflightResult = { ok: true; version: string; binaryPath: string } | { ok: false; reason: string };

/** Resolves the pinned Supabase CLI binary from this project's own `node_modules/.bin` — see this module's own doc comment for why this is never an unpinned `npx supabase` invocation. */
export function resolveSupabaseCliBinaryPath(repoRoot: string): string {
  const binName = process.platform === "win32" ? "supabase.cmd" : "supabase";
  return path.join(repoRoot, "node_modules", ".bin", binName);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Confirms the pinned CLI binary is present and reports a version — never contacts any Supabase project. */
export async function preflightSupabaseCli(repoRoot: string): Promise<SupabaseCliPreflightResult> {
  const binaryPath = resolveSupabaseCliBinaryPath(repoRoot);
  if (!(await fileExists(binaryPath))) {
    return {
      ok: false,
      reason: `Supabase CLI binary not found at "${binaryPath}". It is a pinned devDependency (see the "supabase" entry in package.json) — run "npm install", never an ad hoc "npx supabase".`,
    };
  }
  const result = await runCapture(binaryPath, ["--version"], { timeoutMs: 15_000 });
  const version = result.stdout.trim();
  if (result.code !== 0 || version.length === 0) {
    return { ok: false, reason: `Supabase CLI at "${binaryPath}" did not report a version (exit ${result.code ?? "null"}).` };
  }
  return { ok: true, version, binaryPath };
}

export type SupabaseManagedPreflightResult = { ok: true; binaryPath: string; version: string; passwordlessUrl: string; password: string } | { ok: false; reason: string };

/**
 * The full fail-closed preflight for a `supabase-managed` execute —
 * checked BEFORE any temporary workspace is created and before any
 * network contact with a Supabase project:
 *
 * 1. Docker is installed and 2. the daemon is running — `supabase db
 *    dump` uses Docker internally to run its own managed pg_dump
 *    environment, so Docker's absence must fail BEFORE any remote
 *    connection attempt begins, not be discovered partway through.
 * 3. the pinned CLI binary exists and 4. reports a version.
 * 5. the source connection has a non-empty password (needed for
 *    `PGPASSWORD`).
 * 6. a safe, passwordless `--db-url` can be built from the raw source
 *    connection string (`supabaseDatabaseUrl.ts`).
 *
 * (The source connection string's own well-formedness, and the output
 * destination's own path-safety validation, are both already checked
 * once by `scripts/create-database-backup.ts`'s `main()` — shared by
 * both source adapters — before either adapter's own execution begins;
 * this function does not duplicate either check.)
 *
 * Never logs the password. On any failure, the caller must stop before
 * attempting a connection; this function performs no cleanup of its own
 * because it creates nothing.
 */
export async function preflightSupabaseManagedExecution(repoRoot: string, rawSourceUrl: string, sourcePassword: string): Promise<SupabaseManagedPreflightResult> {
  if (!(await isDockerInstalled())) {
    return {
      ok: false,
      reason: "Docker is not installed — the Supabase CLI's own `db dump` runs its own managed pg_dump environment via Docker internally, so Docker must be available before any remote connection is attempted.",
    };
  }
  if (!(await isDockerDaemonRunning())) {
    return { ok: false, reason: "Docker is installed but the daemon is not running — required by the Supabase CLI's own internal `db dump` mechanism." };
  }
  const cli = await preflightSupabaseCli(repoRoot);
  if (!cli.ok) return cli;
  if (!sourcePassword) {
    return { ok: false, reason: "the source database connection has no password — required to authenticate the Supabase CLI's db dump non-interactively via PGPASSWORD." };
  }
  const safeUrl = buildPasswordlessSupabaseCliDatabaseUrl(rawSourceUrl);
  if (!safeUrl.ok) {
    return { ok: false, reason: `could not build a safe, passwordless CLI database URL: ${safeUrl.reason}` };
  }
  return { ok: true, binaryPath: cli.binaryPath, version: cli.version, passwordlessUrl: safeUrl.url, password: sourcePassword };
}

export type SupabaseCliWorkspace = { dir: string };

/** Creates a fresh temporary Supabase CLI workspace OUTSIDE any tracked repository path — see this module's own doc comment. */
export async function createTemporarySupabaseWorkspace(): Promise<SupabaseCliWorkspace> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tether-supabase-backup-"));
  return { dir };
}

/** Unconditional cleanup — safe to call even if the workspace directory is already gone. */
export async function removeTemporarySupabaseWorkspace(workspace: SupabaseCliWorkspace): Promise<void> {
  await fs.rm(workspace.dir, { recursive: true, force: true });
}

/** The shape `runCapture` already satisfies — injectable so this module's orchestration functions can be unit-tested with a fake CLI runner, never a real subprocess or real Supabase project. */
export type SupabaseCliRunner = (binaryPath: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Purely local scaffolding — writes `<workspace>/supabase/config.toml`, contacts no project, links to nothing. `--force` overwrites any pre-existing config in the (fresh) workspace non-interactively; `--yes` answers any other prompt non-interactively. */
export async function runSupabaseInit(binaryPath: string, workspace: SupabaseCliWorkspace, runner: SupabaseCliRunner = runCapture): Promise<{ ok: boolean; detail: string }> {
  const result = await runner(binaryPath, ["init", "--force", "--yes", "--workdir", workspace.dir], { timeoutMs: 30_000 });
  return { ok: result.code === 0, detail: redactConnectionStrings(result.stderr.trim().slice(0, 2000)) };
}

/**
 * Appends `--db-url <passwordlessUrl>` and `--workdir <workspace.dir>`
 * to an adapter-supplied base `db dump` command
 * (`sourceAdapters.ts`'s `supabaseManagedAdapter` never embeds either
 * itself — this is the one place that does, keeping "which dump
 * semantics" and "how/where to connect" cleanly separate). Exported
 * standalone so the exact final argv shape is directly unit-testable
 * without a real subprocess.
 */
export function buildManagedDumpInvocationArgs(baseCommandArgs: readonly string[], passwordlessUrl: string, workspace: SupabaseCliWorkspace): string[] {
  return [...baseCommandArgs, "--db-url", passwordlessUrl, "--workdir", workspace.dir];
}

export type SupabaseManagedDumpSequenceResult = { ok: true } | { ok: false; stage: string; reason: string };

/**
 * Runs `supabase init` (purely local) then each dump stage in order —
 * every dump stage authenticates via `PGPASSWORD` in the subprocess's
 * own environment against the PASSWORDLESS `--db-url` built by
 * `supabaseDatabaseUrl.ts` — all inside one fresh temporary workspace,
 * then removes that workspace unconditionally (`finally` — success or
 * failure). Never `supabase link`, never `--linked`. `password` reaches
 * the subprocess ONLY via its own `env.PGPASSWORD` — never appended to
 * any `args` array this function builds.
 *
 * **`SUPABASE_CLI_DIRECT_RUNTIME_TEST`**: this exact mechanism
 * (temporary workspace → `init` → passwordless `--db-url` + `PGPASSWORD`
 * env → `db dump`) was verified end to end against a disposable local
 * Postgres container using this repository's own pinned CLI (2.115.0) —
 * see docs/database-backup-operations-v1.md's "Current status" section.
 * This function's own unit tests (`supabaseCliExecutor.test.ts`) use an
 * injected fake runner and prove the ORCHESTRATION only (ordering,
 * argv/env shape, cleanup); they do not re-prove the real CLI's own
 * connection behaviour, which the disposable runtime exercise above
 * covers instead.
 */
export async function runSupabaseManagedDumpSequence(binaryPath: string, passwordlessUrl: string, password: string, stages: readonly { key: string; command: DumpStageCommand }[], runner: SupabaseCliRunner = runCapture): Promise<SupabaseManagedDumpSequenceResult> {
  const workspace = await createTemporarySupabaseWorkspace();
  try {
    const initResult = await runSupabaseInit(binaryPath, workspace, runner);
    if (!initResult.ok) {
      return { ok: false, stage: "init", reason: initResult.detail };
    }

    for (const stage of stages) {
      const args = buildManagedDumpInvocationArgs(stage.command.commandArgs, passwordlessUrl, workspace);
      const result = await runner(binaryPath, args, { timeoutMs: 300_000, env: { ...process.env, PGPASSWORD: password } });
      if (result.code !== 0) {
        return { ok: false, stage: stage.key, reason: redactConnectionStrings(result.stderr.trim().slice(0, 2000)) };
      }
    }

    return { ok: true };
  } finally {
    await removeTemporarySupabaseWorkspace(workspace);
  }
}
