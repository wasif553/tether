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
