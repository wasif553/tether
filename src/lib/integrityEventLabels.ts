/**
 * Friendly, calm labels for integrity event types — used anywhere an event
 * type is shown to a lecturer (integrity review page, evidence report,
 * CSV exports). Falls back to the raw event type string for any type not
 * listed here, so existing event types keep their current display.
 */
const EVENT_TYPE_LABELS: Partial<Record<string, string>> = {
  CAMERA_PERMISSION_GRANTED: "Camera permission granted",
  CAMERA_PERMISSION_DENIED: "Camera permission denied",
  CAMERA_STARTED: "Camera monitoring started",
  CAMERA_STOPPED: "Camera monitoring stopped",
  CAMERA_UNAVAILABLE: "Camera unavailable",
  CAMERA_HEARTBEAT_MISSED: "Camera heartbeat missed",
  CAMERA_PRECHECK_FAILED: "Camera pre-check failed",
  KEYBOARD_SHORTCUT_BLOCKED: "Keyboard shortcut blocked",
  FULLSCREEN_FORCED_RETURN: "Fullscreen restored",
  // Optional Student Verification + On-Device AI Camera Integrity
  // Detection v1 — neutral wording throughout; never "confirmed",
  // "cheating", or "caught" — see
  // docs/on-device-ai-integrity-detection-v1.md.
  STUDENT_VERIFICATION_CONFIRMED: "Student verification confirmed",
  POSSIBLE_PHONE_VISIBLE: "Possible mobile phone visible — needs review",
  POSSIBLE_SECOND_PERSON_VISIBLE: "Possible additional person visible — needs review",
  // Camera integrity reliability pass — exact required neutral lecturer-
  // evidence phrasing. Never "cheating detected", "misconduct confirmed",
  // or "student intentionally left" — see resolveCameraIntegrityState in
  // cameraIntegrityDetection.ts for the state model these labels surface.
  NO_PERSON_VISIBLE: "No person was visible for a sustained period",
  CAMERA_VIEW_BLOCKED: "Camera view appears blocked — needs review",
  CAMERA_TOO_DARK: "Lighting was too low to verify visibility",
  AI_CAMERA_CHECK_UNAVAILABLE: "AI camera checks unavailable",
  CAMERA_STREAM_UNAVAILABLE: "Camera stream unavailable",
  // Camera integrity reliability pass — the neutral "stable recovery"
  // label, mirroring Screen sharing restored / Fullscreen restored below.
  // Never implies the earlier absence was misconduct.
  CAMERA_VISIBILITY_RESTORED: "Camera visibility restored",
  // Screen-share Evidence Mode v1 — neutral wording throughout; never
  // "cheating", "misconduct", or "caught" — see
  // docs/screen-share-evidence-v1.md.
  SCREEN_SHARE_STARTED: "Screen sharing started",
  SCREEN_SHARE_PERMISSION_DENIED: "Screen-share permission denied",
  SCREEN_SHARE_UNAVAILABLE: "Screen sharing unavailable",
  SCREEN_SHARE_SURFACE_REJECTED: "Non-monitor screen share rejected",
  SCREEN_SHARE_INTERRUPTED: "Screen sharing interrupted — needs review",
  SCREEN_SHARE_RESTORED: "Screen sharing restored",
  SCREEN_SHARE_EVIDENCE_CAPTURED: "Screen evidence frame captured",
  SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED: "Screen evidence capture failed",
  // Tether Windows Lockdown Hardening v1 — neutral wording throughout;
  // "detected" never implies confirmed misconduct, only that Tether
  // observed a known application running — see
  // docs/tether-windows-lockdown-hardening-v1.md.
  REMOTE_CONTROL_SOFTWARE_DETECTED: "Remote-control software detected — needs review",
  SCREEN_CAPTURE_SOFTWARE_DETECTED: "Screen-capture software detected — needs review",
  DEBUGGING_TOOL_DETECTED: "Debugging tool detected — needs review",
  PROHIBITED_APPLICATION_DETECTED: "Prohibited application detected — needs review",
  PROHIBITED_APPLICATION_CLOSED: "Prohibited application closed",
  // Integrity Evidence Timeline v1 — see docs/integrity-evidence-timeline-v1.md.
  // These event types previously fell back to their raw enum string
  // (still-valid behaviour for any caller not listed here) — the
  // Timeline is the first surface to display window/focus/navigation/
  // network/timer events densely enough that the raw codes read poorly,
  // so friendly labels are added here rather than in a second, divergent
  // map. Purely additive — no existing behaviour changes for callers
  // that already handled these via the raw-string fallback.
  FULLSCREEN_EXIT: "Fullscreen exited",
  WINDOW_BLUR: "Window focus lost",
  WINDOW_FOCUS_RETURN: "Window focus restored",
  COPY_ATTEMPT: "Copy attempt",
  PASTE_ATTEMPT: "Paste attempt",
  RIGHT_CLICK_ATTEMPT: "Right-click attempt",
  DEVTOOLS_SUSPECTED: "Developer tools suspected",
  NETWORK_OFFLINE: "Network connection lost",
  NETWORK_ONLINE: "Network connection restored",
  AUTOSAVE_FAILED: "Autosave failed",
  TIMER_EXPIRED: "Exam timer expired",
  SUBMIT_AFTER_DEADLINE: "Submitted after the deadline",
  MANUAL_WARNING: "Manual warning issued",
  QUESTION_NAVIGATED_NEXT: "Moved to next question",
  QUESTION_NAVIGATED_PREVIOUS: "Moved to previous question",
  QUESTION_BACK_NAVIGATION_BLOCKED: "Back navigation blocked",
  QUESTION_NAVIGATED_DIRECT: "Jumped to a different question",
  QUESTION_DIRECT_NAVIGATION_BLOCKED: "Direct navigation blocked",
  AI_ASSISTANCE_LIMIT_REACHED: "Tether Controlled AI request limit reached",
  // AI_ASSISTANCE_USED/_REQUEST_BLOCKED/_RESPONSE_REGENERATED/_REQUEST_FAILED
  // are given labels here for completeness (e.g. the evidence report CSV
  // export), but the Timeline builder deliberately suppresses these four
  // event types in favour of the richer AiAssistanceInteraction record —
  // see integrityEvidenceTimeline.ts's AI dedup rule.
  AI_ASSISTANCE_USED: "Tether Controlled AI guidance shown",
  AI_ASSISTANCE_REQUEST_BLOCKED: "Tether Controlled AI request declined",
  AI_ASSISTANCE_RESPONSE_REGENERATED: "Tether Controlled AI guidance regenerated",
  AI_ASSISTANCE_REQUEST_FAILED: "Tether Controlled AI request could not be completed",
};

