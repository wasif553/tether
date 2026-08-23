/**
 * Production database backup creation v1 — connection-string parsing and
 * redaction. See docs/database-backup-operations-v1.md.
 *
 * Pure, dependency-free, synchronous — no network access, no Docker, no
 * filesystem. The ONE place a raw Postgres connection string is parsed
 * for `scripts/create-database-backup.ts`, so every caller gets the same
 * redaction behaviour rather than a second, possibly-inconsistent copy.
 *
 * Nothing exported here ever returns the raw password. Every "safe to
 * log" helper below is deliberately named to make it obvious at the call
 * site that it is safe — there is no ambiguous "toString()" that could
 * accidentally leak a secret.
 */

/** Matches any postgres://... or postgresql://... URL (with or without embedded credentials) so it can be scrubbed from arbitrary text — e.g. a subprocess's stderr, which could otherwise echo back a connection string this tool passed it. */
const CONNECTION_STRING_PATTERN = /postgres(?:ql)?:\/\/[^\s"'`]+/gi;

/** Scrubs any raw connection string out of arbitrary text before it is ever logged, stored, or included in a manifest/error. Idempotent and safe to call on text that contains no connection string at all. */
export function redactConnectionStrings(text: string): string {
  return text.replace(CONNECTION_STRING_PATTERN, "postgres://[REDACTED]");
}

export type ParsedBackupSourceConnection = {
  protocol: string;
  hostname: string;
  port: string;
  username: string;
  /** Present only so it can be handed to a subprocess via an environment variable — never returned by any "safe" describer below, never logged, never written to a manifest. */
  password: string;
  database: string;
};

/** Returns null (never throws) for anything that isn't a well-formed postgres://.../postgresql://... URL — a caller decides how to report that as a configuration error without ever having handled a partially-parsed secret. */
export function parseBackupSourceUrl(rawUrl: string): ParsedBackupSourceConnection | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
  return {
    protocol: parsed.protocol,
    hostname: decodeURIComponent(parsed.hostname).replace(/^\[/, "").replace(/\]$/, ""),
    port: parsed.port || "5432",
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

/**
 * Safe to log, store in a manifest, or include in an operator-facing
 * message — host, port, and database name only. Never the username
 * (which, for a Supabase pooler connection, may itself embed a project
 * reference — treated the same as a hostname for redaction purposes,
 * i.e. omitted here) and never the password.
 */
export function describeConnectionTargetSafely(parsed: ParsedBackupSourceConnection): string {
  return `${parsed.hostname}:${parsed.port}/${parsed.database}`;
}

const SUPABASE_HOST_PROJECT_REF_PATTERNS = [/^db\.([a-z0-9]+)\.supabase\.co$/i, /^([a-z0-9]+)\.supabase\.co$/i];
const SUPABASE_POOLER_USERNAME_PROJECT_REF_PATTERN = /^postgres\.([a-z0-9]+)$/i;

/**
 * Best-effort, safe derivation of a Supabase project reference from a
 * connection's hostname or pooler username — never from the password,
 * never returning the full hostname/username itself, only the short
 * project-ref token if one of the two well-known Supabase patterns
 * actually matches. Returns null rather than guessing for anything else
 * (a self-hosted Postgres, a non-Supabase host, or a malformed pattern)
 * — this is metadata for the backup manifest, not a security boundary,
 * so a wrong guess would be worse than an honest "unknown."
 */
export function deriveSupabaseProjectRefSafely(parsed: ParsedBackupSourceConnection): string | null {
  for (const pattern of SUPABASE_HOST_PROJECT_REF_PATTERNS) {
    const match = parsed.hostname.match(pattern);
    if (match) return match[1];
  }
  const usernameMatch = parsed.username.match(SUPABASE_POOLER_USERNAME_PROJECT_REF_PATTERN);
  if (usernameMatch) return usernameMatch[1];
  return null;
}

/** Loopback-only check — mirrors scripts/releaseValidation/dbSafetyGuard.ts's own ALLOWED_DATABASE_HOSTS, reimplemented locally (not imported) because that module's guard is deliberately scoped to release-validation's disposable-database use case, not general-purpose hostname classification. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalised = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalised === "localhost" || normalised === "127.0.0.1" || normalised === "::1";
}
