/**
 * Production database backup creation v1 — operator-supplied manifest
 * metadata validation. See docs/database-backup-operations-v1.md.
 *
 * Pure, dependency-free, synchronous. `sourceEnvironmentLabel` and
 * `sourceProjectRef` in `backupBundleManifest.ts` are plain `string`
 * fields at the type level — nothing in TypeScript's type system stops
 * an operator from passing a raw connection string as
 * `--source-project-ref` or `--environment`. This module is what
 * actually makes "the manifest cannot hold a credential" true: every
 * value that will end up in the manifest is validated against a strict
 * ALLOWLIST pattern here, BEFORE `--execute` is permitted to proceed —
 * a rejected value never reaches manifest creation, is never silently
 * redacted-and-stored, and never starts a backup.
 *
 * Allowlist, not denylist: rather than trying to enumerate every shape
 * a connection string or credential could take (`postgres://`, `@`,
 * whitespace, path separators, query strings, control characters, ...),
 * each field accepts only a narrow, known-safe character set. Anything
 * outside that set — including every one of the forms just listed — is
 * rejected by construction, not by a growing list of specific checks.
 */

export type MetadataValidationResult = { ok: true; value: string } | { ok: false; reason: string };

const MAX_ENVIRONMENT_LABEL_LENGTH = 64;
/** Letters, digits, dot, hyphen, underscore only — deliberately excludes every character a URL, connection string, or credential needs (`:`, `/`, `@`, `?`, whitespace, control characters). */
const ENVIRONMENT_LABEL_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Validates and normalises an operator-supplied `--environment` label.
 * Returns the canonical, trimmed, lowercased value on success — this is
 * also the ONE place `--environment production` (in any casing/
 * whitespace variant) becomes the canonical stored label `"production"`,
 * so the Production-confirmation gate and the manifest's own recorded
 * label can never disagree about what counts as "production".
 */
export function validateEnvironmentLabel(raw: string | null): MetadataValidationResult {
  if (raw == null) {
    return { ok: false, reason: "environment label is missing" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "environment label is empty or whitespace-only" };
  }
  if (trimmed.length > MAX_ENVIRONMENT_LABEL_LENGTH) {
    return { ok: false, reason: `environment label exceeds ${MAX_ENVIRONMENT_LABEL_LENGTH} characters` };
  }
  if (!ENVIRONMENT_LABEL_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason: "environment label must contain only letters, digits, '.', '-', or '_' — this also rejects URLs, connection strings, whitespace, and control characters by construction",
    };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}

/** True once `validateEnvironmentLabel` has already normalised the value — a plain, case-sensitive equality check against the one canonical form. */
export function isProductionLabel(normalisedLabel: string): boolean {
  return normalisedLabel === "production";
}

export type ProjectRefValidationResult = { ok: true; value: string | null } | { ok: false; reason: string };

const MAX_PROJECT_REF_LENGTH = 64;
/** Plain alphanumeric token only — the real Supabase project-ref format, and deliberately excludes every character a URL/connection-string/credential needs. */
const PROJECT_REF_PATTERN = /^[a-zA-Z0-9]{1,64}$/;

/**
 * Validates an optional operator-supplied `--source-project-ref`.
 * `null` (not supplied at all) is a valid, successful result — the
 * caller falls back to safe automatic derivation
 * (`deriveSupabaseProjectRefSafely`) in that case. A *supplied but
 * malformed* value (e.g. a connection string pasted into the wrong
 * flag) is rejected outright, never silently accepted or redacted.
 */
export function validateSourceProjectRef(raw: string | null): ProjectRefValidationResult {
  if (raw == null) {
    return { ok: true, value: null };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "--source-project-ref was supplied but is empty or whitespace-only" };
  }
  if (trimmed.length > MAX_PROJECT_REF_LENGTH) {
    return { ok: false, reason: `--source-project-ref exceeds ${MAX_PROJECT_REF_LENGTH} characters` };
  }
  if (!PROJECT_REF_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason: "--source-project-ref must be a plain alphanumeric token — this rejects URLs, connection strings, '@', whitespace, path separators, query strings, and control characters by construction",
    };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}
