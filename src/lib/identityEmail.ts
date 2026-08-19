/**
 * Canonical email normalization for identity matching — see
 * docs/lti-identity-collision-hardening-v1.md. Self-service account
 * onboarding (src/lib/selfServiceSignup.ts's `emailSchema`) has always
 * stored emails as `trim().toLowerCase()`. Canvas/LTI launches used to
 * use the platform-supplied email exactly as received, so two
 * representations of the same real-world address (differing only in
 * case or surrounding whitespace — e.g. Canvas sending
 * `"Stanley.Wisoky@Example.org"` while a self-service account was
 * created as `"stanley.wisoky@example.org"`) would never match in an
 * exact-string `User.email` lookup, defeating collision detection.
 *
 * Use this for every OPERATIONAL use of a real, externally-supplied
 * email (lookup, creation, update comparison) — never for the raw,
 * immutable evidence of what a platform actually sent (e.g. LTI's own
 * `launchClaimsJson`), which must retain the platform's original
 * casing/whitespace untouched.
 */
export function normalizeIdentityEmail(value: string): string {
  return value.trim().toLowerCase();
}
