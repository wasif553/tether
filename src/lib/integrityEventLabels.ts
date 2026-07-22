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
  NO_PERSON_VISIBLE: "No student visible in camera — needs review",
  CAMERA_VIEW_BLOCKED: "Camera view appears blocked — needs review",
  CAMERA_TOO_DARK: "Camera view appears too dark — needs review",
  AI_CAMERA_CHECK_UNAVAILABLE: "AI camera checks unavailable",
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
};

export function labelForEventType(eventType: string): string {
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
export type IntegrityEventCategory = "evidence" | "camera" | "screen" | "window" | "info";

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
]);

const WINDOW_FOCUS_EVENT_TYPES = new Set([
  "FULLSCREEN_EXIT",
  "FULLSCREEN_FORCED_RETURN",
  "WINDOW_BLUR",
  "WINDOW_FOCUS_RETURN",
]);

export function categoryForEventType(eventType: string): IntegrityEventCategory {
  if (EVIDENCE_EVENT_TYPES.has(eventType)) return "evidence";
  if (CAMERA_EVENT_TYPES.has(eventType)) return "camera";
  if (SCREEN_SHARE_EVENT_TYPES.has(eventType)) return "screen";
  if (WINDOW_FOCUS_EVENT_TYPES.has(eventType)) return "window";
  return "info";
}

export const INTEGRITY_EVENT_CATEGORY_LABELS: Record<IntegrityEventCategory, string> = {
  evidence: "Evidence events",
  camera: "Camera events",
  screen: "Screen-share events",
  window: "Window/focus events",
  info: "Info events",
};
