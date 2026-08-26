/**
 * Approved student exam workspace v2 — exam timer urgency. Presentation
 * only: derives a visual/accessible state from the exam's existing
 * authoritative remaining-time value (`remainingSecs`, already computed
 * in src/app/student/exams/[id]/page.tsx from the same countdown this
 * repo already uses for autosubmission). Never a second countdown
 * mechanism, and never touches submission timing, exam expiry, or
 * autosubmit behaviour — those all still key off the original value
 * this module only reads.
 */

export type TimerUrgency = "normal" | "warning" | "high" | "critical";

/**
 * Boundaries are inclusive at the lower edge of each more-urgent tier —
 * exactly 5:00 (300s) is already "warning", exactly 2:00 (120s) is
 * already "high", exactly 1:00 (60s) is already "critical".
 */
export function getTimerUrgency(remainingSeconds: number | null): TimerUrgency {
  if (remainingSeconds == null) return "normal";
  if (remainingSeconds <= 60) return "critical";
  if (remainingSeconds <= 120) return "high";
  if (remainingSeconds <= 300) return "warning";
  return "normal";
}

const TIMER_URGENCY_CLASSES: Record<TimerUrgency, string> = {
  normal: "border-gray-300 bg-gray-100 text-slate-900",
  warning: "border-orange-300 bg-orange-50 text-orange-700",
  high: "border-orange-400 bg-orange-100 text-orange-800",
  critical: "border-red-400 bg-red-50 text-red-700 font-bold",
};

export function timerUrgencyClasses(urgency: TimerUrgency): string {
  return TIMER_URGENCY_CLASSES[urgency];
}

/**
 * Rounded-minute phrasing for the three urgent tiers (matching the
 * approved copy exactly — "5 minutes remaining", not "5 minutes 0
 * seconds remaining"), exact minutes+seconds otherwise. A plain string
 * for `aria-label`/`title`, never `aria-live` — this is read on demand
 * by assistive tech, not re-announced every second as the countdown
 * ticks.
 */
export function timerAccessibleLabel(remainingSeconds: number | null, urgency: TimerUrgency): string {
  if (remainingSeconds == null) return "";
  if (urgency === "critical") return "1 minute remaining";
  if (urgency === "high") return "2 minutes remaining";
  if (urgency === "warning") return "5 minutes remaining";
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"} ${seconds} second${seconds === 1 ? "" : "s"} remaining`;
}
