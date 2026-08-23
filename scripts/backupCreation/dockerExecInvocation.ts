/**
 * Production database backup creation v1 — docker-exec invocation
 * builder. See docs/database-backup-operations-v1.md.
 *
 * Pure, dependency-free, synchronous — builds the `args`/`env` pair a
 * caller hands to `runCapture("docker", args, { env })`, but never
 * calls Docker itself, so it can be unit-tested (and its output
 * inspected) without touching a subprocess.
 *
 * `docker exec -e VAR=value ...` puts `value` directly into the host
 * process's own argument vector — visible to any other process on the
 * same machine via an ordinary process listing (`ps aux` on Unix,
 * Task Manager / `Get-CimInstance Win32_Process` on Windows), without
 * needing elevated privileges. For a Production database password,
 * that is an unacceptable exposure.
 *
 * `docker exec -e VAR ...` (bare name, no `=value`) instead tells the
 * Docker CLI to forward the CURRENT VALUE of `VAR` from ITS OWN
 * process environment into the container — a real, documented Docker
 * CLI behaviour. So the actual secret values here travel only through
 * the spawned `docker` child process's environment block (`env` on
 * `child_process.spawn`), which is materially harder for another
 * process to read than an argv listing, and is never part of the
 * `args` array a caller might log.
 */
import type { ParsedBackupSourceConnection } from "./connectionRedaction";

/** A plain string-keyed record, not the global `NodeJS.ProcessEnv` — that type pulls in Next.js's own required-field augmentation (e.g. `NODE_ENV`), which is irrelevant here and makes this module harder to unit-test with a minimal base env. Structurally compatible with what `child_process.spawn`'s own `env` option accepts. */
export type ExecEnv = Record<string, string | undefined>;

export type DockerExecInvocation = {
  /** Safe to log in full — contains only flag names, the container name, and the command being run inside it. Never a secret value. */
  args: string[];
  /** NEVER log this — contains the actual PG* values. Pass only to the spawned child process's own `env` option. */
  env: ExecEnv;
};

const PG_ENV_VAR_NAMES = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"] as const;

/**
 * Builds a `docker exec` invocation that runs `commandArgs` inside
 * `containerName`, connecting to `source` via bare-name `-e PG*` flags
 * (see the module doc comment above) rather than `-e PG*=value`.
 * `baseEnv` defaults to `process.env` and is only ever a base to spread
 * — the returned `env` always carries the actual connection values on
 * top of it.
 */
export function buildContainerExecInvocation(containerName: string, source: ParsedBackupSourceConnection, commandArgs: readonly string[], baseEnv: ExecEnv = process.env): DockerExecInvocation {
  const flagArgs: string[] = [];
  for (const name of PG_ENV_VAR_NAMES) flagArgs.push("-e", name);

  return {
    args: ["exec", ...flagArgs, containerName, ...commandArgs],
    env: {
      ...baseEnv,
      PGHOST: source.hostname,
      PGPORT: source.port,
      PGUSER: source.username,
      PGPASSWORD: source.password,
      PGDATABASE: source.database,
    },
  };
}

/**
 * The disposable-restore-rehearsal equivalent, used where the caller
 * already passes username/database as plain (non-secret) `-U`/`-d`
 * arguments to `psql` itself and only the password needs to avoid
 * argv. The target is always a throwaway container this codebase
 * created itself, with a random password it generated (never a
 * Production secret) — lower risk than `buildContainerExecInvocation`
 * above, but built the same way for consistency, so a future change to
 * one doesn't silently leave the other on the weaker, argv-exposing
 * pattern.
 */
export function buildDisposablePasswordExecInvocation(containerName: string, password: string, commandArgs: readonly string[], baseEnv: ExecEnv = process.env): DockerExecInvocation {
  return {
    args: ["exec", "-e", "PGPASSWORD", containerName, ...commandArgs],
    env: { ...baseEnv, PGPASSWORD: password },
  };
}
