"use client";

import { useEffect, useMemo, useState, use as usePromise } from "react";
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

function countLabel(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

const SYSTEM_CHECK_LABELS: Record<"READY" | "READY_WITH_WARNINGS" | "NOT_READY", string> = {
  READY: "Ready",
  READY_WITH_WARNINGS: "Ready, with warnings",
  NOT_READY: "Not ready",
};

const SYSTEM_CHECK_STYLES: Record<"READY" | "READY_WITH_WARNINGS" | "NOT_READY", string> = {
  READY: "bg-[#ECFDF3] text-[#067647]",
  READY_WITH_WARNINGS: "bg-[#FFFAEB] text-[#92400E]",
  NOT_READY: "bg-[#FEF2F2] text-[#DC2626]",
};

// Tether System Check and Exam Readiness v1 — a report on the student's
// DEVICE/BROWSER READINESS before the exam started. Deliberately kept
// separate from marking status: this says nothing about whether the
// submission has been graded.
function SystemCheckBadge({ systemCheck }: { systemCheck: SubmissionRow["systemCheck"] }) {
  if (!systemCheck) {
    return <span className="rounded-full bg-[#F2F4F7] px-2 py-0.5 text-xs font-medium text-[#667085]">Not checked</span>;
  }
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${SYSTEM_CHECK_STYLES[systemCheck.overallStatus]}`}
      title={`System check: ${new Date(systemCheck.checkedAt).toLocaleString()}${systemCheck.clientVersion ? ` — client ${systemCheck.clientVersion}` : ""}`}
    >
      System check: {SYSTEM_CHECK_LABELS[systemCheck.overallStatus]}
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
  NOT_READY: "bg-[#F2F4F7] text-[#667085]",
  PENDING: "bg-[#EFF6FF] text-[#1D4ED8]",
  SENT: "bg-[#ECFDF3] text-[#067647]",
  FAILED: "bg-[#FEF2F2] text-[#DC2626]",
  SKIPPED: "bg-[#F2F4F7] text-[#98A2B3]",
};

function CanvasBadge({ status }: { status: CanvasStatus }) {
  if (!status) return null;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CANVAS_STATUS_STYLES[status]}`}>
      Canvas: {CANVAS_STATUS_LABELS[status]}
    </span>
  );
}

// Tether Secure Exam Recovery and Resilient Autosave v1 (Part 12) — same
// badge micro-pattern as CanvasBadge/SystemCheckBadge above.
const RECOVERY_BADGE_STYLES: Record<string, string> = {
  ACTIVE: "bg-[#ECFDF3] text-[#067647]",
  Resumed: "bg-[#EFF6FF] text-[#1D4ED8]",
  TEMPORARILY_DISCONNECTED: "bg-[#FFFAEB] text-[#92400E]",
  MANUAL_REVIEW_REQUIRED: "bg-[#FEF2F2] text-[#DC2626]",
  SUBMITTED: "bg-[#F2F4F7] text-[#667085]",
  EXPIRED: "bg-[#F2F4F7] text-[#98A2B3]",
  DEFAULT: "bg-[#F2F4F7] text-[#667085]",
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
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RECOVERY_BADGE_STYLES[styleKey] ?? RECOVERY_BADGE_STYLES.DEFAULT}`} title={title}>
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
  DETECTED: "bg-[#FEF2F2] text-[#DC2626]",
  CLOSED: "bg-[#F2F4F7] text-[#667085]",
  DETECTION_UNAVAILABLE: "bg-[#FFFAEB] text-[#92400E]",
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
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${LOCKDOWN_BADGE_STYLES[lockdown.state] ?? LOCKDOWN_BADGE_STYLES.CLOSED}`} title={title}>
      {lockdown.label}
    </span>
  );
}

// Submissions Commercial UI Polish v1 — Marking status is derived purely
// from the EXISTING `status` enum (IN_PROGRESS/SUBMITTED/GRADED). This is
// not a new lifecycle — it's the same three values the API has always
// returned, just given accurate, human-readable labels instead of the
// raw enum string. See src/app/api/submissions/[id]/grade/route.ts:
// `status` only ever becomes "GRADED" in the same atomic update that
// computes and writes `totalScore`, so "Marked" and "a real totalScore
// exists" are always true together.
const MARKING_LABELS: Record<SubmissionRow["status"], string> = {
  IN_PROGRESS: "In progress",
  SUBMITTED: "Not marked",
  GRADED: "Marked",
};

// A genuine, already-stored "needs review" signal — never inferred or
// guessed. lockdown.needsReview and recovery.state ===
// "MANUAL_REVIEW_REQUIRED" are the only two review-need booleans this
// page's data actually exposes per submission; this does NOT cover
// camera/AI/screen-share/collusion signals, which live on the separate
// Integrity Review page and are intentionally not fetched here (see
// final report — no new API calls were added for this).
function needsReview(s: SubmissionRow): boolean {
  return Boolean(s.lockdown?.needsReview) || s.recovery?.state === "MANUAL_REVIEW_REQUIRED";
}

