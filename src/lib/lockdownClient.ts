/**
 * Tether Windows Lockdown Hardening v1 — shared browser-side helpers for
 * wiring the window.sesLockdown lockdown bridge into a page. See
 * docs/tether-windows-lockdown-hardening-v1.md.
 *
 * Every call here is best-effort and feature-detected (older packaged
 * Tether installs simply don't expose these bridge methods) — nothing
 * here ever throws into a caller that doesn't already expect a rejected
 * promise, and nothing here is the actual security boundary (that is
 * always the server-side route each of these eventually calls).
 */
import { integrityEventTypeForCapabilityCategory, severityForLockdownDetection, type LockdownCapabilityCategoryName, type LockdownCapabilityActionName } from "@/lib/lockdownEventClassification";

export type LockdownCapabilityInfo = { category: LockdownCapabilityCategoryName; displayName: string };

let cachedCapabilityInfo: Map<string, LockdownCapabilityInfo> | null = null;
let policyRelayed = false;

/**
 * Fetches the server-resolved policy toggles once (GET
 * /api/tether/lockdown/policy) and relays them to Electron main, and
 * fetches the bounded public capability metadata once — both cached at
 * module scope so re-mounting a component (e.g. a client-side
 * navigation back to this page) never re-fetches. Safe to call from
 * multiple call sites; only the first call in a page's lifetime actually
 * does any work.
 */
export async function ensureLockdownBridgeInitialized(): Promise<Map<string, LockdownCapabilityInfo>> {
  if (cachedCapabilityInfo) return cachedCapabilityInfo;
  if (policyRelayed) return cachedCapabilityInfo ?? new Map();
  policyRelayed = true;
  try {
    const [policyRes, capabilityInfo] = await Promise.all([fetch("/api/tether/lockdown/policy"), window.sesLockdown?.getLockdownCapabilityInfo?.() ?? Promise.resolve([])]);
    if (policyRes.ok) {
      const toggles = await policyRes.json();
      window.sesLockdown?.setLockdownPolicyToggles?.(toggles);
    }
    cachedCapabilityInfo = new Map(capabilityInfo.map((c) => [c.id, { category: c.category as LockdownCapabilityCategoryName, displayName: c.displayName }]));
  } catch {
    cachedCapabilityInfo = new Map();
  }
  return cachedCapabilityInfo ?? new Map();
}

/**
 * Part 11 — records exactly one capability transition. A DETECTED
 * transition becomes a category-specific reviewable IntegrityEvent
 * (BLOCK_DURING_EXAM -> MEDIUM) or an informational one
 * (DETECT_AND_RECORD -> INFO) via the existing
 * POST /api/submissions/[id]/integrity-events route; a CLEARED
 * transition becomes the generic PROHIBITED_APPLICATION_CLOSED event
 * (always INFO), carrying the computed duration in its metadata.
 * WARN_AND_REQUIRE_CLOSE is deliberately never reported here at all —
 * per its own registry documentation it is PlatformAuditLog-only and
 * never re-covers/re-records content reappearing mid-exam.
 */
export async function reportLockdownCapabilityTransition(params: {
  submissionId: string;
  capabilityId: string;
  effectiveAction: string;
  phase: "DETECTED" | "CLEARED";
  detectedAtMsForClear: number | null;
  capabilityInfo: Map<string, LockdownCapabilityInfo>;
}): Promise<void> {
  const info = params.capabilityInfo.get(params.capabilityId);
  const category = info?.category ?? "VIRTUALIZATION";
  const action = params.effectiveAction as LockdownCapabilityActionName;
  if (params.phase === "DETECTED") {
    if (action !== "BLOCK_DURING_EXAM" && action !== "DETECT_AND_RECORD") return;
    await postIntegrityEvent(params.submissionId, {
      eventType: integrityEventTypeForCapabilityCategory(category),
      severity: severityForLockdownDetection(action),
      message: `${info?.displayName ?? "An application"} was detected.`,
      metadata: { capabilityId: params.capabilityId, category, policyAction: action },
    });
    return;
  }
  const durationMs = params.detectedAtMsForClear != null ? Math.max(0, Date.now() - params.detectedAtMsForClear) : null;
  await postIntegrityEvent(params.submissionId, {
    eventType: "PROHIBITED_APPLICATION_CLOSED",
    severity: "INFO",
    message: `${info?.displayName ?? "An application"} was closed.`,
    metadata: { capabilityId: params.capabilityId, category, ...(durationMs != null ? { durationMs } : {}) },
  });
}