/**
 * Mid-exam remote-session monitoring v1 — PROHIBITED_APPLICATION_CLOSED
 * is the generic "cleared" event, reused across every lockdown
 * capability (see lockdownEventClassification.ts), so its default label
 * ("Prohibited application closed") is accurate for a closed
 * TeamViewer/OBS/etc. but misleading for a Remote Desktop session
 * ending — nothing was "closed" by the student, the inbound connection
 * simply stopped. `metadata` is optional and additive: every existing
 * call site keeps its current behaviour unless it passes the event's
 * own metadataJson, in which case a REMOTE_DESKTOP_SESSION-tagged
 * PROHIBITED_APPLICATION_CLOSED gets this specific wording instead. The
 * underlying event TYPE is unchanged — this only overrides the
 * lecturer-facing presentation.
 */
const REMOTE_SESSION_ENDED_LABEL = "Remote session ended";

export function labelForEventType(eventType: string, metadata?: Record<string, unknown> | null): string {
  if (eventType === "PROHIBITED_APPLICATION_CLOSED" && metadata?.capabilityId === "REMOTE_DESKTOP_SESSION") {
    return REMOTE_SESSION_ENDED_LABEL;
  }
  return EVENT_TYPE_LABELS[eventType] ?? eventType;
}

/**
 * Coarse grouping used to visually separate the lecturer evidence
 * report's integrity event timeline into "Evidence", "Camera",
 * "Window/focus", and "Info" — so a lecturer isn't stuck scanning
 * hundreds of undifferentiated rows to find the signals that matter.
 * Deliberately conservative: only the two event types that can ever have
 * a captured camera evidence frame count as "evidence" here; everything
 * camera-related but never evidence-eligible (no-person/blocked/dark/
 * unavailable/heartbeat/etc.) is "camera".
 */
