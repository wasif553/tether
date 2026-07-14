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

export type AiCameraOverlayCondition = {
  eventType: string;
  /** Whether this signal's detection rule is currently satisfied — independent of the backend-logging cooldown. */
  conditionMet: boolean;
};

/**
 * Priority order used when more than one AI camera signal is true on the
 * same tick. Phone comes first: it is the highest-urgency signal (a
 * student can photograph a question and hide the phone again quickly),
 * so if a phone and, say, a second person are both detected in the same
 * frame, the overlay shows the phone reason.
 */
export const AI_CAMERA_OVERLAY_PRIORITY_ORDER = [
  "POSSIBLE_PHONE_VISIBLE",
  "POSSIBLE_SECOND_PERSON_VISIBLE",
  "NO_PERSON_VISIBLE",
  "CAMERA_VIEW_BLOCKED",
  "CAMERA_TOO_DARK",
];

/**
 * Picks which AI camera violation event type (if any) should currently
 * be shown as the local overlay, from this tick's per-signal
 * condition-met flags — in `AI_CAMERA_OVERLAY_PRIORITY_ORDER`. Returns
 * null when none of the conditions are currently true.
 */
export function pickActiveAiCameraOverlayEventType(conditions: AiCameraOverlayCondition[]): string | null {
  const metByType = new Map(conditions.map((c) => [c.eventType, c.conditionMet]));
  for (const eventType of AI_CAMERA_OVERLAY_PRIORITY_ORDER) {
    if (metByType.get(eventType)) return eventType;
  }
  return null;
}

/**
 * Computes the local overlay that should be visible THIS tick, driven
 * purely by current on-device detection conditions — deliberately
 * independent of the backend-logging cooldown (see
 * docs/on-device-ai-integrity-detection-v1.md, "Local overlay vs.
 * backend logging"). This is what lets the overlay reopen quickly after
 * the student acknowledges it, as long as the underlying signal is still
 * present: acknowledging only clears the previously-shown overlay
 * object, it never silences this per-tick recomputation. Returns null
 * when no condition currently holds, meaning the overlay should be
 * cleared or stay cleared.
 */
export function computeLocalAiCameraOverlay(
  conditions: AiCameraOverlayCondition[],
): AiCameraViolationOverlayState | null {
  const eventType = pickActiveAiCameraOverlayEventType(conditions);
  return eventType ? createAiCameraViolationOverlay(eventType) : null;
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