async function postIntegrityEvent(submissionId: string, body: { eventType: string; severity: string; message: string; metadata: Record<string, unknown> }): Promise<void> {
  try {
    await fetch(`/api/submissions/${submissionId}/integrity-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Best-effort — never blocks the exam.
  }
}

/**
 * Part 11 — process inspection unavailable during an active exam (never
 * an IntegrityEvent — see Part 11's classification rules). main.ts's own
 * examContext already scopes this to the right exam/submission — see
 * reportAuditFactBestEffort's own doc comment.
 */
export function reportLockdownScanUnavailable(reason: string): void {
  window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE", { reason });
}

/**
 * Mid-exam remote-session monitoring v1 — records exactly one
 * de-duplicated transition from RemoteSessionMonitor (Electron main; see
 * apps/lockdown/src/remoteSessionMonitor.ts), relayed over the dedicated
 * lockdown:remote-session-monitor-event channel rather than the generic
 * capability-transition one, since the metadata this needs to record for
 * lecturer review (detection source, session type where available, check
 * confidence, Tether version, secure-client session id) is qualitatively
 * richer than a plain process-name-match detection.
 *
 * Reuses the SAME event-type/severity rules as
 * reportLockdownCapabilityTransition: BECAME_ACTIVE ->
 * REMOTE_CONTROL_SOFTWARE_DETECTED (never a new event type — the current
 * model already represents an active Remote Desktop session accurately),
 * BECAME_INACTIVE -> the existing generic PROHIBITED_APPLICATION_CLOSED.
 * CHECK_UNAVAILABLE/CHECK_RECOVERED are PlatformAuditLog-only technical
 * facts, exactly like reportLockdownScanUnavailable above — never an
 * IntegrityEvent, and never a misconduct determination on their own.
 */
const REMOTE_SESSION_CAPABILITY_ID = "REMOTE_DESKTOP_SESSION";
const REMOTE_SESSION_CATEGORY: LockdownCapabilityCategoryName = "REMOTE_CONTROL";

export type RemoteSessionMonitorTransitionKind = "BECAME_ACTIVE" | "BECAME_INACTIVE" | "CHECK_UNAVAILABLE" | "CHECK_RECOVERED";

export type RemoteSessionMonitorClassification = {
  isRemoteSession: boolean;
  remoteSessionSignalSource: string;
  isLikelyVirtualMachine: boolean;
  vmSignatureMatched: string | null;
};

export async function reportRemoteSessionMonitorTransition(params: {
  submissionId: string;
  kind: RemoteSessionMonitorTransitionKind;
  effectiveAction: string;
  previousState: string | null;
  currentState: string | null;
  detectedAtMsForClear: number | null;
  classification: RemoteSessionMonitorClassification;
  tetherVersion: string;
  secureClientSessionId: string | null;
}): Promise<void> {
  const action = params.effectiveAction as LockdownCapabilityActionName;
  // The current detection mechanism (Win32 SM_REMOTESESSION + SESSIONNAME
  // corroboration — see windowsSessionDetectionLogic.ts) cannot reliably
  // distinguish RDP from Remote Assistance/Quick Assist; this is the most
  // specific "session type" value the check actually supports, never a
  // fabricated finer-grained one.
  const sessionType = params.classification.isRemoteSession ? "REMOTE_DESKTOP_SESSION" : null;
  const baseMetadata: Record<string, unknown> = {
    capabilityId: REMOTE_SESSION_CAPABILITY_ID,
    category: REMOTE_SESSION_CATEGORY,
    detectionSource: "WINDOWS_SESSION_API",
    previousState: params.previousState,
    currentState: params.currentState,
    sessionType,
    checkConfidence: params.classification.remoteSessionSignalSource,
    tetherVersion: params.tetherVersion,
    secureClientSessionId: params.secureClientSessionId,
    detectedAtMs: Date.now(),
  };

  if (params.kind === "BECAME_ACTIVE") {
    if (action !== "BLOCK_DURING_EXAM" && action !== "DETECT_AND_RECORD") return;
    await postIntegrityEvent(params.submissionId, {
      eventType: integrityEventTypeForCapabilityCategory(REMOTE_SESSION_CATEGORY),
      severity: severityForLockdownDetection(action),
      message: "A Remote Desktop session was detected — needs review.",
      metadata: { ...baseMetadata, policyAction: action },
    });
    return;
  }

  if (params.kind === "BECAME_INACTIVE") {
    const durationMs = params.detectedAtMsForClear != null ? Math.max(0, Date.now() - params.detectedAtMsForClear) : null;
    await postIntegrityEvent(params.submissionId, {
      eventType: "PROHIBITED_APPLICATION_CLOSED",
      severity: "INFO",
      message: "The Remote Desktop session ended.",
      metadata: { ...baseMetadata, ...(durationMs != null ? { durationMs } : {}) },
    });
    return;
  }

  // CHECK_UNAVAILABLE / CHECK_RECOVERED — PlatformAuditLog-only, never an IntegrityEvent.
  const auditAction = params.kind === "CHECK_UNAVAILABLE" ? "TETHER_LOCKDOWN_REMOTE_SESSION_MONITOR_CHECK_UNAVAILABLE" : "TETHER_LOCKDOWN_REMOTE_SESSION_MONITOR_CHECK_RECOVERED";
  window.sesLockdown?.reportLockdownAuditFact?.(auditAction, baseMetadata);
}
