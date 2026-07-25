/**
 * Tether Secure Client Foundation v1 — event taxonomy and strict
 * discriminated metadata schemas. See
 * docs/secure-client-foundation-seb-v1.md and Part 3/14 of the spec.
 *
 * Pure, dependency-free: no Prisma, no Next.js. NO EVENT MAY BE LABELLED
 * MISCONDUCT — eventLevel is INFORMATIONAL/CONTEXT/ACTION_REQUIRED/
 * REVIEW_CONTEXT, never a violation score, and no event type here ever
 * carries a client-supplied misconduct score of any kind.
 */
import { z } from "zod";
import { isValidProhibitedProcessEvidence } from "./attestation";

export const SECURE_CLIENT_EVENT_TYPES = [
  "SECURE_CLIENT_LAUNCH_REQUESTED",
  "SECURE_CLIENT_LAUNCH_CONSUMED",
  "SECURE_CLIENT_LAUNCH_REPLAY_REJECTED",
  "SECURE_CLIENT_VERIFIED",
  "SECURE_CLIENT_VERSION_REJECTED",
  "CONFIGURATION_HASH_MISMATCH",
  "BROWSER_EXAM_KEY_MISSING",
  "BROWSER_EXAM_KEY_REJECTED",
  "CONFIG_KEY_MISSING",
  "CONFIG_KEY_REJECTED",
  "PREFLIGHT_STARTED",
  "PREFLIGHT_READY",
  "PREFLIGHT_ACTION_REQUIRED",
  "PREFLIGHT_CANNOT_START",
  "ADDITIONAL_DISPLAY_PRESENT",
  "DISPLAY_CONFIGURATION_CHANGED",
  "REMOTE_SESSION_SIGNAL",
  "VIRTUAL_MACHINE_SIGNAL",
  "PROHIBITED_PROCESS_SIGNAL",
  "APPLICATION_SWITCH_ATTEMPT",
  "CLIPBOARD_ACTION_BLOCKED",
  "PRINT_ACTION_BLOCKED",
  "EXTERNAL_NAVIGATION_BLOCKED",
  "CAPTURE_PROTECTION_UNAVAILABLE",
  "HEARTBEAT_MISSED",
  "SECURE_CLIENT_INTERRUPTED",
  "SECURE_CLIENT_RECOVERY_REQUESTED",
  "SECURE_CLIENT_RECOVERED",
  "SECURE_CLIENT_ENDED",
  "CLIENT_TECHNICAL_FAILURE",
  "LECTURER_OVERRIDE_GRANTED",
] as const;
export type SecureClientEventType = (typeof SECURE_CLIENT_EVENT_TYPES)[number];
export function isValidSecureClientEventType(value: string): value is SecureClientEventType {
  return (SECURE_CLIENT_EVENT_TYPES as readonly string[]).includes(value);
}

export const SECURE_CLIENT_EVENT_LEVELS = ["INFORMATIONAL", "CONTEXT", "ACTION_REQUIRED", "REVIEW_CONTEXT"] as const;
export type SecureClientEventLevel = (typeof SECURE_CLIENT_EVENT_LEVELS)[number];
export function isValidSecureClientEventLevel(value: string): value is SecureClientEventLevel {
  return (SECURE_CLIENT_EVENT_LEVELS as readonly string[]).includes(value);
}

