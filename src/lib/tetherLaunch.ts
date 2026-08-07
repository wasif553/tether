/**
 * Tether launch/install flow v1 — pure support functions for
 * src/app/student/exams/[id]/tether-launch/page.tsx.
 *
 * Pure, dependency-free: no Next.js, no browser APIs, no fetch. A
 * webpage cannot claim to know with certainty that Tether Secure Browser
 * is installed — this module only builds the protocol-launch attempt and
 * decides the TIMING of the installer fallback; it never asserts success.
 */

/**
 * The branded tether:// deep link for a given exam. Carries ONLY the
 * examId — a low-trust routing hint, never an authorization token or
 * credential (Requirement 4: "Do not pass only a mutable examId... never
 * place credentials in the installer"). The actual binding to
 * institutionId/studentId/submissionId/policyHash/expiry/nonce happens
 * entirely server-side/page-side once inside Tether and authenticated
 * (POST .../secure-client/launch issues the signed manifest; there is no
 * server-retained raw nonce to embed here even if we wanted to — see
 * secureClientRunner.ts issueLaunchManifest doc comment: the raw nonce
 * is returned to the caller exactly once and never persisted).
 */
export function buildTetherDeepLink(examId: string): string {
  return `tether://launch?examId=${encodeURIComponent(examId)}`;
}

/** Legacy-compatible ses:// deep link, preserved for existing pilot installations that haven't updated yet (Requirement 4). */
export function buildLegacySesDeepLink(examId: string): string {
  return `ses://launch?examId=${encodeURIComponent(examId)}`;
}

/**
 * Tether System Check and Exam Readiness v1 — an exam-less deep link for
 * "Open Tether Secure Browser" from a context with no specific exam in
 * mind (the system check page, or the dashboard's own prompt). Landing
 * with no examId is already handled by apps/lockdown/src/main.ts's
 * buildLoadUrl (falls back to the last known exam, or the plain
 * dashboard) — no protocol contract change needed.
 */
export function buildTetherDashboardDeepLink(): string {
  return "tether://launch";
}

export const DEFAULT_INSTALLER_FALLBACK_THRESHOLD_MS = 3000;

/**
 * A webpage can never know with certainty whether the protocol handler
 * actually opened an installed app — only that the attempt was made and
 * enough time has passed that it probably didn't. This function is the
 * one place that timing decision is made, so the page component stays
 * declarative and this logic stays unit-testable without a DOM/timers.
 */
export function shouldShowInstallerFallback(msSinceAttempt: number, thresholdMs: number = DEFAULT_INSTALLER_FALLBACK_THRESHOLD_MS): boolean {
  return msSinceAttempt >= thresholdMs;
}

export type TetherLaunchFailureCode = "REPLAY" | "EXPIRED" | "REVOKED" | "NOT_FOUND" | "INVALID_SIGNATURE" | "INVALID_NONCE" | "TRANSIENT_FAILURE";

/**
 * Neutral, non-accusatory retry copy for every way manifest issuance or
 * consumption can fail (mirrors the outcome codes returned by
 * POST /api/secure-client/launch/[manifestId]/consume). Never implies
 * misconduct — a REPLAY is just as likely to be a double-click or a
 * page refresh as anything else.
 */
export function resolveTetherLaunchFailureMessage(code: string): string {
  switch (code as TetherLaunchFailureCode) {
    case "REPLAY":
      return "This launch link has already been used. Select \"I have installed it — open examination\" to try again.";
    case "EXPIRED":
    case "INVALID_NONCE":
      return "This launch link has expired. Select \"I have installed it — open examination\" to get a fresh one.";
    case "REVOKED":
      return "This launch link is no longer valid. Select \"I have installed it — open examination\" to try again.";
    case "NOT_FOUND":
      return "This exam attempt could not be found. Return to your dashboard and try again.";
    case "INVALID_SIGNATURE":
      return "This launch link could not be verified. Select \"I have installed it — open examination\" to try again.";
    case "TRANSIENT_FAILURE":
      // URGENT fix — a server-side transaction failure (never a Tether
      // client problem), so this deliberately never mentions
      // reinstalling/checking Tether — that would misdirect the student
      // toward a fix that cannot help.
      return "Your secure exam could not be opened. Please try again. If the problem continues, contact support.";
    default:
      return "Something went wrong opening this exam. Select \"I have installed it — open examination\" to try again.";
  }
}
