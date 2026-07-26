/**
 * Tether Secure Client Foundation v1 — attestation / preflight model. See
 * docs/secure-client-foundation-seb-v1.md and Part 3/8 of the spec.
 *
 * Pure, dependency-free: no Prisma, no Next.js, no browser APIs. A
 * technical failure is NEVER represented as student misconduct — see
 * `overallStatusFromChecks` below, which only ever escalates to
 * CANNOT_START for an actual verification/configuration/policy failure,
 * never for an infrastructure error (that is always TECHNICAL_FAILURE).
 */

export const CHECK_STATUSES = ["PASS", "FAIL", "WARNING", "NOT_CHECKED", "NOT_SUPPORTED", "UNKNOWN"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export function isValidCheckStatus(value: string): value is CheckStatus {
  return (CHECK_STATUSES as readonly string[]).includes(value);
}

export const OVERALL_STATUSES = ["READY", "ACTION_REQUIRED", "CANNOT_START", "NOT_SUPPORTED", "TECHNICAL_FAILURE"] as const;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];
export function isValidOverallStatus(value: string): value is OverallStatus {
  return (OVERALL_STATUSES as readonly string[]).includes(value);
}

/**
 * Every check this feature can ever report on. SEB (a web-integrated
 * client) cannot return every property a future native Tether client
 * can — an unsupported check MUST report NOT_SUPPORTED, never PASS (Part
 * 8: "Do not pretend that SEB can return every Tether-client attestation
 * property through the web integration").
 */
export const ATTESTATION_CHECK_KEYS = [
  "clientSignature",
  "configurationVerification",
  "displayCheck",
  "remoteSession",
  "virtualMachine",
  "processCheck",
  "captureProtection",
  "clipboardPolicy",
  "printingPolicy",
  "externalNavigationPolicy",
] as const;
export type AttestationCheckKey = (typeof ATTESTATION_CHECK_KEYS)[number];

export type AttestationChecks = Partial<Record<AttestationCheckKey, CheckStatus>>;

/** Which checks the immutable policy actually REQUIRES for this attempt — every other check is informational only and never blocks starting. */
export type RequiredChecks = Partial<Record<AttestationCheckKey, boolean>>;

/**
 * Part 8 overall-status rules:
 *   READY: every REQUIRED, SUPPORTED check passes.
 *   ACTION_REQUIRED: a correctable issue exists (a required check failed
 *     or warned, but nothing indicates an infrastructure problem or a
 *     hard configuration/verification failure).
 *   CANNOT_START: required client verification fails, configuration is
 *     invalid, client version unsupported, or a required check reports
 *     NOT_SUPPORTED (the platform genuinely cannot fulfil the
 *     requirement with this client) — see clientVerificationFailed/
 *     configurationInvalid/versionUnsupported flags below.
 *   TECHNICAL_FAILURE: an infrastructure/API error prevented a reliable
 *     determination — never represented as student misconduct.
 */
export type OverallStatusInput = {
  checks: AttestationChecks;
  required: RequiredChecks;
  clientVerificationFailed: boolean;
  configurationInvalid: boolean;
  versionUnsupported: boolean;
  technicalFailure: boolean;
};

export function overallStatusFromChecks(input: OverallStatusInput): OverallStatus {
  if (input.technicalFailure) return "TECHNICAL_FAILURE";
  if (input.clientVerificationFailed || input.configurationInvalid || input.versionUnsupported) return "CANNOT_START";

  let hasActionRequired = false;
  for (const key of ATTESTATION_CHECK_KEYS) {
    if (!input.required[key]) continue; // Only required checks can affect the overall status.
    const status = input.checks[key] ?? "NOT_CHECKED";
    if (status === "NOT_SUPPORTED") return "CANNOT_START"; // Required but the client genuinely cannot provide it.
    if (status === "FAIL" || status === "WARNING" || status === "NOT_CHECKED" || status === "UNKNOWN") hasActionRequired = true;
  }
  return hasActionRequired ? "ACTION_REQUIRED" : "READY";
}

