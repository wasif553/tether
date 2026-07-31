/**
 * Tether System Check and Exam Readiness v1 — server-only configuration.
 * See docs/tether-system-check-v1.md.
 *
 * Reads process.env exactly once per call, applies safe defaults, and
 * hands off to the pure decision functions in
 * src/lib/systemCheck/readiness.ts. Nothing here is exported to any
 * client component — this must only ever be imported from a route
 * handler or another server-only module.
 */
import { resolveSystemCheckMode, type SystemCheckMode } from "@/lib/systemCheck/readiness";

/** Missing/malformed env values must never accidentally block all students — resolveSystemCheckMode already defaults to WARN. */
export function systemCheckMode(): SystemCheckMode {
  return resolveSystemCheckMode(process.env.TETHER_SYSTEM_CHECK_MODE);
}

const DEFAULT_VALIDITY_HOURS = 24;

/** A stored readiness record older than this many hours is treated as expired. Falls back to a safe default for any missing/non-positive value. */
export function systemCheckValidityHours(): number {
  const raw = process.env.TETHER_SYSTEM_CHECK_VALIDITY_HOURS;
  const parsed = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VALIDITY_HOURS;
  return parsed;
}

// 1.4.0 is the first version exposing attestSystemCheck — see
// docs/tether-system-check-v1.md, "Genuine client attestation". An
// older installed client can never produce a genuine SYSTEM_CHECK
// verification at all (ATTESTATION_UNAVAILABLE), regardless of this
// setting, so this default is kept in step with that requirement.
const DEFAULT_MINIMUM_SUPPORTED_VERSION = "1.4.0";

/** The minimum Tether Secure Browser version this deployment accepts as ready. Never hard-coded elsewhere — see docs/tether-system-check-v1.md. */
export function minimumSupportedTetherVersion(): string {
  const raw = process.env.TETHER_MINIMUM_SUPPORTED_VERSION;
  return raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_MINIMUM_SUPPORTED_VERSION;
}
