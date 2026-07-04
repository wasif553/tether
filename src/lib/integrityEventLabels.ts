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
};

export function labelForEventType(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? eventType;
}
