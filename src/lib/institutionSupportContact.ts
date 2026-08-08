/**
 * Production administration hardening v1, Part D — see
 * docs/tether-institution-configuration.md for the full audit this
 * implements one item from.
 *
 * `Institution` (prisma/schema.prisma) has no support-contact field —
 * adding one would be a genuine per-institution feature requiring a
 * schema change (out of scope for this pass; documented as REQUIRES
 * SCHEMA). This resolver is the safe, config-based stopgap: a single,
 * deployment-wide support contact string, used anywhere student-facing
 * copy needs to say "contact your institution or exam support" (the
 * pilot support runbook, error-contract messaging) instead of that
 * phrase being hardcoded with no actual contact info anywhere.
 *
 * Follows this repo's established env-var + typed-resolver convention
 * (see systemCheckConfig.ts). Never throws; a missing/empty value
 * resolves to null, and every caller must already handle "no specific
 * contact configured" gracefully (falls back to generic wording).
 */
export function resolveInstitutionSupportContact(): string | null {
  const raw = process.env.TETHER_SUPPORT_CONTACT;
  if (!raw || raw.trim().length === 0) return null;
  return raw.trim();
}
