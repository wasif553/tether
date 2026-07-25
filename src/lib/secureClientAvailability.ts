/**
 * Tether Secure Client Foundation v1 — availability gating. See
 * docs/secure-client-foundation-seb-v1.md and Part 1/9/13 of the spec.
 *
 * Server-only (reads process.env), otherwise dependency-free. This is
 * the ONLY place TETHER_CLIENT_OPTIONAL / MOCK_TETHER_CLIENT availability
 * is decided — never a frontend query parameter, never a client-supplied
 * value. MOCK_TETHER_CLIENT is NEVER allowed in Production, full stop,
 * regardless of any other flag or institution.
 */
import type { SecureClientAvailability } from "@/lib/secureClientPolicy";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
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
  };
}

/** Back-compat alias name used at call sites that pass an institution context — the institution does not currently affect TETHER_CLIENT_OPTIONAL availability (only the mock client is institution-scoped — see isMockSecureClientAllowed). */
export function secureClientAvailabilityForInstitution(_institutionSlug: string | null): SecureClientAvailability {
  return secureClientAvailability();
}

/**
 * MOCK_TETHER_CLIENT — a development simulator only. Never available in
 * Production. Requires BOTH an explicit environment flag AND the
 * institution being on a server-configured allowlist (Part 13: "the
 * institution is an authorised test institution"). Never influenced by
 * anything the browser sends.
 */
export function isMockSecureClientAllowed(institutionSlug: string | null): boolean {
  if (isProduction()) return false;
  if (process.env.TETHER_MOCK_SECURE_CLIENT_ENABLED !== "true") return false;
  const allowedSlugs = (process.env.TETHER_MOCK_CLIENT_ALLOWED_INSTITUTION_SLUGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allowedSlugs.length === 0) return false;
  return institutionSlug != null && allowedSlugs.includes(institutionSlug);
}
