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
};

export function labelForEventType(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] ?? eventType;
}
