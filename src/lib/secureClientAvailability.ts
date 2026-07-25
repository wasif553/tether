/**
 * Tether Secure Client Foundation v1 — availability gating. See
 * docs/secure-client-foundation-seb-v1.md and Part 1/9/13 of the spec.
 *
 * Server-only (reads process.env), otherwise dependency-free. This is
 * the ONLY place TETHER_CLIENT_OPTIONAL / MOCK_TETHER_CLIENT / SEB_OPTIONAL
 * / SEB_REQUIRED availability is decided — never a frontend query
 * parameter, never a client-supplied value. MOCK_TETHER_CLIENT is NEVER
 * allowed in Production, full stop, regardless of any other flag or
 * institution.
 *
 * Hardening pass (see docs/migration-ledger.md hardening commit):
 * deployment-environment detection now uses VERCEL_ENV, not NODE_ENV.
 * Next.js sets NODE_ENV="production" for both Vercel Preview AND
 * Production builds (`next build && next start` in either case) — a
 * NODE_ENV-only check therefore cannot tell Preview and Production apart,
 * and this project's Preview and Production deployments share the same
 * Supabase database (see docs/migration-ledger.md). VERCEL_ENV is the
 * value Vercel actually sets per-deployment-target ("production" /
 * "preview" / "development"), and is what every check below keys off.
 */
import type { SecureClientAvailability } from "@/lib/secureClientPolicy";

export type DeploymentEnvironment = "production" | "preview" | "local-development" | "unknown";

/**
 * Resolves the deployment environment this process is running in.
 * Deliberately conservative: anything that isn't unambiguously
 * "production", "preview", or genuine local development (no VERCEL_ENV at
 * all, and NODE_ENV=development — i.e. `next dev` run directly, not via
 * the Vercel CLI) resolves to "unknown", which every gate below treats as
 * a denial. A missing or malformed VERCEL_ENV value NEVER resolves to
 * "production" — that would be the one mistake that actually matters (it
 * must never accidentally OPEN a Production gate); an unrecognised value
 * instead resolves to "unknown", which is equally closed for every gate
 * in this module.
 */
export function deploymentEnvironment(): DeploymentEnvironment {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return "preview";
  if (vercelEnv == null || vercelEnv === "") {
    return process.env.NODE_ENV === "development" ? "local-development" : "unknown";
  }
  // Includes VERCEL_ENV="development" (set by `vercel dev`) and any other
  // unexpected value — neither "preview" nor genuine local development as
  // defined above, so treated as unknown/deny rather than guessed at.
  return "unknown";
}

function isProduction(): boolean {
  return deploymentEnvironment() === "production";
}

function parseSlugAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * TETHER_CLIENT_OPTIONAL is visible only behind this internal feature
 * flag (Part 1). TETHER_CLIENT_REQUIRED remains unavailable
 * unconditionally in v1 — "cannot be selected for real exams until a
 * signed production client is available" (Part 1), which does not exist
 * in this phase.
 */
export function secureClientAvailability(): SecureClientAvailability {
  return {
    tetherClientOptionalAvailable: !isProduction() && process.env.TETHER_CLIENT_OPTIONAL_ENABLED === "true",
    tetherClientRequiredAvailable: false,
    sebOptionalAvailable: isSebOptionalAvailable(),
    sebRequiredAvailable: false,
  };
}

/**
 * SEB_OPTIONAL/SEB_REQUIRED availability depends on the institution (for
 * SEB_REQUIRED's allowlist), so the flat secureClientAvailability() above
 * always reports sebRequiredAvailable: false — callers that need the real
 * answer must go through secureClientAvailabilityForInstitution below.
 */
export function secureClientAvailabilityForInstitution(institutionSlug: string | null): SecureClientAvailability {
  return {
    ...secureClientAvailability(),
    sebRequiredAvailable: isSebRequiredAllowed(institutionSlug),
  };
}

/**
 * MOCK_TETHER_CLIENT — a development simulator only. Never available in
 * Production. Requires BOTH an explicit environment flag AND the
 * institution being on a server-configured allowlist (Part 13: "the
 * institution is an authorised test institution"). Never influenced by
 * anything the browser sends — this function never reads a request,
 * header, query parameter, or any client-supplied value; only
 * process.env and the institutionSlug the SERVER already resolved for
 * the authenticated session.
 */
export function isMockSecureClientAllowed(institutionSlug: string | null): boolean {
  const env = deploymentEnvironment();
  // "unknown" is denied for the same reason production is: we cannot
  // prove this ISN'T production, so it must be treated as if it were.
  if (env === "production" || env === "unknown") return false;
  if (process.env.TETHER_MOCK_SECURE_CLIENT_ENABLED !== "true") return false;
  const allowedSlugs = parseSlugAllowlist(process.env.TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS);
  if (allowedSlugs.length === 0) return false;
  return institutionSlug != null && allowedSlugs.includes(institutionSlug);
}

/**
 * SEB_OPTIONAL v1 hardening (Part 4 of the hardening pass): real SEB
 * client compatibility has not yet been validated against this backend
 * (see docs/secure-client-foundation-seb-v1.md, "Known limitations"), so
 * it stays behind an explicit experimental flag and is never available in
 * Production, exactly like the mock client above.
 */
export function isSebOptionalAvailable(): boolean {
  const env = deploymentEnvironment();
  if (env === "production" || env === "unknown") return false;
  return process.env.TETHER_SEB_EXPERIMENTAL_ENABLED === "true";
}

/**
 * SEB_REQUIRED is more restrictive still than SEB_OPTIONAL: an exam that
 * REQUIRES an unvalidated client locks students out entirely if it
 * doesn't work, so it additionally needs the institution to be on an
 * explicit allowlist — never available in Production, and never
 * available anywhere without BOTH the experimental flag and the
 * allowlist.
 */
export function isSebRequiredAllowed(institutionSlug: string | null): boolean {
  const env = deploymentEnvironment();
  if (env === "production" || env === "unknown") return false;
  if (process.env.TETHER_SEB_EXPERIMENTAL_ENABLED !== "true") return false;
  const allowedSlugs = parseSlugAllowlist(process.env.TETHER_SEB_REQUIRED_ALLOWED_INSTITUTION_SLUGS);
  if (allowedSlugs.length === 0) return false;
  return institutionSlug != null && allowedSlugs.includes(institutionSlug);
}
