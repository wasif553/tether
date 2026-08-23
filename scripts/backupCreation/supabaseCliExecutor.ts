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
 * CREDENTIAL TRANSPORT: `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`
 * are read from this process's OWN environment and passed to the CLI
 * subprocess only via the subprocess's own environment (the default
 * `runCapture(...)` behaviour already inherits `process.env`, so no
 * secret-carrying override is even constructed here) — never as a CLI
 * flag (`--password`/`-p` would put the value directly in the
 * subprocess's own argv, the same exposure `dockerExecInvocation.ts`
 * exists to avoid for the raw-Postgres path). `supabase link
 * --project-ref <ref>` — the one command that establishes which project
 * `--linked` dumps then read from — takes only the already-validated,
 * non-secret `sourceProjectRef` on its own argv.
 *
 * TEMPORARY WORKSPACE: `supabase link` writes local link-state (a
 * `.supabase/`/`supabase/.temp` directory) into whatever directory the
 * CLI is run from. Every command here runs with `cwd` set to a fresh
 * `fs.mkdtemp`-created directory OUTSIDE this repository (under the OS
 * temp directory) — never this repository's own working directory —
 * so the repository's own (nonexistent) Supabase configuration is never
 * touched, and nothing here is ever committed. The workspace is removed
 * unconditionally (`finally`) whether the dump sequence succeeds or
 * fails.
 *
 * READ-ONLY: every command this module runs (`link`, `db dump --linked`)
 * is a read/export operation against the linked project — nothing here
 * pushes migrations, changes remote config, or otherwise mutates the
 * Supabase project itself.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapture } from "../releaseValidation/processUtil";
import { redactConnectionStrings } from "./connectionRedaction";
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

export type SupabaseManagedPreflightResult = { ok: true; binaryPath: string; version: string } | { ok: false; reason: string };

/**
 * The full fail-closed preflight for a `supabase-managed` execute —
 * checked BEFORE any temporary workspace is created, before `supabase
 * link` runs, and before any network contact with a Supabase project.
 * Never logs `SUPABASE_ACCESS_TOKEN` or `SUPABASE_DB_PASSWORD` — only
 * whether each is present. On any failure, the caller must stop before
 * attempting a connection; this function performs no cleanup of its own
 * because it creates nothing.
 */
export async function preflightSupabaseManagedExecution(repoRoot: string, sourceProjectRef: string | null): Promise<SupabaseManagedPreflightResult> {
  if (!sourceProjectRef) {
    return { ok: false, reason: "the supabase-managed source adapter requires a validated --source-project-ref — none was supplied." };
  }
  const cli = await preflightSupabaseCli(repoRoot);
  if (!cli.ok) return cli;
  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    return { ok: false, reason: "SUPABASE_ACCESS_TOKEN is not set in the environment — required to authenticate the Supabase CLI non-interactively." };
  }
  if (!process.env.SUPABASE_DB_PASSWORD) {
    return { ok: false, reason: "SUPABASE_DB_PASSWORD is not set in the environment — required for `supabase link`/`db dump --linked` to run non-interactively." };
  }
  return { ok: true, binaryPath: cli.binaryPath, version: cli.version };
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

/** The shape `runCapture` already satisfies — injectable so `runSupabaseManagedDumpSequence` can be unit-tested with a fake CLI runner, never a real subprocess or real Supabase project. */
export type SupabaseCliRunner = (binaryPath: string, args: string[], options: { timeoutMs?: number; cwd?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type SupabaseManagedDumpSequenceResult = { ok: true } | { ok: false; stage: string; reason: string };

/**
 * Runs `supabase link --project-ref <sourceProjectRef>` then each dump
 * stage in order, all inside one fresh temporary workspace, then removes
 * that workspace unconditionally (`finally` — success or failure). Never
 * builds a custom `env` override: the default `runCapture` behaviour
 * already inherits this process's own environment, which is where
 * `SUPABASE_ACCESS_TOKEN`/`SUPABASE_DB_PASSWORD` live — this module never
 * touches either value directly, so neither can leak into the argv this
 * function constructs (see this module's own doc comment).
 */
export async function runSupabaseManagedDumpSequence(binaryPath: string, sourceProjectRef: string, stages: readonly { key: string; command: DumpStageCommand }[], runner: SupabaseCliRunner = runCapture): Promise<SupabaseManagedDumpSequenceResult> {
  const workspace = await createTemporarySupabaseWorkspace();
  try {
    const linkResult = await runner(binaryPath, ["link", "--project-ref", sourceProjectRef], { timeoutMs: 60_000, cwd: workspace.dir });
    if (linkResult.code !== 0) {
      return { ok: false, stage: "link", reason: redactConnectionStrings(linkResult.stderr.trim().slice(0, 2000)) };
    }

    for (const stage of stages) {
      const result = await runner(binaryPath, [...stage.command.commandArgs], { timeoutMs: 300_000, cwd: workspace.dir });
      if (result.code !== 0) {
        return { ok: false, stage: stage.key, reason: redactConnectionStrings(result.stderr.trim().slice(0, 2000)) };
      }
    }

    return { ok: true };
  } finally {
    await removeTemporarySupabaseWorkspace(workspace);
  }
}