/**
 * SEB's web integration cannot ever report certain Tether-client-only
 * checks — these always resolve to NOT_SUPPORTED for clientType
 * SAFE_EXAM_BROWSER, regardless of what the policy nominally requires
 * (Part 8).
 *
 * `displayCheck` is included here (Single Display Requirement v1, see
 * docs/secure-client-foundation-seb-v1.md, "Display requirement"): the
 * official SEB JavaScript API (window.SafeExamBrowser — see
 * src/lib/secureClient/sebJavascriptApi.ts) exposes only `version` and
 * `security.updateKeys()`, nothing about connected displays. SEB enforces
 * its own display-count restriction (`allowedDisplaysMaxNumber`) entirely
 * client-side, before/without ever reporting the outcome back to this
 * attestation API — there is no trustworthy channel for a SEB session to
 * claim PASS or FAIL on this check, so it must never be treated as
 * something SEB can attest to. The restriction itself is still enforced —
 * see sebConfigGenerator.ts — just not observable through this endpoint
 * for SEB. Only a future native Tether client (TETHER_SECURE_CLIENT) or
 * the dev/mock simulator (MOCK_TETHER_CLIENT) may report it.
 */
export const SEB_UNSUPPORTED_CHECKS: ReadonlySet<AttestationCheckKey> = new Set([
  "displayCheck",
  "remoteSession",
  "virtualMachine",
  "processCheck",
  "captureProtection",
]);

export function checksSupportedByClientType(clientType: string): ReadonlySet<AttestationCheckKey> {
  if (clientType === "SAFE_EXAM_BROWSER") {
    return new Set(ATTESTATION_CHECK_KEYS.filter((k) => !SEB_UNSUPPORTED_CHECKS.has(k)));
  }
  // TETHER_SECURE_CLIENT / MOCK_TETHER_CLIENT — contracts defined for all
  // checks (Part 8/15), even though no production client exists yet.
  return new Set(ATTESTATION_CHECK_KEYS);
}

/** Normalises a caller-supplied check map so any check unsupported by this clientType is force-set to NOT_SUPPORTED, never left as whatever a client claimed. */
export function normaliseChecksForClientType(checks: AttestationChecks, clientType: string): AttestationChecks {
  const supported = checksSupportedByClientType(clientType);
  const result: AttestationChecks = { ...checks };
  for (const key of ATTESTATION_CHECK_KEYS) {
    if (!supported.has(key)) result[key] = "NOT_SUPPORTED";
  }
  return result;
}

// ---------------------------------------------------------------------------
// Single Display Requirement v1 — bounded, optional display attestation
// fields for a FUTURE trusted native Tether client (see
// docs/secure-client-foundation-seb-v1.md, "Display requirement", Part 6).
// NOT implemented for SAFE_EXAM_BROWSER — see SEB_UNSUPPORTED_CHECKS
// above; these fields are only ever accepted from TETHER_SECURE_CLIENT/
// MOCK_TETHER_CLIENT sessions (see recordAttestation in
// secureClientRunner.ts). Never a raw monitor name, serial number, EDID,
// device path, or any other hardware identifier — just a small bounded
// count and a coarse topology classification.
// ---------------------------------------------------------------------------

/** Small, fixed sanity bound — never a real hardware limit, just a bound against a malformed/huge client-supplied number. */
export const MAX_REPORTED_DISPLAY_COUNT = 8;

export function isValidReportedDisplayCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_REPORTED_DISPLAY_COUNT;
}

export const DISPLAY_TOPOLOGIES = ["SINGLE", "CLONE", "EXTEND", "EXTERNAL_ONLY", "UNKNOWN"] as const;
export type DisplayTopology = (typeof DISPLAY_TOPOLOGIES)[number];
export function isValidDisplayTopology(value: string): value is DisplayTopology {
  return (DISPLAY_TOPOLOGIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Prohibited-process evidence (Part 3) — minimal, structured, never a full
// process list, never command-line arguments, never window titles.
// ---------------------------------------------------------------------------

export type ProhibitedProcessEvidence = {
  ruleId: string;
  category: string;
  normalisedApplicationId: string;
  detectedAt: string;
};

export function isValidProhibitedProcessEvidence(value: unknown): value is ProhibitedProcessEvidence {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ruleId === "string" &&
    v.ruleId.length > 0 &&
    v.ruleId.length <= 100 &&
    typeof v.category === "string" &&
    v.category.length <= 100 &&
    typeof v.normalisedApplicationId === "string" &&
    v.normalisedApplicationId.length <= 200 &&
    typeof v.detectedAt === "string" &&
    !Number.isNaN(Date.parse(v.detectedAt)) &&
    // Nothing else is permitted on this object — a strict allowlist of keys.
    Object.keys(v).every((k) => ["ruleId", "category", "normalisedApplicationId", "detectedAt"].includes(k))
  );
}
