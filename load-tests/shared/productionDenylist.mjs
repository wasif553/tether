/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — production denylist guard.
 *
 * The ONE place every load-test entry point (Node setup/verify scripts
 * AND every k6 scenario) decides whether a target is safe to send
 * synthetic traffic to. Pure, dependency-free, synchronous, importable
 * unmodified from both a Node ESM script and a k6 script (k6 supports
 * local ES-module imports; it does not support Node built-ins or npm
 * packages, so this file must never import either).
 *
 * Deliberately contains NO override flag of any kind (no
 * ALLOW_PRODUCTION_LOAD_TEST=true or equivalent) — every check below is
 * unconditional. If a target matches, the run must refuse before
 * authenticating a single user or creating a single fixture — see every
 * caller's own preflight sequence.
 *
 * Known Production hostnames (discovered directly from the Vercel API —
 * `get_project` on this repository's Vercel project — 2026-08-22, project
 * prj_3gM8EAl8GKfgeBWlMLa0svWGHlpN, "tether"):
 *   - tether-murex.vercel.app          (canonical custom Production alias)
 *   - tether-tether5.vercel.app        (default project domain)
 *   - tether-git-main-tether5.vercel.app (git branch alias for `main`,
 *     which is this project's Production branch)
 * All three currently resolve to the SAME live deployment/database. This
 * list is intentionally an exact-match set, not a hostname pattern: this
 * project's ordinary Preview deployments use the SAME
 * "tether-<hash>-tether5.vercel.app" naming scheme (see e.g.
 * tether-9yeywfizx-tether5.vercel.app from this session's own Preview
 * verification), so a pattern-based block would also block legitimate
 * Preview targets. Exact-match is the only rule that cannot misfire in
 * either direction.
 *
 * Known Production Supabase project reference (discovered from
 * scripts/releaseValidation/dbSafetyGuard.ts's own
 * REJECTED_HOST_SUBSTRINGS, which this repository's release-validation
 * pipeline already treats as an authoritative reject marker):
 *   - ugckdvbjzauvcovcqebw
 * Also rejects the generic pooler/host substrings that guard already
 * uses, for defense in depth on a database URL specifically (never
 * applied to the Vercel target hostname check, which must not blanket-
 * reject every *.supabase.co consumer — a genuinely dedicated load-test
 * Supabase project is *also* on supabase.co).
 *
 * TETHER_LOCAL_POSTGRES_LOAD_SMOKE_10 — narrow loopback exception: a
 * genuinely local `next dev`/`next start` instance backed by a genuinely
 * local, disposable PostgreSQL database (never Supabase, never anything
 * remote) cannot serve https:// at all, so the blanket "https only" rule
 * would make an entirely-offline, entirely-non-production smoke run
 * impossible to express — not because it's unsafe, but because the guard
 * had no way to distinguish "http because this is genuinely loopback"
 * from "http because someone pointed this at an insecure remote host".
 * http:// is now accepted ONLY for the three loopback hostnames
 * (localhost / 127.0.0.1 / ::1), on any port. Every other http:// target
 * is still rejected exactly as before. The Production hostname denylist
 * check now runs FIRST, unconditionally, before any protocol branching —
 * so a Production hostname is rejected regardless of which scheme it was
 * supplied with, and the new loopback branch can never become a path
 * that skips it. Still no override flag of any kind.
 *
 * TETHER_LOCAL_POSTGRES_LOAD_SMOKE_10 — no `new URL(...)`: discovered
 * while first actually running this module inside a real k6 scenario
 * (never exercised end-to-end before this task) that k6's Goja JS
 * runtime has NO global `URL` constructor at all — `typeof URL` is
 * `"undefined"` in k6's init context, unlike Node or a browser. The
 * original implementation used `new URL(...)`, which therefore threw a
 * ReferenceError the instant any k6 scenario imported this module,
 * despite this file's own header already claiming to be dependency-free
 * and k6-safe. Replaced with a small hand-written parser
 * (`parseUrlProtocolAndHostname`) using only string/regex operations —
 * genuinely runtime-independent, matching what this module always
 * claimed to be.
 */

export const PRODUCTION_VERCEL_HOSTNAMES = Object.freeze([
  "tether-murex.vercel.app",
  "tether-tether5.vercel.app",
  "tether-git-main-tether5.vercel.app",
]);

export const PRODUCTION_SUPABASE_PROJECT_REF = "ugckdvbjzauvcovcqebw";

export const PRODUCTION_DATABASE_URL_REJECT_SUBSTRINGS = Object.freeze([
  "ugckdvbjzauvcovcqebw",
]);

/** The only hostnames http:// may ever be used with — a genuinely local, disposable dev instance. Never a hostname pattern, never a network range: exactly these three literal loopback forms. */
export const LOOPBACK_HOSTNAMES = Object.freeze(["localhost", "127.0.0.1", "::1"]);

function stripIpv6Brackets(hostname) {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.includes(stripIpv6Brackets(hostname));
}

/**
 * Minimal, dependency-free `scheme://[userinfo@]host[:port]` parser —
 * only what this module needs (protocol + hostname), no path/query/hash.
 * Deliberately hand-written rather than the WHATWG `URL` global, which
 * does not exist in k6's Goja runtime (see this file's own header). Not
 * a general-purpose URL parser: malformed/unusual input is treated as
 * "no match" (null) rather than best-effort-parsed, matching `new
 * URL()`'s own throw-on-malformed behaviour closely enough for every
 * caller here, which only ever needs to fail closed on anything odd.
 *
 * @param {string} rawUrl
 * @returns {{ protocol: string, hostname: string } | null}
 */
function parseUrlProtocolAndHostname(rawUrl) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/(?:[^@/?#]*@)?(\[[0-9a-fA-F:]*\]|[^:/?#]+)(?::\d*)?(?:[/?#]|$)/.exec(rawUrl);
  if (!match) return null;
  const [, protocol, hostname] = match;
  if (!hostname) return null;
  return { protocol: protocol.toLowerCase(), hostname: hostname.toLowerCase() };
}

/**
 * @param {string | undefined | null} rawUrl
 * @returns {{ ok: true, hostname: string } | { ok: false, reason: string }}
 */
export function checkLoadTestTargetUrl(rawUrl) {
  if (rawUrl == null || String(rawUrl).trim().length === 0) {
    return { ok: false, reason: "No target URL was supplied. A load-test target must be explicitly configured — there is no default." };
  }

  const parsed = parseUrlProtocolAndHostname(String(rawUrl));
  if (!parsed) {
    return { ok: false, reason: `Target URL "${rawUrl}" is not a well-formed URL.` };
  }

  const { protocol, hostname } = parsed;

  // Runs FIRST, unconditionally, before any protocol branching — a
  // Production hostname is rejected no matter what scheme it arrives
  // with, so the http:// loopback exception below can never become a
  // path that bypasses this.
  for (const denied of PRODUCTION_VERCEL_HOSTNAMES) {
    if (hostname === denied) {
      return { ok: false, reason: `Target hostname "${hostname}" is a known Production hostname for this project. Synthetic load traffic against Production is never authorised.` };
    }
  }

  if (protocol === "https:") {
    return { ok: true, hostname };
  }

  if (protocol === "http:") {
    if (isLoopbackHostname(hostname)) {
      return { ok: true, hostname };
    }
    return { ok: false, reason: `Target hostname "${hostname}" was supplied over http://, which is only permitted for a genuinely local loopback target (localhost, 127.0.0.1, or ::1). Every other target must use https://.` };
  }

  return { ok: false, reason: `Target URL protocol "${protocol}" is not allowed — only https://, or http:// for a loopback target, may be used.` };
}

/**
 * Separate guard for a database connection string used by the Node
 * setup/verify scripts (never by k6 itself — k6 never touches the
 * database directly). Fails closed on anything empty/malformed, and
 * rejects the known Production Supabase project reference and the
 * generic pooler/host substrings this repository's own
 * release-validation pipeline already treats as reject markers.
 *
 * @param {string | undefined | null} rawUrl
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkLoadTestDatabaseUrl(rawUrl) {
  if (rawUrl == null || String(rawUrl).trim().length === 0) {
    return { ok: false, reason: "No load-test DATABASE_URL was supplied. A dedicated load-test database must be explicitly configured — there is no default and no fallback to the application's own DATABASE_URL." };
  }

  const parsed = parseUrlProtocolAndHostname(String(rawUrl));
  if (!parsed) {
    return { ok: false, reason: "Load-test DATABASE_URL is not a well-formed URL." };
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, reason: `Load-test DATABASE_URL protocol "${parsed.protocol}" is not allowed — only postgres:// or postgresql:// may be used.` };
  }

  const lowerRawUrl = String(rawUrl).toLowerCase();
  const hostname = parsed.hostname;
  for (const rejected of PRODUCTION_DATABASE_URL_REJECT_SUBSTRINGS) {
    if (hostname.includes(rejected) || lowerRawUrl.includes(rejected)) {
      return { ok: false, reason: "Load-test DATABASE_URL matches the known Production Supabase project reference. Refusing to connect." };
    }
  }

  return { ok: true };
}

/**
 * Convenience combined preflight for the Node setup/verify scripts: both
 * the Vercel target URL and the database URL must independently pass
 * before anything else runs. Throws — callers that want this as a hard
 * gate (every current caller) should call this first, before importing
 * or constructing anything else that could reach the network/database.
 *
 * @param {{ targetBaseUrl: string | undefined, databaseUrl: string | undefined }} params
 */
export function assertLoadTestEnvironmentIsSafe(params) {
  const targetCheck = checkLoadTestTargetUrl(params.targetBaseUrl);
  if (!targetCheck.ok) {
    throw new Error(`PRODUCTION DENYLIST REFUSED TARGET: ${targetCheck.reason}`);
  }
  const dbCheck = checkLoadTestDatabaseUrl(params.databaseUrl);
  if (!dbCheck.ok) {
    throw new Error(`PRODUCTION DENYLIST REFUSED DATABASE: ${dbCheck.reason}`);
  }
  return { hostname: targetCheck.hostname };
}
