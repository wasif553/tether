/**
 * Production database backup creation v1 — passwordless Supabase CLI
 * database URL builder. See docs/database-backup-operations-v1.md and
 * supabaseCliExecutor.ts's own doc comment.
 *
 * The pinned Supabase CLI's `db dump --db-url <url>` ultimately parses
 * that URL with a libpq-compatible connection-string parser
 * (`pgconn.ParseConfig`), which honours the normal PG* environment
 * variables — including `PGPASSWORD` — whenever the URL itself supplies
 * no password. **Verified directly against this repository's own pinned
 * CLI (`supabase` devDependency, currently 2.115.0) against a disposable
 * local Postgres container** — see
 * docs/database-backup-operations-v1.md's "Current status" section for
 * the exact result (`SUPABASE_CLI_DIRECT_RUNTIME_TEST: PASS`). This
 * module builds that PASSWORDLESS url — safe to appear in this
 * process's own subprocess argv — from the raw backup-source connection
 * string; the real password is never passed here, only through the CLI
 * subprocess's own `PGPASSWORD` environment variable (see
 * supabaseCliExecutor.ts).
 *
 * Allowlist, not denylist, for query parameters (mirrors
 * manifestMetadataValidation.ts's own reasoning): only a small,
 * explicitly-reviewed set of connection parameters is preserved. Any
 * OTHER query parameter — including credential/file-redirection ones
 * like `passfile`/`servicefile`/`sslpassword`/`sslkey`/`sslcert` — causes
 * this function to refuse outright rather than silently stripping or
 * silently passing through a parameter this module has not reviewed.
 */

export type SafeCliDatabaseUrlResult = { ok: true; url: string } | { ok: false; reason: string };

/** The one query parameter this module has reviewed and preserves — current Supabase guidance requires TLS for a Production connection. */
const ALLOWED_QUERY_PARAM_KEYS: ReadonlySet<string> = new Set(["sslmode"]);

/**
 * Builds a PASSWORDLESS connection URL suitable for the Supabase CLI's
 * `--db-url` flag from a raw `postgres://`/`postgresql://` connection
 * string. The password (if any) is stripped entirely — the caller is
 * responsible for supplying it to the CLI subprocess via `PGPASSWORD`
 * instead (see `supabaseCliExecutor.ts`). Fails closed (returns `{ ok:
 * false }`, never throws, never silently drops an unreviewed parameter)
 * on anything malformed or carrying a query parameter outside the
 * reviewed allowlist above.
 */
export function buildPasswordlessSupabaseCliDatabaseUrl(rawUrl: string): SafeCliDatabaseUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "the source connection string is not a well-formed URL" };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, reason: "the source connection string is not a postgres:// / postgresql:// URL" };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: "the source connection string is missing a hostname" };
  }
  if (!parsed.username) {
    return { ok: false, reason: "the source connection string is missing a username" };
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    return { ok: false, reason: "the source connection string is missing a database name" };
  }

  const disallowedKeys = [...parsed.searchParams.keys()].filter((key) => !ALLOWED_QUERY_PARAM_KEYS.has(key.toLowerCase()));
  if (disallowedKeys.length > 0) {
    return {
      ok: false,
      reason: `the source connection string has connection parameter(s) not on this tool's reviewed allowlist (${[...ALLOWED_QUERY_PARAM_KEYS].join(", ")}): ${disallowedKeys.join(", ")}`,
    };
  }

  parsed.password = "";
  return { ok: true, url: parsed.toString() };
}