/** Default event level per type — REVIEW_CONTEXT only for the signals a lecturer timeline highlights for judgement; nothing here is ever escalated to a violation label. */
export const DEFAULT_SECURE_CLIENT_EVENT_LEVEL: Record<SecureClientEventType, SecureClientEventLevel> = {
  SECURE_CLIENT_LAUNCH_REQUESTED: "INFORMATIONAL",
  SECURE_CLIENT_LAUNCH_CONSUMED: "INFORMATIONAL",
  SECURE_CLIENT_LAUNCH_REPLAY_REJECTED: "REVIEW_CONTEXT",
  SECURE_CLIENT_VERIFIED: "INFORMATIONAL",
  SECURE_CLIENT_VERSION_REJECTED: "ACTION_REQUIRED",
  CONFIGURATION_HASH_MISMATCH: "ACTION_REQUIRED",
  BROWSER_EXAM_KEY_MISSING: "ACTION_REQUIRED",
  BROWSER_EXAM_KEY_REJECTED: "ACTION_REQUIRED",
  CONFIG_KEY_MISSING: "ACTION_REQUIRED",
  CONFIG_KEY_REJECTED: "ACTION_REQUIRED",
  PREFLIGHT_STARTED: "INFORMATIONAL",
  PREFLIGHT_READY: "INFORMATIONAL",
  PREFLIGHT_ACTION_REQUIRED: "ACTION_REQUIRED",
  PREFLIGHT_CANNOT_START: "ACTION_REQUIRED",
  ADDITIONAL_DISPLAY_PRESENT: "ACTION_REQUIRED",
  DISPLAY_CONFIGURATION_CHANGED: "CONTEXT",
  REMOTE_SESSION_SIGNAL: "REVIEW_CONTEXT",
  VIRTUAL_MACHINE_SIGNAL: "REVIEW_CONTEXT",
  PROHIBITED_PROCESS_SIGNAL: "REVIEW_CONTEXT",
  APPLICATION_SWITCH_ATTEMPT: "CONTEXT",
  CLIPBOARD_ACTION_BLOCKED: "INFORMATIONAL",
  PRINT_ACTION_BLOCKED: "INFORMATIONAL",
  EXTERNAL_NAVIGATION_BLOCKED: "INFORMATIONAL",
  CAPTURE_PROTECTION_UNAVAILABLE: "CONTEXT",
  HEARTBEAT_MISSED: "CONTEXT",
  SECURE_CLIENT_INTERRUPTED: "CONTEXT",
  SECURE_CLIENT_RECOVERY_REQUESTED: "CONTEXT",
  SECURE_CLIENT_RECOVERED: "INFORMATIONAL",
  SECURE_CLIENT_ENDED: "INFORMATIONAL",
  CLIENT_TECHNICAL_FAILURE: "CONTEXT",
  LECTURER_OVERRIDE_GRANTED: "REVIEW_CONTEXT",
};

// ---------------------------------------------------------------------------
// Strict discriminated metadata schemas — mirrors
// DEVELOPMENT_EVENT_METADATA_SCHEMAS in src/lib/answerDevelopment.ts.
// `.strict()` rejects any unrecognised key. No event type's schema ever
// accepts a raw process list, command-line arguments, window titles, or
// a client-supplied misconduct score.
// ---------------------------------------------------------------------------

const emptyMetadataSchema = z.object({}).strict();
const versionMetadataSchema = z.object({ clientVersion: z.string().max(50).optional(), platform: z.string().max(50).optional() }).strict();
const reasonMetadataSchema = z.object({ reasonCode: z.string().max(100).optional() }).strict();
const prohibitedProcessMetadataSchema = z
  .object({
    ruleId: z.string().max(100),
    category: z.string().max(100),
    normalisedApplicationId: z.string().max(200),
    detectedAt: z.string(),
  })
  .strict();
const displayMetadataSchema = z.object({ displayCount: z.number().int().min(0).max(64).optional() }).strict();
const endMetadataSchema = z.object({ endReason: z.string().max(200).optional() }).strict();

