"use client";

/**
 * Tether Secure Exam Recovery and Resilient Autosave v1 — student-facing
 * connection/save status banner. See
 * docs/tether-secure-resume-recovery-v1.md, "Network interruption" (Part
 * 4) and "Accessibility" (Part 16).
 *
 * Deliberately calm, plain-language, and never colour-alone: every state
 * pairs a short text label with its own distinct wording (never just a
 * dot/icon colour change), uses aria-live so a screen-reader user hears
 * the transition without needing to poll the page, and never flashes
 * (state changes are instant text swaps, no blinking/pulsing animation).
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
  if (!offline && !showResume && pendingCount === 0 && connectionStatus !== "FAILED" && connectionStatus !== "CONFLICT") {
    // Nothing worth announcing — steady-state SAVED/IDLE with nothing
    // pending renders nothing, so the banner never becomes visual noise
    // during ordinary, uneventful exam-taking.
    return null;
  }

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
    text = `Changes waiting to save (${pendingCount}).`;
    tone = "info";
  } else if (connectionStatus === "SAVED") {
    text = "Saved.";
    tone = "info";
  } else {
    return null;
  }

  const toneClasses =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-gray-200 bg-gray-50 text-gray-700";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-xs ${toneClasses}`}
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
  );
}
