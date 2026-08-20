/**
 * Auth and Token Abuse Protection v1 — see
 * docs/auth-token-abuse-protection-v1.md.
 *
 * The ONE place every rate limiter gets its "which caller is this"
 * source-address string from — deliberately isolated so the trust
 * assumption below (which currently matches Vercel's request boundary)
 * can be revisited in one place if Tether ever changes hosting
 * providers, without touching every call site.
 *
 * Trust model: Production hosting is Vercel. Vercel's edge network
 * terminates the real client connection and sets `x-forwarded-for`
 * itself on every request reaching a serverless function — an ordinary
 * caller cannot override it by sending their own `x-forwarded-for`
 * header, because Vercel's proxy appends/overwrites it after the
 * client's own headers are received. This is therefore a value this
 * application can treat as authoritative on Vercel, the same trust
 * boundary this codebase already relies on elsewhere (see
 * src/lib/networkEvidence.ts's getClientIpFromRequest, used for evidence
 * capture — this module is deliberately separate from that one; see the
 * module-level note below for why).
 *
 * Deliberately never accepts a source address from anywhere other than
 * this one trusted header — never a JSON body field, never a query
 * parameter, never a client-supplied header this app doesn't control.
 *
 * Deliberately a SEPARATE module from src/lib/networkEvidence.ts's own
 * IP extraction, per this feature's explicit scope: NetworkEvidence's
 * semantics (its private-IP filtering, its null-on-no-IP fallback, its
 * salted-hash-for-evidence purpose) must not change as a side effect of
 * this work. This module has a narrower, different job — produce a
 * stable bucketing string for rate-limiting, including a defined
 * fallback when no address is present, rather than evidence-grade IP
 * capture.
 */
const UNKNOWN_SOURCE = "unknown-source";

/**
 * Returns a normalized, stable string identifying the request's trusted
 * source address for rate-limiting purposes — never null. Tests inject
 * this via the `x-forwarded-for` header directly on a constructed
 * Request, exactly like every other route test in this codebase.
 */
export function resolveTrustedRequestSource(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim().toLowerCase();
    if (first) return first;
  }
  // No usable header — every such request is bucketed together under one
  // shared "unknown" source rather than failing closed on the whole
  // request. This is intentionally conservative in the other direction
  // for a rate limiter (a shared bucket can only make legitimate callers
  // MORE likely to be limited together, never less), and is expected to
  // be rare/never on real Vercel traffic.
  return UNKNOWN_SOURCE;
}
