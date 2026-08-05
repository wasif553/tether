"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type CanvasStatus = "NOT_READY" | "PENDING" | "SENT" | "FAILED" | "SKIPPED" | null;

type SubmissionRow = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  totalScore: number | null;
  attemptNumber: number;
  startedAt: string;
  submittedAt: string | null;
  student: { id: string; name: string; email: string };
  canvasStatus: CanvasStatus;
  // Tether System Check and Exam Readiness v1 — see
  // docs/tether-system-check-v1.md. The student's most recent check,
  // regardless of which exam it was run for; null means not checked yet.
  systemCheck: { overallStatus: "READY" | "READY_WITH_WARNINGS" | "NOT_READY"; checkedAt: string; clientVersion: string | null } | null;
  // Tether Secure Exam Recovery and Resilient Autosave v1 (Part 12) — see
  // docs/tether-secure-resume-recovery-v1.md. Compact status only: never
  // local answer contents, tokens, public keys, signatures, installation
  // secrets, or internal stack traces. Null for a non-Tether exam or a
  // submission with no recovery-relevant activity yet.
  recovery: {
    state: string;
    label: string;
    lastServerContactAt: string | null;
    resumeCount: number;
    pendingSaveCount: number | null;
  } | null;
  // Tether Windows Lockdown Hardening v1 (Part 14) — see
  // docs/tether-windows-lockdown-hardening-v1.md. Compact status only:
  // never a raw process list, executable path, or capability id list.
  // Null for a non-Tether exam or a submission with no lockdown-relevant
  // activity yet.
  lockdown: {
    state: "NONE" | "DETECTED" | "CLOSED" | "DETECTION_UNAVAILABLE";
    label: string;
    capabilityCategory: string | null;
    detectedAt: string | null;
    clearedAt: string | null;
    durationMs: number | null;
    needsReview: boolean;
  } | null;
};

const SYSTEM_CHECK_LABELS: Record<"READY" | "READY_WITH_WARNINGS" | "NOT_READY", string> = {
  READY: "Ready",
  READY_WITH_WARNINGS: "Ready, with warnings",
  NOT_READY: "Not ready",
};

const SYSTEM_CHECK_STYLES: Record<"READY" | "READY_WITH_WARNINGS" | "NOT_READY", string> = {
  READY: "bg-green-100 text-green-700",
  READY_WITH_WARNINGS: "bg-amber-100 text-amber-800",
  NOT_READY: "bg-red-100 text-red-700",
};

function SystemCheckBadge({ systemCheck }: { systemCheck: SubmissionRow["systemCheck"] }) {
  if (!systemCheck) {
    return <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Not checked</span>;
  }
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs ${SYSTEM_CHECK_STYLES[systemCheck.overallStatus]}`}
      title={`Checked ${new Date(systemCheck.checkedAt).toLocaleString()}${systemCheck.clientVersion ? ` — client ${systemCheck.clientVersion}` : ""}`}
    >
      {SYSTEM_CHECK_LABELS[systemCheck.overallStatus]}
    </span>
  );
}

const CANVAS_STATUS_LABELS: Record<NonNullable<CanvasStatus>, string> = {
  NOT_READY: "Not ready to send",
  PENDING: "Sending...",
  SENT: "Sent",
  FAILED: "Failed — retry",
  SKIPPED: "Not linked to Canvas",
};

const CANVAS_STATUS_STYLES: Record<NonNullable<CanvasStatus>, string> = {
  NOT_READY: "bg-gray-100 text-gray-600",
  PENDING: "bg-blue-100 text-blue-700",
  SENT: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  SKIPPED: "bg-gray-100 text-gray-500",
};

function CanvasBadge({ status }: { status: CanvasStatus }) {
  if (!status) return null;
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${CANVAS_STATUS_STYLES[status]}`}>
      {CANVAS_STATUS_LABELS[status]}
    </span>
  );
}

