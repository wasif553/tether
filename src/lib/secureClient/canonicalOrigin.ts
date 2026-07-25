/**
 * Tether Secure Client Foundation v1 — canonical origin allowlist. See
 * docs/secure-client-foundation-seb-v1.md and Part 5/14 of the spec:
 * "correctly account for Vercel proxy headers through an allowlisted
 * canonical origin."
 *
 * Pure, dependency-free: no Prisma, no Next.js. Vercel terminates TLS and
 * proxies every request, so `req.headers.get("host")` can reflect an
 * internal/forwarded value an attacker partially influences; this module
 * never trusts a raw Host/X-Forwarded-Host header as authoritative on its
 * own — it only accepts an origin that exactly matches a server-
 * configured allowlist (APP_URL plus any explicitly-configured secondary
 * origins), and otherwise falls back to the first allowlisted origin.
 */

/** Normalises an origin string: scheme + host, no trailing slash, no path. */
export function normaliseOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return origin.trim().replace(/\/+$/, "");
  }
}

export function buildOriginAllowlist(appUrl: string | undefined, extraOrigins: string[] = []): string[] {
  const origins = [appUrl, ...extraOrigins].filter((o): o is string => typeof o === "string" && o.length > 0).map(normaliseOrigin);
  return [...new Set(origins)];
}

/**
 * Resolves the canonical origin for a request: the forwarded/host origin
 * IF it exactly matches the allowlist, otherwise the first (primary)
 * allowlisted origin — never an unrecognised value, so a Browser Exam Key
 * / Config Key hash is always computed against a known-good origin
 * rather than whatever a client/proxy happened to report.
 */
export function resolveCanonicalOrigin(candidateOrigin: string | null, allowlist: string[]): string {
  if (allowlist.length === 0) {
    throw new Error("No canonical origin is configured (APP_URL is required for secure-client SEB validation).");
  }
  if (candidateOrigin) {
    const normalised = normaliseOrigin(candidateOrigin);
    if (allowlist.includes(normalised)) return normalised;
  }
  return allowlist[0];
}

/**
 * Derives the candidate origin from Vercel's forwarded-proto/host headers
 * (falling back to a plain Host header for local development) — this is
 * only ever a CANDIDATE, checked against resolveCanonicalOrigin's
 * allowlist immediately after; never trusted on its own.
 */
export function candidateOriginFromHeaders(headers: { get(name: string): string | null }): string | null {
  const forwardedHost = headers.get("x-forwarded-host");
  const forwardedProto = headers.get("x-forwarded-proto");
  if (forwardedHost) {
    const proto = forwardedProto?.split(",")[0]?.trim() || "https";
    return `${proto}://${forwardedHost.split(",")[0]?.trim()}`;
  }
  const host = headers.get("host");
  if (host) return `https://${host}`;
  return null;
}