function hasAnySignal(s: SubmissionRow): boolean {
  return (
    s.systemCheck != null ||
    s.canvasStatus != null ||
    (s.recovery != null && s.recovery.state !== "NOT_STARTED") ||
    (s.lockdown != null && s.lockdown.state !== "NONE")
  );
}

function SubmissionMetric({
  label,
  value,
  accent = "neutral",
}: {
  label: string;
  value: number;
  accent?: "neutral" | "info" | "warning" | "success";
}) {
  const dotColor = {
    neutral: "bg-[#98A2B3]",
    info: "bg-[#2563EB]",
    warning: "bg-[#D97706]",
    success: "bg-[#067647]",
  }[accent];
  const tintClasses = accent === "warning" ? "border-[#FEDF89] bg-[#FFFAEB]" : "border-[#E4E7EC] bg-white";

  return (
    <div className={`rounded-xl border p-4 ${tintClasses}`}>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
        <span className="text-sm font-medium text-[#667085]">{label}</span>
      </div>
      <div className="mt-1.5 text-2xl font-bold text-[#101828]">{value}</div>
    </div>
  );
}

const ROW_COLUMNS = "md:grid md:grid-cols-[1fr_120px_120px_170px_80px_140px] md:items-center md:gap-4";

function SubmissionListRow({ examId, submission: s }: { examId: string; submission: SubmissionRow }) {
  const review = needsReview(s);
  const scoreDisplay = s.status === "GRADED" && s.totalScore != null ? s.totalScore.toLocaleString() : "—";
  const submittedDisplay = s.submittedAt ? new Date(s.submittedAt).toLocaleString() : "—";

  return (
    <li className={`border-b border-[#E4E7EC] px-4 py-3 last:border-b-0 ${ROW_COLUMNS}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[#101828]">{s.student.name}</p>
        <p className="truncate text-xs text-[#667085]">
          {s.student.email} · Attempt {s.attemptNumber}
        </p>
      </div>

      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Submitted</p>
        <p className="text-sm text-[#101828]">{submittedDisplay}</p>
      </div>

      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Marking</p>
        <p className="text-sm text-[#101828]">{MARKING_LABELS[s.status]}</p>
      </div>

      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Integrity</p>
        {review ? (
          <span className="inline-flex items-center rounded-full bg-[#FEF3C7] px-2 py-0.5 text-xs font-medium text-[#92400E]">
            Needs review
          </span>
        ) : hasAnySignal(s) ? (
          <div className="flex flex-wrap gap-1">
            <SystemCheckBadge systemCheck={s.systemCheck} />
            <CanvasBadge status={s.canvasStatus} />
            <RecoveryBadge recovery={s.recovery} />
            <LockdownBadge lockdown={s.lockdown} />
          </div>
        ) : (
          <span className="text-sm text-[#667085]">No signals recorded</span>
        )}
      </div>

      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Score</p>
        <p className="text-sm text-[#101828]">{scoreDisplay}</p>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 md:mt-0 md:justify-end">
        <Link
          href={`/lecturer/submissions/${s.id}/evidence`}
          className="rounded text-sm font-medium text-[#667085] hover:text-[#101828] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
        >
          Evidence
        </Link>
        {s.status !== "IN_PROGRESS" && (
          <Link
            href={`/lecturer/exams/${examId}/submissions/${s.id}`}
            className="rounded text-sm font-semibold text-[#2563EB] hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            {s.status === "GRADED" ? "Review →" : "Grade →"}
          </Link>
        )}
      </div>
    </li>
  );
}

type MarkingFilterValue = "all" | "IN_PROGRESS" | "SUBMITTED" | "GRADED";
type IntegrityFilterValue = "all" | "needs-review";

export default function SubmissionsListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [examTitle, setExamTitle] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Presentation-only client-side filters over the ALREADY-loaded
  // submissions list — no additional request, never changes what's
  // stored or what the API response itself contains.
  const [search, setSearch] = useState("");
  const [markingFilter, setMarkingFilter] = useState<MarkingFilterValue>("all");
  const [integrityFilter, setIntegrityFilter] = useState<IntegrityFilterValue>("all");

  async function load() {
    setLoading(true);
    setError(null);

    // Exam title is fetched from the SAME existing /api/exams/[id]
    // endpoint the Exam Workspace and Integrity Review pages already use
    // for their own headers — no new backend route, and it's allowed to
    // fail silently (falls back to "Exam") since it's decorative only.
    const [examRes, subsRes] = await Promise.all([
      fetch(`/api/exams/${id}`),
      fetch(`/api/exams/${id}/submissions`),
    ]);

    if (examRes.ok) {
      const exam = await examRes.json();
      setExamTitle(exam.title);
    }

    if (!subsRes.ok) {
      setError("Failed to load submissions. Try refreshing the page.");
      setLoading(false);
      return;
    }

    setSubmissions(await subsRes.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return submissions.filter((s) => {
      if (q && !s.student.name.toLowerCase().includes(q) && !s.student.email.toLowerCase().includes(q)) return false;
      if (markingFilter !== "all" && s.status !== markingFilter) return false;
      if (integrityFilter === "needs-review" && !needsReview(s)) return false;
      return true;
    });
  }, [submissions, search, markingFilter, integrityFilter]);

  const hasActiveFilters = search.trim() !== "" || markingFilter !== "all" || integrityFilter !== "all";

  function clearFilters() {
    setSearch("");
    setMarkingFilter("all");
    setIntegrityFilter("all");
  }

  const submittedCount = submissions.filter((s) => s.status !== "IN_PROGRESS").length;
  const awaitingMarkingCount = submissions.filter((s) => s.status === "SUBMITTED").length;
  const markedCount = submissions.filter((s) => s.status === "GRADED").length;
  const needsReviewCount = submissions.filter(needsReview).length;

  if (loading) return <p className="mx-auto max-w-7xl text-sm text-[#667085]">Loading submissions…</p>;

  if (error) {
    return (
      <div className="mx-auto max-w-7xl">
        <p className="text-sm text-[#DC2626]">{error}</p>
        <button
          type="button"
          onClick={load}
          className="mt-2 rounded text-sm font-medium text-[#2563EB] underline underline-offset-2 hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div>
        <p className="text-sm font-medium text-[#667085]">Submissions</p>
        <h1 className="mt-1 text-3xl font-bold text-[#101828]">{examTitle ?? "Exam"}</h1>
        <p className="mt-1 text-sm text-[#667085]">Review student attempts, marking status, and integrity evidence.</p>
        <Link
          href={`/lecturer/exams/${id}`}
          className="mt-2 inline-block rounded text-sm font-medium text-[#667085] hover:text-[#101828] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
        >
          ← Back to exam
        </Link>
      </div>

      {submissions.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SubmissionMetric label="Submitted" value={submittedCount} accent="info" />
          <SubmissionMetric label="Awaiting marking" value={awaitingMarkingCount} accent="neutral" />
          <SubmissionMetric label="Needs review" value={needsReviewCount} accent={needsReviewCount > 0 ? "warning" : "neutral"} />
          <SubmissionMetric label="Marked" value={markedCount} accent="success" />
        </div>
      )}

      <div className="mt-8">
        {submissions.length === 0 ? (
          <div className="rounded-xl border border-[#E4E7EC] bg-white p-10 text-center">
            <p className="text-base font-semibold text-[#101828]">No submissions yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-[#667085]">
              Student attempts will appear here after they submit this exam.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="submission-search" className="block text-xs font-medium text-[#667085]">
                  Search
                </label>
                <input
                  id="submission-search"
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search students..."
                  className="mt-1 w-56 rounded-lg border border-[#E4E7EC] bg-white px-2.5 py-1.5 text-sm text-[#101828] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                />
              </div>
              <div>
                <label htmlFor="filter-marking" className="block text-xs font-medium text-[#667085]">
                  Marking
                </label>
                <select
                  id="filter-marking"
                  value={markingFilter}
                  onChange={(e) => setMarkingFilter(e.target.value as MarkingFilterValue)}
                  className="mt-1 rounded-lg border border-[#E4E7EC] bg-white px-2.5 py-1.5 text-sm text-[#101828] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                >
                  <option value="all">All</option>
                  <option value="IN_PROGRESS">In progress</option>
                  <option value="SUBMITTED">Not marked</option>
                  <option value="GRADED">Marked</option>
                </select>
              </div>
              <div>
                <label htmlFor="filter-integrity" className="block text-xs font-medium text-[#667085]">
                  Integrity
                </label>
                <select
                  id="filter-integrity"
                  value={integrityFilter}
                  onChange={(e) => setIntegrityFilter(e.target.value as IntegrityFilterValue)}
                  className="mt-1 rounded-lg border border-[#E4E7EC] bg-white px-2.5 py-1.5 text-sm text-[#101828] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                >
                  <option value="all">All</option>
                  <option value="needs-review">Needs review</option>
                </select>
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded pb-1.5 text-sm font-medium text-[#667085] underline underline-offset-2 hover:text-[#101828] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
                >
                  Clear filters
                </button>
              )}
            </div>

            {hasActiveFilters && (
              <p className="mt-2 text-xs text-[#667085]">
                {countLabel(filtered.length, "submission")} of {submissions.length.toLocaleString()} shown
              </p>
            )}

            <div className="mt-3 overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
              <div
                className={`hidden border-b border-[#E4E7EC] px-4 py-2 text-xs font-medium text-[#667085] md:grid ${ROW_COLUMNS}`}
                aria-hidden="true"
              >
                <span>Student</span>
                <span>Submitted</span>
                <span>Marking</span>
                <span>Integrity</span>
                <span>Score</span>
                <span className="text-right">Action</span>
              </div>
              {filtered.length === 0 && (
                <p className="p-6 text-center text-sm text-[#667085]">No submissions match the current filters.</p>
              )}
              <ul>
                {filtered.map((s) => (
                  <SubmissionListRow key={s.id} examId={id} submission={s} />
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