// Tether Secure Exam Recovery and Resilient Autosave v1 (Part 12) — see
// docs/tether-secure-resume-recovery-v1.md. Same badge micro-pattern as
// CanvasBadge/SystemCheckBadge above.
const RECOVERY_BADGE_STYLES: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-700",
  Resumed: "bg-blue-100 text-blue-700",
  TEMPORARILY_DISCONNECTED: "bg-amber-100 text-amber-800",
  MANUAL_REVIEW_REQUIRED: "bg-red-100 text-red-700",
  SUBMITTED: "bg-gray-100 text-gray-600",
  EXPIRED: "bg-gray-100 text-gray-500",
  DEFAULT: "bg-gray-100 text-gray-600",
};

function RecoveryBadge({ recovery }: { recovery: SubmissionRow["recovery"] }) {
  if (!recovery || recovery.state === "NOT_STARTED") return null;
  const styleKey = recovery.label === "Resumed" ? "Resumed" : recovery.state;
  const title = [
    recovery.lastServerContactAt ? `Last server contact ${new Date(recovery.lastServerContactAt).toLocaleString()}` : "No server contact yet",
    `Resume count: ${recovery.resumeCount}`,
    recovery.pendingSaveCount != null ? `Pending saves: ${recovery.pendingSaveCount}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${RECOVERY_BADGE_STYLES[styleKey] ?? RECOVERY_BADGE_STYLES.DEFAULT}`} title={title}>
      {recovery.label}
    </span>
  );
}

// Tether Windows Lockdown Hardening v1 (Part 14) — same badge
// micro-pattern as RecoveryBadge/SystemCheckBadge above. "Needs review"
// (a currently-DETECTED, not-yet-closed signal) is the only state that
// warrants an eye-catching colour — a resolved/closed episode is calm
// (informational), and "detection unavailable" is neutral (a technical
// fact, not a signal about the student).
const LOCKDOWN_BADGE_STYLES: Record<string, string> = {
  DETECTED: "bg-red-100 text-red-700",
  CLOSED: "bg-gray-100 text-gray-600",
  DETECTION_UNAVAILABLE: "bg-amber-100 text-amber-800",
};

function LockdownBadge({ lockdown }: { lockdown: SubmissionRow["lockdown"] }) {
  if (!lockdown || lockdown.state === "NONE") return null;
  const title = [
    lockdown.capabilityCategory ? `Category: ${lockdown.capabilityCategory}` : null,
    lockdown.detectedAt ? `Detected ${new Date(lockdown.detectedAt).toLocaleString()}` : null,
    lockdown.clearedAt ? `Closed ${new Date(lockdown.clearedAt).toLocaleString()}` : null,
    lockdown.durationMs != null ? `Duration: ${Math.round(lockdown.durationMs / 1000)}s` : null,
    lockdown.needsReview ? "Needs review" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${LOCKDOWN_BADGE_STYLES[lockdown.state] ?? LOCKDOWN_BADGE_STYLES.CLOSED}`} title={title}>
      {lockdown.label}
    </span>
  );
}

export default function SubmissionsListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/exams/${id}/submissions`)
      .then((res) => res.json())
      .then(setSubmissions)
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Submissions</h1>

      <div className="mt-6 space-y-3">
        {loading && <p className="text-gray-500">Loading...</p>}
        {!loading && submissions.length === 0 && (
          <p className="text-gray-500">No submissions yet.</p>
        )}
        {submissions.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between rounded border border-gray-200 p-4"
          >
            <div>
              <p className="font-medium">{s.student.name}</p>
              <p className="text-sm text-gray-500">{s.student.email}</p>
              <p className="text-xs text-gray-500">Attempt {s.attemptNumber}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">
                {s.status === "GRADED" ? `Score: ${s.totalScore}` : s.status}
              </span>
              <CanvasBadge status={s.canvasStatus} />
              <SystemCheckBadge systemCheck={s.systemCheck} />
              <RecoveryBadge recovery={s.recovery} />
              <LockdownBadge lockdown={s.lockdown} />
              <Link
                href={`/lecturer/submissions/${s.id}/evidence`}
                className="text-sm underline"
              >
                Evidence
              </Link>
              {s.status !== "IN_PROGRESS" && (
                <Link
                  href={`/lecturer/exams/${id}/submissions/${s.id}`}
                  className="rounded bg-black px-3 py-1.5 text-sm text-white"
                >
                  {s.status === "GRADED" ? "Review" : "Grade"}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
