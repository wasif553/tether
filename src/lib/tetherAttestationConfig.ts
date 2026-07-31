/**
 * Secure Client Attestation v2 — protocol version / compatibility
 * configuration. See docs/tether-system-check-v1.md, "Compatibility and
 * rollout".
 *
 * Server-only. Reads process.env exactly once per call, with safe
 * defaults that can never accidentally lock out an existing student —
 * see each function's own doc comment.
 */

/** The attestation protocol version THIS server issues challenges under. Always 2 as of this pass — there is no server-side code path that issues a v1 SYSTEM_CHECK challenge any more (the v1 globally-embedded-key design was removed entirely, not merely deprecated). */
export const ATTESTATION_PROTOCOL_VERSION = 2;

/**
 * Whether the LEGACY (pre-installation-key) real exam-launch attestation
 * route (`POST /api/secure-client/sessions/[sessionId]/attestation`,
 * `recordAttestation` in secureClientRunner.ts) remains accepted.
 *
 * Defaults to `true` (accepted) — this is the CORRECT safe default: that
 * route is the ONLY thing that currently establishes a verified
 * SecureClientSession for a real exam attempt (the new EXAM_SESSION v2
 * attestation flow in this pass is purely additive — see
 * "Real exam attestation — additive groundwork" in the doc above, and is
 * not wired into any enforcement decision yet). Flipping this to
 * `false` before EXAM_SESSION v2 is genuinely wired into the exam-start
 * gate would lock out every student attempting a Tether-required exam —
 * see "Known limitations". This flag exists now, ahead of that wiring,
 * so the rollout sequence documented below has somewhere to attach to
 * without a second config change later.
 */
export function isLegacyAttestationAllowed(): boolean {
  return process.env.TETHER_LEGACY_ATTESTATION_ALLOWED !== "false";
}

/**
 * Whether a NEWLY created final examination should require genuine
 * EXAM_SESSION v2 (installation-bound) attestation, once that
 * enforcement is actually wired up in a future pass. Defaults to
 * `false` — this pass explicitly does NOT enable v2-only Production
 * enforcement (per instruction) and the enforcement code path this flag
 * would gate does not exist yet. Present now purely so the rollout
 * sequence is configurable from day one of that future work, rather
 * than requiring a schema/env-var change at that point too.
 */
export function isV2ExamSessionRequiredForNewFinalExams(): boolean {
  return process.env.TETHER_REQUIRE_EXAM_SESSION_V2 === "true";
}
