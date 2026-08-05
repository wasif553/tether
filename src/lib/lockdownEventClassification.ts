/**
 * Tether Windows Lockdown Hardening v1 — web-app-side pure classification
 * helpers (Part 11). No Prisma, no Next.js — safe to import from
 * anywhere, including plain vitest, mirroring every other pure lib file
 * in this codebase (tetherRecovery.ts, secureExam.ts).
 *
 * apps/lockdown (Electron) is a separate compiled package with its own
 * capability registry (lockdownCapabilityRegistry.ts) — this module does
 * NOT duplicate that registry. It only knows the narrow, bounded shape
 * Electron relays over IPC: a capability's CATEGORY (one of the five
 * fixed category names) and its EFFECTIVE action, both already resolved
 * client-side against the registry + policy toggles. See
 * src/app/student/exams/[id]/tether-launch/page.tsx and
 * src/app/student/exams/[id]/page.tsx for where this is actually wired
 * into window.sesLockdown's IPC bridge.
 */
import type { IntegrityEventTypeName, IntegritySeverityLevel } from "@/lib/secureExam";

export const LOCKDOWN_CAPABILITY_CATEGORIES = ["REMOTE_CONTROL", "DEBUGGING", "VIRTUALIZATION", "CAPTURE_OVERLAY", "NAVIGATION_ESCAPE"] as const;
export type LockdownCapabilityCategoryName = (typeof LOCKDOWN_CAPABILITY_CATEGORIES)[number];

export const LOCKDOWN_CAPABILITY_ACTIONS = ["BLOCK_BEFORE_EXAM", "BLOCK_DURING_EXAM", "WARN_AND_REQUIRE_CLOSE", "DETECT_AND_RECORD", "NOT_SUPPORTED"] as const;
export type LockdownCapabilityActionName = (typeof LOCKDOWN_CAPABILITY_ACTIONS)[number];

/**
 * Part 11 — "a prohibited app appearing during an active exam" is the
 * ONLY thing this feature ever writes to IntegrityEvent. The category
 * maps to one of the three specific "detected" event types where a
 * closer match exists; VIRTUALIZATION (which has no dedicated name in
 * the task's own suggested vocabulary) and any future category fall
 * back to the generic PROHIBITED_APPLICATION_DETECTED. NAVIGATION_ESCAPE
 * never reaches this function at all — those are PlatformAuditLog-only
 * facts (denied navigation/download/window-open), never a reviewable
 * integrity signal on their own.
 */
export function integrityEventTypeForCapabilityCategory(category: LockdownCapabilityCategoryName): IntegrityEventTypeName {
  switch (category) {
    case "REMOTE_CONTROL":
      return "REMOTE_CONTROL_SOFTWARE_DETECTED";
    case "CAPTURE_OVERLAY":
      return "SCREEN_CAPTURE_SOFTWARE_DETECTED";
    case "DEBUGGING":
      return "DEBUGGING_TOOL_DETECTED";
    case "VIRTUALIZATION":
    case "NAVIGATION_ESCAPE":
      return "PROHIBITED_APPLICATION_DETECTED";
  }
}

export const PROHIBITED_APPLICATION_CLOSED_EVENT_TYPE: IntegrityEventTypeName = "PROHIBITED_APPLICATION_CLOSED";

/**
 * Part 11 — severity follows the capability's EFFECTIVE action (already
 * resolved against the registry + server-served policy toggles by the
 * time this is called), not a single fixed value per event type: a
 * capability currently downgraded to DETECT_AND_RECORD by a policy
 * toggle (Part 12) must stay INFO-tier — recorded for awareness, never
 * contributing integrity risk — exactly as
 * docs/tether-windows-lockdown-hardening-v1.md documents for every
 * DETECT_AND_RECORD-classified capability. Only a genuinely
 * BLOCK_DURING_EXAM-effective detection is MEDIUM. See
 * src/lib/secureExam.ts's severityFor() for the generic per-event-type
 * default this deliberately overrides with capability-specific context
 * — the same pattern that function already uses for
 * CAMERA_UNAVAILABLE/settings.requireCamera.
 */
export function severityForLockdownDetection(effectiveAction: LockdownCapabilityActionName): IntegritySeverityLevel {
  return effectiveAction === "BLOCK_DURING_EXAM" ? "MEDIUM" : "INFO";
}

// ---------------------------------------------------------------------------
// PlatformAuditLog-only facts (Part 11) — never IntegrityEvent. A fixed
// allow-list the new audit-event route validates against, so the client
// can never write an arbitrary free-text action string.
// ---------------------------------------------------------------------------

export const LOCKDOWN_AUDIT_ACTIONS = [
  "TETHER_LOCKDOWN_PREFLIGHT_BLOCKED",
  "TETHER_LOCKDOWN_PROCESS_INSPECTION_UNAVAILABLE",
  "TETHER_LOCKDOWN_RESTORATION_STARTED",
  "TETHER_LOCKDOWN_RESTORATION_COMPLETED",
  "TETHER_LOCKDOWN_RESTORATION_FAILED",
  "TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE",
  "TETHER_LOCKDOWN_APPLICATION_CLOSED_BEFORE_OPEN",
  "TETHER_LOCKDOWN_NAVIGATION_DENIED",
  "TETHER_LOCKDOWN_DOWNLOAD_DENIED",
  "TETHER_LOCKDOWN_WINDOW_OPEN_DENIED",
  "TETHER_LOCKDOWN_REMOTE_SESSION_CHECK_FAILED_CLOSED",
  "TETHER_LOCKDOWN_VIRTUAL_MACHINE_INDICATOR",
] as const;
export type LockdownAuditAction = (typeof LOCKDOWN_AUDIT_ACTIONS)[number];

export function isLockdownAuditAction(value: unknown): value is LockdownAuditAction {
  return typeof value === "string" && (LOCKDOWN_AUDIT_ACTIONS as readonly string[]).includes(value);
}
