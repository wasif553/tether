/**
 * Production database backup creation v1 — output-directory safety
 * guard. See docs/database-backup-operations-v1.md.
 *
 * Pure, dependency-free, synchronous (path arithmetic only — no
 * filesystem access). Fails closed: any output path that resolves
 * inside this repository is refused UNLESS it is under the one
 * dedicated, gitignored local-backup directory. An explicit path
 * outside the repository entirely is always allowed — the operator's
 * own responsibility once it leaves this repo's tree.
 *
 * This exists so `npm run backup:create` cannot, even by a careless
 * `--output-dir` typo, write a backup bundle into a tracked path where
 * an ordinary `git add .` could accidentally stage and commit it.
 */
import path from "node:path";

/** The one directory inside the repository this tool will ever write a backup into — see .gitignore. */
export const DEDICATED_LOCAL_BACKUP_DIR = ".local-backups";

export type OutputPathSafetyResult = { ok: true } | { ok: false; reason: string };

/**
 * `outputDir` may be relative or absolute; `repoRoot` should be this
 * repository's root (the caller resolves it, e.g. via `path.resolve(__dirname, "..")`
 * from a script under `scripts/`).
 */
export function assertSafeBackupOutputPath(outputDir: string, repoRoot: string): OutputPathSafetyResult {
  const resolvedOutput = path.resolve(outputDir);
  const resolvedRoot = path.resolve(repoRoot);
  const relative = path.relative(resolvedRoot, resolvedOutput);

  const isOutsideRepo = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (isOutsideRepo) {
    return { ok: true };
  }

  if (relative === "") {
    return {
      ok: false,
      reason: `Refusing to write a backup directly into the repository root. Use an explicit path outside the repository, or "${DEDICATED_LOCAL_BACKUP_DIR}/".`,
    };
  }

  const firstSegment = relative.split(path.sep)[0];
  if (firstSegment === DEDICATED_LOCAL_BACKUP_DIR) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Refusing to write a backup inside tracked repository path "${firstSegment}${path.sep}" — this could be accidentally committed. Use an explicit path outside the repository, or "${DEDICATED_LOCAL_BACKUP_DIR}/".`,
  };
}
