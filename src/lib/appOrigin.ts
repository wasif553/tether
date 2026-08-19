/**
 * Origin resolution for server-generated, same-app redirects — see
 * docs/deployment-vercel-supabase.md.
 *
 * The rule: any URL that only ever points back into THIS app (e.g. the
 * page a browser lands on after a successful LTI launch) must be built
 * from the origin of the request that's actually being handled right
 * now, never from a manually-configured env var like `APP_URL`. An env
 * var is a snapshot set at one point in time; on Vercel, a Preview
 * deployment gets a brand-new URL every deploy, so a value set once can
 * silently go stale and start pointing at a torn-down deployment
 * (`404: DEPLOYMENT_NOT_FOUND`). The incoming request's own URL, by
 * contrast, can never be stale — it's whatever origin is actually
 * serving this request right now.
 *
 * This does NOT apply to URLs that must be registered with (and
 * validated by) an external party ahead of time — e.g. the Canvas OIDC
 * `redirect_uri` built in /api/lti/login and /api/lti/config, which must
 * match a stable value configured in Canvas's Developer Key and
 * legitimately still uses `APP_URL`.
 */
export function resolveInternalRedirectOrigin(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

/**
 * LTI Reference Platform compatibility repair — trusted origin for LTI
 * OIDC endpoints that a platform (Canvas, or the 1EdTech LTI 1.3
 * Reference Implementation used for manual testing) must be able to
 * reach and that Tether registers ahead of time (`redirect_uri`,
 * `oidc_initiation_url`, `target_link_uri` in /api/lti/login and
 * /api/lti/config). Unlike resolveInternalRedirectOrigin above, this is
 * NEVER derived from an incoming request's Host/Forwarded headers —
 * those are attacker-controlled on a request whose whole purpose is
 * bootstrapping trust (an unauthenticated login-initiation hit), so
 * trusting them here would let a crafted request redirect a real LTI
 * launch anywhere.
 *
 * Precedence:
 *   1. `APP_URL`, when explicitly configured — the stable, manually
 *      registered value Canvas Developer Keys (and the 1EdTech
 *      Reference Platform's own tool registration) point at in
 *      production. Always wins when present, exactly as before this
 *      function existed.
 *   2. `VERCEL_URL` — Vercel's own server-injected deployment hostname
 *      (never client-supplied; set automatically by the platform on
 *      every build, including each Preview deployment), so Preview LTI
 *      testing works without hand-configuring `APP_URL` per deployment.
 *      Normalized to an `https://` origin — `VERCEL_URL` is documented
 *      as a bare host, never a scheme.
 *   3. Neither is available — fails closed (`null`); callers must
 *      surface a clear configuration error rather than guessing at an
 *      origin.
 */
export function resolveLtiToolOrigin(): string | null {
  const appUrl = process.env.APP_URL;
  if (appUrl) return appUrl;

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;

  return null;
}
