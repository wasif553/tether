/**
 * Tether launch/install flow v1 — pure support functions for
 * src/app/student/exams/[id]/tether-launch/page.tsx.
 *
 * Pure, dependency-free: no Next.js, no browser APIs, no fetch. A
 * webpage cannot claim to know with certainty that Tether Secure Browser
 * is installed — this module only builds the protocol-launch attempt and
 * decides the TIMING of the installer fallback; it never asserts success.
 */
import { DISPLAY_REQUIREMENT_STATUSES } from "./secureClientPolicy";

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

/**
 * P0 secure-launch redirect loop hotfix — see
 * docs/tether-secure-launch-loop-hotfix.md. The shape of
 * GET /api/submissions/[id]/secure-client/status's response this module
 * cares about (deliberately narrow — this file has no fetch of its own;
 * the caller fetches and passes the already-parsed body here).
 */
export type SecureClientStatusResponse = { session?: { verificationStatus?: string } | null } | null | undefined;

/**
 * THE authoritative navigation gate: a secure-launch attempt may only
 * proceed into exam content when the server-computed
 * SecureClientSession.verificationStatus is exactly "VERIFIED" — the
 * SAME field GET /api/submissions/[id]'s own TETHER_SESSION_REQUIRED
 * check is based on (never a second, client-derived approximation of
 * that decision). Missing/malformed/absent session data is always
 * "not eligible" — fails closed, never open.
 *
 * Root cause of the P0 redirect loop: tether-launch/page.tsx used to
 * navigate into the exam unconditionally after consuming a manifest and
 * submitting attestation, without ever checking this. Consuming a
 * manifest only CREATES a session (verificationStatus: NOT_CHECKED);
 * attestation can fail outright or resolve to a non-READY overall
 * status, and the session then never reaches VERIFIED. Navigating
 * anyway meant GET /api/submissions/[id] immediately bounced the student
 * back here, and the page's own auto-resume effect repeated the exact
 * same broken sequence — forever, with no stable failure state ever
 * shown.
 */
export function isSecureClientSessionVerified(status: SecureClientStatusResponse): boolean {
  return status?.session?.verificationStatus === "VERIFIED";
}

// ---------------------------------------------------------------------------
// Display-count bridge diagnostic — P0 runtime-failure capture. See
// docs/tether-secure-launch-verification-investigation.md. Purely
// classification/formatting logic, pure and unit-testable without a
// DOM/Electron bridge — the caller (submitInitialAttestation in
// tether-launch/page.tsx) does the actual bridge call and passes its
// outcome (or the caught exception) here.
// ---------------------------------------------------------------------------

export const DISPLAY_DIAGNOSTIC_OUTCOMES = [
  "DISPLAY_COUNT_OK",
  "SES_LOCKDOWN_UNAVAILABLE",
  "DISPLAY_COUNT_METHOD_UNAVAILABLE",
  "DISPLAY_COUNT_INVOKE_FAILED",
  "DISPLAY_COUNT_INVALID_RESULT",
] as const;
export type DisplayDiagnosticOutcome = (typeof DISPLAY_DIAGNOSTIC_OUTCOMES)[number];

export type DisplayDiagnostic = {
  outcome: DisplayDiagnosticOutcome;
  /** Only ever populated for DISPLAY_COUNT_INVOKE_FAILED. Bounded — see boundedDiagnosticString. */
  errorName?: string;
  errorMessage?: string;
};

const DISPLAY_DIAGNOSTIC_ERROR_NAME_MAX_LENGTH = 100;
const DISPLAY_DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH = 300;

/**
 * Truncates a value to a plain, bounded string for inclusion in a
 * diagnostic payload — never a stack trace, never an arbitrary object
 * (only ever called with `err.name`/`err.message`-shaped inputs, both
 * already plain strings on a real `Error`), and never longer than
 * `maxLength`. A non-string/non-primitive input is stringified minimally
 * (`String(value)`) rather than JSON-serialized, so it can never emit a
 * nested object/array structure that might carry more than intended.
 */
export function boundedDiagnosticString(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value : String(value);
  return raw.length > maxLength ? raw.slice(0, maxLength) : raw;
}

/**
 * Distinguishes SES_LOCKDOWN_UNAVAILABLE from DISPLAY_COUNT_METHOD_UNAVAILABLE
 * — the two states that were previously conflated into a single
 * DISPLAY_CHECK_BRIDGE_UNAVAILABLE checkpoint. `sesLockdown` is typed
 * `unknown` deliberately: this must be safe to call with anything a real
 * (or absent) `window.sesLockdown` could ever be, including `undefined`.
 */
