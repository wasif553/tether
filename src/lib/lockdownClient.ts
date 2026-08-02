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