export const SECURE_CLIENT_EVENT_METADATA_SCHEMAS: Record<SecureClientEventType, z.ZodTypeAny> = {
  SECURE_CLIENT_LAUNCH_REQUESTED: emptyMetadataSchema,
  SECURE_CLIENT_LAUNCH_CONSUMED: emptyMetadataSchema,
  SECURE_CLIENT_LAUNCH_REPLAY_REJECTED: emptyMetadataSchema,
  SECURE_CLIENT_VERIFIED: versionMetadataSchema,
  SECURE_CLIENT_VERSION_REJECTED: versionMetadataSchema,
  CONFIGURATION_HASH_MISMATCH: emptyMetadataSchema,
  BROWSER_EXAM_KEY_MISSING: emptyMetadataSchema,
  BROWSER_EXAM_KEY_REJECTED: emptyMetadataSchema,
  CONFIG_KEY_MISSING: emptyMetadataSchema,
  CONFIG_KEY_REJECTED: emptyMetadataSchema,
  PREFLIGHT_STARTED: emptyMetadataSchema,
  PREFLIGHT_READY: emptyMetadataSchema,
  PREFLIGHT_ACTION_REQUIRED: reasonMetadataSchema,
  PREFLIGHT_CANNOT_START: reasonMetadataSchema,
  ADDITIONAL_DISPLAY_PRESENT: displayMetadataSchema,
  DISPLAY_CONFIGURATION_CHANGED: displayMetadataSchema,
  REMOTE_SESSION_SIGNAL: reasonMetadataSchema,
  VIRTUAL_MACHINE_SIGNAL: reasonMetadataSchema,
  PROHIBITED_PROCESS_SIGNAL: prohibitedProcessMetadataSchema,
  APPLICATION_SWITCH_ATTEMPT: emptyMetadataSchema,
  CLIPBOARD_ACTION_BLOCKED: emptyMetadataSchema,
  PRINT_ACTION_BLOCKED: emptyMetadataSchema,
  EXTERNAL_NAVIGATION_BLOCKED: emptyMetadataSchema,
  CAPTURE_PROTECTION_UNAVAILABLE: emptyMetadataSchema,
  HEARTBEAT_MISSED: emptyMetadataSchema,
  SECURE_CLIENT_INTERRUPTED: reasonMetadataSchema,
  SECURE_CLIENT_RECOVERY_REQUESTED: emptyMetadataSchema,
  SECURE_CLIENT_RECOVERED: emptyMetadataSchema,
  SECURE_CLIENT_ENDED: endMetadataSchema,
  CLIENT_TECHNICAL_FAILURE: reasonMetadataSchema,
  LECTURER_OVERRIDE_GRANTED: reasonMetadataSchema,
};

export type SecureClientEventMetadataValidation = { success: true; data: Record<string, unknown> } | { success: false; error: string };

export function validateSecureClientEventMetadata(eventType: SecureClientEventType, metadata: unknown): SecureClientEventMetadataValidation {
  const schema = SECURE_CLIENT_EVENT_METADATA_SCHEMAS[eventType];
  const result = schema.safeParse(metadata ?? {});
  if (!result.success) return { success: false, error: result.error.issues.map((i) => i.message).join("; ") };
  if (eventType === "PROHIBITED_PROCESS_SIGNAL" && !isValidProhibitedProcessEvidence(result.data)) {
    return { success: false, error: "Invalid prohibited-process evidence shape" };
  }
  return { success: true, data: result.data as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Sequence-number validation (Part 3/14) — server-assigned and checked,
// never trusted from the client as authoritative on its own. Out-of-order
// delivery is tolerated (network retries can reorder requests) but a
// GAP-FREE, MONOTONIC sequence is enforced by the caller comparing the
// next expected number against what was last persisted — this function
// only judges one candidate against the last-known value.
// ---------------------------------------------------------------------------

export type SequenceCheckResult = "ACCEPT" | "DUPLICATE" | "OUT_OF_ORDER";

/** A candidate sequence number is accepted if it's greater than the last seen; treated as a duplicate if equal; flagged out-of-order if lower (still recorded, never silently dropped, by the caller). */
export function checkSequenceNumber(candidate: number | null, lastSeen: number | null): SequenceCheckResult {
  if (candidate == null || lastSeen == null) return "ACCEPT";
  if (candidate === lastSeen) return "DUPLICATE";
  if (candidate < lastSeen) return "OUT_OF_ORDER";
  return "ACCEPT";
}