export function classifyDisplayBridgeAvailability(sesLockdown: unknown): "SES_LOCKDOWN_UNAVAILABLE" | "DISPLAY_COUNT_METHOD_UNAVAILABLE" | "AVAILABLE" {
  if (sesLockdown === null || typeof sesLockdown !== "object") return "SES_LOCKDOWN_UNAVAILABLE";
  const candidate = (sesLockdown as { getDisplayCount?: unknown }).getDisplayCount;
  if (typeof candidate !== "function") return "DISPLAY_COUNT_METHOD_UNAVAILABLE";
  return "AVAILABLE";
}

/** Builds the bounded DISPLAY_COUNT_INVOKE_FAILED diagnostic from a caught exception — never a stack trace, never a filesystem path beyond whatever (rarely) appears in a short error message, never an arbitrary object. */
export function buildDisplayInvokeFailedDiagnostic(err: unknown): DisplayDiagnostic {
  return {
    outcome: "DISPLAY_COUNT_INVOKE_FAILED",
    errorName: boundedDiagnosticString(err instanceof Error ? err.name : typeof err, DISPLAY_DIAGNOSTIC_ERROR_NAME_MAX_LENGTH),
    errorMessage: boundedDiagnosticString(err instanceof Error ? err.message : String(err), DISPLAY_DIAGNOSTIC_ERROR_MESSAGE_MAX_LENGTH),
  };
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

// ---------------------------------------------------------------------------
// v1.7.4 pre-exam readiness — calm, factual PRECHECK/remediation copy. See
// docs/tether-preflight-lifecycle-v1.7.4.md and
// apps/lockdown/src/displayEnforcementLogic.ts's displayBlockingReasonCopy
// (the same taxonomy, mirrored here since apps/lockdown is a separately
// compiled package — never imported directly by the web app). Every
// message here is factual and non-accusatory: never infers misconduct,
// never claims an additional display exists unless the reason is genuine
// display evidence (never for POLICY_NOT_READY-shaped or
// inconclusive/technical-failure reasons — see Part 7 of the
// investigation this fixes).
// ---------------------------------------------------------------------------

export type PreflightIssue = { title: string; message: string; applicationNames?: string[] };

const DISPLAY_PREFLIGHT_REASON_COPY: Record<string, PreflightIssue> = {
  ADDITIONAL_ELECTRON_DISPLAY: { title: "Additional display connected", message: "Disconnect all additional, mirrored or extended displays, then select Recheck." },
  WINDOWS_TOPOLOGY_EXTEND: { title: "Extended display detected", message: "An extended display was detected. Disconnect it, then select Recheck." },
  WINDOWS_TOPOLOGY_CLONE: { title: "Mirrored display detected", message: "A mirrored or duplicated display was detected. Disconnect it, then select Recheck." },
  MULTIPLE_ACTIVE_TARGETS: { title: "Additional display connected", message: "Disconnect all additional, mirrored or extended displays, then select Recheck." },
  TOPOLOGY_CHECK_UNAVAILABLE: {
    title: "Display configuration could not be verified",
    message: "Tether could not verify the display configuration. Resolve the display check and select Recheck before beginning the examination.",
  },
};

/**
 * Part 8 — the Phase 1 PRECHECK's own fresh, read-only display check
 * (window.sesLockdown.getDisplayTopology()). Reports EXACTLY what
 * Windows observed — never labels a genuinely inconclusive/failed query
 * as "additional display connected" (the confirmed BLOCKED==ADDITIONAL_DISPLAY_PRESENT
 * bug this whole pass fixes). Returns null when the display requirement
 * is currently satisfied (no remediation needed).
 */
export function resolveDisplayPreflightIssue(electronDisplayCount: number, topologyClassification: string): PreflightIssue | null {
  if (electronDisplayCount > 1) return DISPLAY_PREFLIGHT_REASON_COPY.ADDITIONAL_ELECTRON_DISPLAY;
  if (topologyClassification === "EXTEND") return DISPLAY_PREFLIGHT_REASON_COPY.WINDOWS_TOPOLOGY_EXTEND;
  if (topologyClassification === "CLONE_OR_DUPLICATE") return DISPLAY_PREFLIGHT_REASON_COPY.WINDOWS_TOPOLOGY_CLONE;
  if (topologyClassification === "MULTIPLE_ACTIVE_TARGETS") return DISPLAY_PREFLIGHT_REASON_COPY.MULTIPLE_ACTIVE_TARGETS;
  if (topologyClassification === "ERROR" || topologyClassification === "UNKNOWN") return DISPLAY_PREFLIGHT_REASON_COPY.TOPOLOGY_CHECK_UNAVAILABLE;
  return null;
}

/**
 * Phase 2E/2G — maps a FAILED window.sesLockdown.activateSecureExamLockdown()
 * result (see apps/lockdown/src/main.ts's SecureExamLockdownActivationResult)
 * to the same calm PreflightIssue shape, so a race-condition failure
 * (TeamViewer/a second display appearing between the calm PRECHECK and
 * Begin examination) is shown with the exact same factual wording as the
 * original precheck — never a generic/alarming error. `capabilityDisplayNames`
 * is the same bounded id->displayName map runLockdownPreflightScan's
 * BLOCKED handling already resolves via ensureLockdownBridgeInitialized —
 * reused here, never a second lookup mechanism.
 */
export function resolveActivationFailureIssue(
  result: { reason: string; matchedCapabilityIds?: string[] },
  capabilityDisplayNames?: Map<string, string>,
): PreflightIssue {
  if (result.reason === "PROHIBITED_APPLICATION") {
    const names = (result.matchedCapabilityIds ?? []).map((id) => capabilityDisplayNames?.get(id) ?? "an application");
    return {
      title: "Close applications before continuing",
      message: "Tether found applications that may allow screen sharing, remote access, recording or debugging. Close the listed applications, then select Recheck.",
      applicationNames: [...new Set(names)],
    };
  }
  if (result.reason === "PROCESS_CHECK_UNAVAILABLE") {
    return { title: "Application check could not be completed", message: "Tether could not verify that prohibited applications are closed. Restart Tether or contact exam support." };
  }
  if (result.reason === "REMOTE_SESSION_DETECTED") {
    return { title: "Remote Desktop session detected", message: "This computer is connected to over Remote Desktop. End the remote session, then select Recheck." };
  }
  if (result.reason === "REMOTE_SESSION_CHECK_UNAVAILABLE") {
    return { title: "Remote session check could not be completed", message: "Tether could not verify the remote-session status of this computer. Restart Tether or contact exam support." };
  }
  if (result.reason in DISPLAY_PREFLIGHT_REASON_COPY) {
    return DISPLAY_PREFLIGHT_REASON_COPY[result.reason];
  }
  return { title: "Tether could not start this examination", message: "Something went wrong preparing your secure exam session. Select Recheck to try again." };
}

// ---------------------------------------------------------------------------
// PR #22 release-blocking review — secure-activation failure
// reconciliation. See tether-launch/page.tsx's ensureSecureActivation.
//
// The gap: window.sesLockdown.activateSecureExamLockdown() succeeding
// means native lockdown (display enforcement, process detection,
// remote-session monitoring) is ALREADY active in the Electron main
// process — before the renderer ever calls
// POST /api/submissions/[id]/activate. If that POST fails, native
// lockdown must be restored to the pre-exam state (never left active
// with no authoritative server-side activation behind it). But a naive
// "any failure -> restore" rule is itself unsafe: some failures are
// AMBIGUOUS (the request may have reached the server and committed
// before the response was lost), and blindly restoring in that case
// could turn OFF lockdown while the timed exam is genuinely ACTIVE
// server-side. These pure functions classify exactly which case applies
// so the page component never has to guess.
// ---------------------------------------------------------------------------

export type ActivatePostOutcome = { kind: "SUCCESS" } | { kind: "DEFINITIVE_REJECTION"; code: string | null } | { kind: "AMBIGUOUS" };

/**
 * Every non-2xx path in POST /api/submissions/[id]/activate (401
 * Unauthorized, 404 Not found, 409 SUBMISSION_NOT_IN_PROGRESS, 403
 * SECURE_SESSION_NOT_VERIFIED) returns BEFORE the route ever touches
 * `activatedAt` — see that route's own doc comment. That structural fact
 * is what makes a successfully-received response with one of these
 * statuses trustworthy proof the write never happened, regardless of
 * whether its JSON body parsed. Anything else — the fetch itself
 * throwing (network failure, timeout/abort), or a status this route
 * cannot actually produce (500, or any other unrecognized code) — is
 * NOT proof of anything: the request may have reached the server and
 * committed before the response was lost. Only a genuine 2xx is treated
 * as SUCCESS; only these four specific statuses are trusted as a
 * DEFINITIVE_REJECTION. Every other outcome is AMBIGUOUS and must be
 * resolved by reconciliation (classifyReconciliationCheck below), never
 * guessed.
 */
const DEFINITIVE_ACTIVATE_REJECTION_STATUSES = [401, 403, 404, 409];

export function classifyActivatePostOutcome(params: { threw: boolean; status: number | null; code: string | null }): ActivatePostOutcome {
  if (params.threw || params.status == null) return { kind: "AMBIGUOUS" };
  if (params.status >= 200 && params.status < 300) return { kind: "SUCCESS" };
  if (DEFINITIVE_ACTIVATE_REJECTION_STATUSES.includes(params.status)) return { kind: "DEFINITIVE_REJECTION", code: params.code };
  return { kind: "AMBIGUOUS" };
}

export type ReconciliationOutcome = "ACTIVATED" | "NOT_ACTIVATED" | "UNDETERMINED";

/**
 * Classifies one read of GET /api/submissions/[id]/secure-client/status's
 * `activated` field (a plain boolean derived server-side from
 * `Submission.activatedAt !== null` — never question content, never the
 * raw timestamp) — the narrow, read-only, side-effect-free check used to
 * resolve an AMBIGUOUS POST /activate outcome. A non-ok response or a
 * non-boolean `activated` value both mean "this read itself proved
 * nothing" — UNDETERMINED, never guessed as either true or false.
 */
export function classifyReconciliationCheck(params: { ok: boolean; activated: unknown }): ReconciliationOutcome {
  if (!params.ok) return "UNDETERMINED";
  if (params.activated === true) return "ACTIVATED";
  if (params.activated === false) return "NOT_ACTIVATED";
  return "UNDETERMINED";
}

/** Shown after a DEFINITIVE_REJECTION, or after reconciliation definitively confirms NOT_ACTIVATED — native lockdown has already been restored by the time this is shown (see ensureSecureActivation). */
export function resolveServerActivationNotConfirmedIssue(): PreflightIssue {
  return {
    title: "Tether could not activate this examination",
    message: "The secure exam server did not confirm activation, so secure lockdown has been turned off again. Select Recheck to try again.",
  };
}

// ---------------------------------------------------------------------------
// PR #22 follow-up review — the UNDETERMINED activation-confirmation state
// is deliberately NOT a PreflightIssue. Every other PreflightIssue means
// "native lockdown is (or has been restored to) a known, safe, pre-exam
// state — Recheck and Return to dashboard are both always safe." That
// invariant does not hold here: the exam MAY already be genuinely ACTIVE
// server-side, with native lockdown correctly still on, and we simply
// could not confirm it. Treating this as an ordinary PreflightIssue would
// let the student navigate away via the same "Return to dashboard" link
// every other issue offers — an ordinary in-page navigation that unmounts
// this component — with no restoration guarantee either way. See
// ActivationConfirmationPending.tsx and tether-launch/page.tsx's own
// handling of this state.
// ---------------------------------------------------------------------------

export type ActivationConfirmationPendingCopy = { title: string; message: string; retryLabel: string };

export function resolveActivationConfirmationPendingCopy(): ActivationConfirmationPendingCopy {
  return {
    title: "Confirming exam start",
    message:
      "Tether could not confirm with the exam server whether this examination has started. Do not close Tether — your secure exam session may already be active. Select Retry to check again.",
    retryLabel: "Retry",
  };
}

// ---------------------------------------------------------------------------
// PR #22 follow-up review, Issue 2 — strict validation of
// GET /api/submissions/[id]/secure-client/status before it is ever used to
// decide whether activateSecureExamLockdown() should request a fresh
// display/remote-session check. A missing/failed/malformed response must
// NEVER silently resolve to "no check required" — that would let native
// activation proceed without a mandatory fresh check the frozen
// per-attempt policy actually requires. Returns null for ANYTHING that
// does not structurally match the known response contract; the caller's
// only correct response to null is to refuse to call
// activateSecureExamLockdown at all, never to default the missing fields
// to false.
// ---------------------------------------------------------------------------

export type ValidatedSecureClientStatusForActivation = {
  requireSingleDisplay: boolean;
  requireRemoteSessionCheck: boolean;
};

export function parseSecureClientStatusForActivation(body: unknown): ValidatedSecureClientStatusForActivation | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;

  const displayRequirement = record.displayRequirement;
  if (typeof displayRequirement !== "object" || displayRequirement === null) return null;
  const displayStatus = (displayRequirement as Record<string, unknown>).status;
  if (typeof displayStatus !== "string" || !(DISPLAY_REQUIREMENT_STATUSES as readonly string[]).includes(displayStatus)) {
    return null;
  }

  if (typeof record.requireRemoteSessionCheck !== "boolean") return null;

  return {
    requireSingleDisplay: displayStatus === "ENFORCED_BY_SECURE_CLIENT",
    requireRemoteSessionCheck: record.requireRemoteSessionCheck,
  };
}

/** Shown when secure-client/status could not be fetched or failed strict validation — native activation is never attempted in this state. */
export function resolveSecureClientStatusUnavailableIssue(): PreflightIssue {
  return {
    title: "Tether could not verify this examination's secure policy",
    message: "Tether could not confirm the required secure-client checks for this examination. Select Recheck to try again.",
  };
}
