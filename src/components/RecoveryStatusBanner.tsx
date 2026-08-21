"use client";

/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — student-facing
 * connection/save status banner. See
 * docs/tether-secure-resume-recovery-v1.md, "Network interruption" (Part
 * 4) and "Accessibility" (Part 16).
 *
 * MCQ interaction stability — product decision (physical acceptance
 * follow-up, exam-workspace-and-left-nav pass): ordinary, successful
 * autosave (IDLE/SENDING/pendingCount>0/SAVED) is now SILENT — no visible
 * banner at all, only a screen-reader-only aria-live announcement. Two
 * earlier attempts fixed this differently (always rendering a real box,
 * first mounting/unmounting it, then reserving a fixed min-height for it)
 * and both still let ordinary save activity draw the student's eye/cursor
 * near the question on every answer change. Removing the visible message
 * for the ROUTINE path is the actual fix; a student does not need to be
 * told "saving" on every click, and the radio control itself already
 * gives immediate visual feedback (it becomes checked).
 *
 * Exceptional states (offline, FAILED, CONFLICT, resume-required) remain
 * fully visible — these matter and must not be hidden — but now render as
 * a `position: fixed` overlay, entirely outside normal document flow.
 * That is what makes this genuinely non-reflowing: unlike the min-height
 * reservation this replaces, a `fixed` element's own appearance,
 * disappearance, or content change can never move ANY sibling in the
 * page, by construction — there is nothing left for a future edit to
 * accidentally regress the way a stacked/reserved-space layout can.
 *
 * Deliberately calm, plain-language: every state pairs a short text label
 * with its own distinct wording (never just a dot/icon colour change).
 * Uses ONLY the approved product language from the spec — see
 * src/lib/tetherRecovery.ts's RECOVERY_STATE_COPY for the recovery-state
 * half of this vocabulary; the local save/connection half below uses the
 * exact same approved phrases ("Connection interrupted", "Reconnecting",
 * "Changes waiting to save", "Saved", "Save could not yet be confirmed").
 */
import type { LocalSaveStatus } from "@/lib/pendingSaveQueue";

export type RecoveryStatusBannerProps = {
  connectionStatus: LocalSaveStatus | "IDLE";
  pendingCount: number;
  /** True while the browser itself reports offline (navigator.onLine === false) or the exam page's own NETWORK_OFFLINE tracking has fired. */
  offline: boolean;
  /** A short, already-localised recovery message from GET /api/submissions/[id]/recovery-status, e.g. "Resume secure examination". Only shown for states that need explicit action. */
  recoveryMessage?: string | null;
  onRetryNow?: () => void;
};

export function RecoveryStatusBanner({ connectionStatus, pendingCount, offline, recoveryMessage, onRetryNow }: RecoveryStatusBannerProps) {
  const showResume = Boolean(recoveryMessage);
  // Only these states are worth interrupting the student's view for —
  // ordinary pending/SAVED activity is deliberately excluded (see this
  // file's own doc comment above).
  const isExceptional = offline || showResume || connectionStatus === "FAILED" || connectionStatus === "CONFLICT";

  let text: string;
  let tone: "info" | "warning" | "error";
  if (showResume) {
    text = recoveryMessage!;
    tone = "warning";
  } else if (offline) {
    text = pendingCount > 0 ? `Connection interrupted. Reconnecting — ${pendingCount} change${pendingCount === 1 ? "" : "s"} waiting to save. Your examination timer continued.` : "Connection interrupted. Reconnecting — your examination timer continued.";
    tone = "warning";
  } else if (connectionStatus === "FAILED") {
    text = `Save could not yet be confirmed. ${pendingCount} change${pendingCount === 1 ? "" : "s"} waiting to save — retrying automatically.`;
    tone = "warning";
  } else if (connectionStatus === "CONFLICT") {
    text = "A newer saved version of this answer already exists. Contact your lecturer or exam support if this is unexpected.";
    tone = "error";
  } else if (pendingCount > 0) {
    // Ordinary save in flight — screen-reader-only text; never shown visually.
    text = "Saving.";
    tone = "info";
  } else if (connectionStatus === "SAVED") {
    // Ordinary save acknowledged — screen-reader-only text; never shown visually.
    text = "Saved.";
    tone = "info";
  } else {
    text = "";
    tone = "info";
  }

  if (!isExceptional) {
    // Silent by design for the routine path — no visible box, no
    // reserved space, nothing that can ever move the question/answer
    // controls. Still a genuine, permanently-mounted aria-live region so
    // a screen-reader user hears "Saving."/"Saved." without needing to
    // poll the page, exactly as before — just never rendered visually.
    return (
      <div className="sr-only" role="status" aria-live="polite">
        {text}
      </div>
    );
  }

  const toneClasses =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-gray-200 bg-gray-50 text-gray-700";

  return (
    // Fixed, full-width wrapper so the centered pill below is never offset
    // by the page's own horizontal scroll/gutter; pointer-events-none on
    // the wrapper (only the pill itself is interactive) so this can never
    // block a click on whatever happens to sit underneath it.
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex max-w-md items-center justify-between gap-3 rounded border px-3 py-2 text-xs shadow-lg ${toneClasses}`}
      >
        <span>{text}</span>
        {(showResume || connectionStatus === "FAILED") && onRetryNow && (
          <button
            type="button"
            onClick={onRetryNow}
            className="shrink-0 rounded border border-current px-2 py-1 text-xs focus:outline focus:outline-2 focus:outline-offset-1"
          >
            Retry now
          </button>
        )}
      </div>
    </div>
  );
}
