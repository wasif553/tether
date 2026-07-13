/**
 * On-Device AI Camera Integrity Detection v1 — local exam-content
 * blur/overlay driven by AI camera violation events. See
 * docs/on-device-ai-integrity-detection-v1.md.
 *
 * This is distinct from browser/window blur (tab-switch or app focus
 * loss, handled by WINDOW_BLUR/WINDOW_FOCUS_RETURN in the student exam
 * page): this module blurs/blocks the exam question content itself when
 * an AI camera signal (second person, no person, phone, blocked/dark
 * camera) is detected, so the student sees a clear, dismissible
 * "needs attention" panel rather than the check happening invisibly.
 *
 * Pure, dependency-free helpers — no DOM, no React, no Prisma. Nothing
 * here is an automatic misconduct finding: acknowledging the overlay
 * only clears local UI state, never the backend IntegrityEvent record.
 */

export const AI_CAMERA_VIOLATION_OVERLAY_TITLE = "Integrity check needs attention";

/**
 * Neutral, non-accusatory reason text per AI camera signal. Never
 * "cheating," "misconduct," "caught," or "violation proven" — matches
 * the wording convention already enforced in integrityEventLabels.ts.
 */
const AI_CAMERA_VIOLATION_REASONS: Record<string, string> = {
  POSSIBLE_SECOND_PERSON_VISIBLE: "Possible second person visible",
  NO_PERSON_VISIBLE: "No person visible",
  POSSIBLE_PHONE_VISIBLE: "Possible phone visible",
  CAMERA_VIEW_BLOCKED: "Camera view may be blocked",
  CAMERA_TOO_DARK: "Camera view is too dark",
};

/** True only for the AI camera signal event types that should trigger the local exam-content overlay. */
export function isAiCameraViolationEvent(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AI_CAMERA_VIOLATION_REASONS, eventType);
}

/** Neutral reason text for a given event type, or null if it is not an AI camera violation event. */
export function reasonForAiCameraViolation(eventType: string): string | null {
  return AI_CAMERA_VIOLATION_REASONS[eventType] ?? null;
}

export type AiCameraViolationOverlayState = {
  active: boolean;
  title: string;
  reason: string;
};

/** Builds the overlay state for an AI camera violation event, or null for any other event type. */
export function createAiCameraViolationOverlay(eventType: string): AiCameraViolationOverlayState | null {
  const reason = reasonForAiCameraViolation(eventType);
  if (reason == null) return null;
  return { active: true, title: AI_CAMERA_VIOLATION_OVERLAY_TITLE, reason };
}

/** The overlay is purely local UI state — acknowledging it always just clears it back to null. */
export function clearAiCameraViolationOverlay(): null {
  return null;
}

export type AiCameraIntegrityReportHandlers = {
  /** Synchronously updates local overlay state — called before `sendToBackend`, regardless of its outcome. */
  setOverlay: (overlay: AiCameraViolationOverlayState) => void;
  /** Reports the event to the backend. May reject; rejection must never affect local overlay state. */
  sendToBackend: () => Promise<unknown>;
};

/**
 * Orchestrates the "overlay-first, backend-second" contract for
 * integrity events: if `eventType` is an AI camera violation, the local
 * overlay is set synchronously — before `sendToBackend` is even called,
 * and independent of whether it later resolves or rejects. A
 * `sendToBackend` rejection is swallowed here so it can never clear or
 * otherwise affect an already-shown overlay (mirrors the existing
 * "reporting failures should never interrupt the exam session" rule).
 * Non-AI-camera event types still call `sendToBackend` but never touch
 * overlay state.
 */
export async function handleAiCameraIntegrityReport(
  eventType: string,
  handlers: AiCameraIntegrityReportHandlers,
): Promise<void> {
  const overlay = createAiCameraViolationOverlay(eventType);
  if (overlay) {
    handlers.setOverlay(overlay);
  }
  try {
    await handlers.sendToBackend();
  } catch {
    // Backend logging failures must never affect the local overlay — it
    // reflects on-device detection, not backend acknowledgment.
  }
}
