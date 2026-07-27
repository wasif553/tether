/**
 * Release-validation database safety guard. See docs/release-validation.md.
 *
 * The ONE place a DATABASE_URL is decided to be safe to run schema
 * changes / database-backed tests against, for the `npm run
 * release:validate` workflow. Pure, dependency-free, synchronous — no
 * network access, no Docker, no Prisma. Every caller in
 * scripts/release-validate.ts must run a URL through
 * `assertDisposableDatabaseUrl` before it is ever handed to `prisma db
 * push`, the seed script, the partial-index setup, or the Vitest run.
 *
 * Fails closed: anything that isn't unambiguously a loopback Postgres
 * connection is rejected, including a malformed URL, an empty value, a
 * non-Postgres protocol, or any hostname/username containing a known
 * Supabase/production marker. Never includes the raw URL, username, or
 * password in a returned reason string — only a safe, generic
 * description — so a caller can log the reason directly without a
 * secondary redaction step.
 */

/** Every host this guard will ever accept. Loopback only — never a remote hostname, even a "trusted-sounding" one. */
export const ALLOWED_DATABASE_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

/** Every protocol this guard will ever accept. */
export const ALLOWED_DATABASE_PROTOCOLS: ReadonlySet<string> = new Set(["postgres:", "postgresql:"]);

/**
 * Explicit reject-list substrings (Non-negotiable safety rule #4). Checked
 * against the hostname AND the full URL (case-insensitively) — the
 * Supabase pooler embeds the project reference in the connection
 * USERNAME (`postgres.<ref>@...pooler.supabase.com`), not the hostname,
 * so a hostname-only check would miss it entirely.
 */
export const REJECTED_HOST_SUBSTRINGS: readonly string[] = ["supabase.co", "supabase.com", "pooler.supabase.com", "ugckdvbjzauvcovcqebw"];

export type ParsedDisposableDatabaseUrl = {
  protocol: string;
  hostname: string;
  port: string;
  /** Present so a caller can log/compare it — usernames for a disposable DB are never secret. */
  username: string;
  /** Never the password itself — only whether one was supplied. */
  hasPassword: boolean;
  database: string;
};

export type DatabaseUrlGuardResult =
  | { ok: true; parsed: ParsedDisposableDatabaseUrl }
  | { ok: false; reason: string };

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

/**
 * Validates that `rawUrl` is safe to use as the release-validation
 * disposable database connection string. Returns a discriminated result
 * — never throws — so callers can handle rejection as an ordinary,
 * expected outcome (every rejected input is something a caller might
 * legitimately pass, e.g. an unset env var or a mistaken shared URL).
 */
export function assertDisposableDatabaseUrl(rawUrl: string | undefined | null): DatabaseUrlGuardResult {
  if (rawUrl == null || rawUrl.trim().length === 0) {
    return { ok: false, reason: "DATABASE_URL is empty or missing." };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "DATABASE_URL is not a well-formed URL." };
  }

  if (!ALLOWED_DATABASE_PROTOCOLS.has(parsedUrl.protocol)) {
    return { ok: false, reason: `DATABASE_URL protocol "${parsedUrl.protocol}" is not allowed — only postgres:// or postgresql:// may be used.` };
  }

  const hostname = stripIpv6Brackets(parsedUrl.hostname).toLowerCase();
  const lowerRawUrl = rawUrl.toLowerCase();
  for (const rejected of REJECTED_HOST_SUBSTRINGS) {
    if (hostname.includes(rejected) || lowerRawUrl.includes(rejected)) {
      return { ok: false, reason: "DATABASE_URL matches an explicitly rejected shared/production database marker." };
    }
  }

  if (!ALLOWED_DATABASE_HOSTS.has(hostname)) {
    return { ok: false, reason: `DATABASE_URL host is not an allowed disposable-database host (only localhost, 127.0.0.1, or ::1 are permitted).` };
  }

  return {
    ok: true,
    parsed: {
      protocol: parsedUrl.protocol,
      hostname,
      port: parsedUrl.port,
      username: decodeURIComponent(parsedUrl.username),
      hasPassword: parsedUrl.password.length > 0,
      database: decodeURIComponent(parsedUrl.pathname.replace(/^\//, "")),
    },
  };
}

/**
 * Stricter check used immediately before any Prisma/psql command in the
 * orchestrator: the guard above only proves the URL is loopback-shaped —
 * this additionally proves it points at the EXACT port this validation
 * run allocated for its own disposable container, so a stale leftover
 * container (or a typo) can never be silently targeted instead.
 */
export function assertMatchesExpectedPort(guardResult: DatabaseUrlGuardResult, expectedPort: number): DatabaseUrlGuardResult {
  if (!guardResult.ok) return guardResult;
  const actualPort = Number(guardResult.parsed.port);
  if (!Number.isInteger(actualPort) || actualPort !== expectedPort) {
    return { ok: false, reason: `DATABASE_URL port does not match the port allocated for this validation run's disposable container.` };
  }
  return guardResult;
}

/** Throws if the URL is unsafe — for call sites that want fail-fast control flow instead of branching on the result. */
export function requireDisposableDatabaseUrl(rawUrl: string | undefined | null, expectedPort?: number): ParsedDisposableDatabaseUrl {
  let result = assertDisposableDatabaseUrl(rawUrl);
  if (expectedPort != null) result = assertMatchesExpectedPort(result, expectedPort);
  if (!result.ok) {
    throw new Error(`Refusing to proceed: ${result.reason}`);
  }
  return result.parsed;
}
