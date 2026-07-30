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
