/**
 * Tether Windows Lockdown Hardening v1 — lecturer visibility (Part 14).
 * See docs/tether-windows-lockdown-hardening-v1.md.
 *
 * Batched (never N+1) — mirrors resolveExamSubmissionsRecoveryStatuses's
 * own convention in tetherRecoveryRunner.ts. Compact fields only: the
 * most recent lockdown-related signal per submission — never a full
 * process list, capability id list, or per-event history. "Needs
 * review" is true only for a currently-DETECTED (not yet closed)
 * BLOCK_DURING_EXAM/DETECT_AND_RECORD signal — a resolved/closed episode
 * or a WARN_AND_REQUIRE_CLOSE-only preflight fact never needs review on
 * its own (see IntegrityEvent's own reviewStatus workflow for the
 * lecturer's actual review action, unaffected by this compact summary).
 */
import { prisma } from "@/lib/prisma";

const LOCKDOWN_DETECTION_EVENT_TYPES = [
  "REMOTE_CONTROL_SOFTWARE_DETECTED",
  "SCREEN_CAPTURE_SOFTWARE_DETECTED",
  "DEBUGGING_TOOL_DETECTED",
  "PROHIBITED_APPLICATION_DETECTED",
  "PROHIBITED_APPLICATION_CLOSED",
] as const;

export type LecturerLockdownStatus = {
  state: "NONE" | "DETECTED" | "CLOSED" | "DETECTION_UNAVAILABLE";
  label: string;
  /** REMOTE_CONTROL / DEBUGGING / VIRTUALIZATION / CAPTURE_OVERLAY, or null if unknown/not applicable. */
  capabilityCategory: string | null;
  detectedAt: Date | null;
  clearedAt: Date | null;
  durationMs: number | null;
  needsReview: boolean;
};

export async function resolveExamSubmissionsLockdownStatuses(submissionIds: string[]): Promise<Map<string, LecturerLockdownStatus>> {
  const result = new Map<string, LecturerLockdownStatus>();
  if (submissionIds.length === 0) return result;

  const events = await prisma.integrityEvent.findMany({
    where: { submissionId: { in: submissionIds }, eventType: { in: [...LOCKDOWN_DETECTION_EVENT_TYPES] } },
    orderBy: { occurredAt: "desc" },
    select: { submissionId: true, eventType: true, occurredAt: true, metadataJson: true },
  });
  const latestEventBySubmission = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    if (!latestEventBySubmission.has(e.submissionId)) latestEventBySubmission.set(e.submissionId, e);
  }

  const unavailableLogs = await prisma.platformAuditLog.findMany({
    where: { targetType: "Submission", targetId: { in: submissionIds }, action: "TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE" },
    orderBy: { createdAt: "desc" },
    select: { targetId: true, createdAt: true },
  });
  const latestUnavailableBySubmission = new Map<string, Date>();
  for (const log of unavailableLogs) {
    if (log.targetId && !latestUnavailableBySubmission.has(log.targetId)) latestUnavailableBySubmission.set(log.targetId, log.createdAt);
  }

  for (const submissionId of submissionIds) {
    const latestEvent = latestEventBySubmission.get(submissionId);
    const unavailableAt = latestUnavailableBySubmission.get(submissionId);

    if (latestEvent && (!unavailableAt || latestEvent.occurredAt >= unavailableAt)) {
      const metadata = latestEvent.metadataJson as { category?: string; durationMs?: number; capabilityId?: string } | null;
      const stillDetected = latestEvent.eventType !== "PROHIBITED_APPLICATION_CLOSED";
      // Mid-exam remote-session monitoring v1 — PROHIBITED_APPLICATION_CLOSED
      // is the generic "cleared" event reused across every lockdown
      // capability; a REMOTE_DESKTOP_SESSION-tagged one gets its own
      // accurate wording here too, exactly like labelForEventType's own
      // override (integrityEventLabels.ts) — nothing was "closed" by the
      // student, an inbound Remote Desktop connection simply ended.
      const closedLabel = metadata?.capabilityId === "REMOTE_DESKTOP_SESSION" ? "Remote session ended" : "Application closed";
      result.set(submissionId, {
        state: stillDetected ? "DETECTED" : "CLOSED",
        label: stillDetected ? "Application detected" : closedLabel,
        capabilityCategory: metadata?.category ?? null,
        detectedAt: stillDetected ? latestEvent.occurredAt : null,
        clearedAt: stillDetected ? null : latestEvent.occurredAt,
        durationMs: !stillDetected ? (metadata?.durationMs ?? null) : null,
        needsReview: stillDetected,
      });
    } else if (unavailableAt) {
      result.set(submissionId, {
        state: "DETECTION_UNAVAILABLE",
        label: "Detection unavailable",
        capabilityCategory: null,
        detectedAt: null,
        clearedAt: null,
        durationMs: null,
        needsReview: false,
      });
    } else {
      result.set(submissionId, {
        state: "NONE",
        label: "No lockdown signals",
        capabilityCategory: null,
        detectedAt: null,
        clearedAt: null,
        durationMs: null,
        needsReview: false,
      });
    }
  }

  return result;
}