export type IntegrityEventCategory = "evidence" | "camera" | "screen" | "lockdown" | "window" | "info";

const EVIDENCE_EVENT_TYPES = new Set([
  "POSSIBLE_PHONE_VISIBLE",
  "POSSIBLE_SECOND_PERSON_VISIBLE",
  "SCREEN_SHARE_EVIDENCE_CAPTURED",
]);

const SCREEN_SHARE_EVENT_TYPES = new Set([
  "SCREEN_SHARE_STARTED",
  "SCREEN_SHARE_PERMISSION_DENIED",
  "SCREEN_SHARE_UNAVAILABLE",
  "SCREEN_SHARE_SURFACE_REJECTED",
  "SCREEN_SHARE_INTERRUPTED",
  "SCREEN_SHARE_RESTORED",
  "SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED",
]);

const CAMERA_EVENT_TYPES = new Set([
  "CAMERA_PERMISSION_GRANTED",
  "CAMERA_PERMISSION_DENIED",
  "CAMERA_STARTED",
  "CAMERA_STOPPED",
  "CAMERA_UNAVAILABLE",
  "CAMERA_HEARTBEAT_MISSED",
  "CAMERA_PRECHECK_FAILED",
  "NO_PERSON_VISIBLE",
  "CAMERA_VIEW_BLOCKED",
  "CAMERA_TOO_DARK",
  "AI_CAMERA_CHECK_UNAVAILABLE",
  "CAMERA_STREAM_UNAVAILABLE",
  "CAMERA_VISIBILITY_RESTORED",
]);

const WINDOW_FOCUS_EVENT_TYPES = new Set([
  "FULLSCREEN_EXIT",
  "FULLSCREEN_FORCED_RETURN",
  "WINDOW_BLUR",
  "WINDOW_FOCUS_RETURN",
]);

// Tether Windows Lockdown Hardening v1 — the only lockdown signals that
// ever become an IntegrityEvent (see
// docs/tether-windows-lockdown-hardening-v1.md, "Audit and evidence", and
// src/lib/lockdownEventClassification.ts). Everything else the Electron
// client reports (restoration lifecycle, preflight-blocked, remote-
// session checks, display-topology changes) is a technical/operational
// fact recorded elsewhere and never reaches this timeline at all.
const LOCKDOWN_DETECTION_EVENT_TYPES = new Set([
  "REMOTE_CONTROL_SOFTWARE_DETECTED",
  "SCREEN_CAPTURE_SOFTWARE_DETECTED",
  "DEBUGGING_TOOL_DETECTED",
  "PROHIBITED_APPLICATION_DETECTED",
  "PROHIBITED_APPLICATION_CLOSED",
]);

export function categoryForEventType(eventType: string): IntegrityEventCategory {
  if (EVIDENCE_EVENT_TYPES.has(eventType)) return "evidence";
  if (CAMERA_EVENT_TYPES.has(eventType)) return "camera";
  if (SCREEN_SHARE_EVENT_TYPES.has(eventType)) return "screen";
  if (LOCKDOWN_DETECTION_EVENT_TYPES.has(eventType)) return "lockdown";
  if (WINDOW_FOCUS_EVENT_TYPES.has(eventType)) return "window";
  return "info";
}

export const INTEGRITY_EVENT_CATEGORY_LABELS: Record<IntegrityEventCategory, string> = {
  evidence: "Evidence events",
  camera: "Camera events",
  screen: "Screen-share events",
  lockdown: "Lockdown detection events",
  window: "Window/focus events",
  info: "Info events",
};
