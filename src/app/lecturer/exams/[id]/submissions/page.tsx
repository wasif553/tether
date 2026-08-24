"use client";

import { useEffect, useMemo, useState, use as usePromise } from "react";
import Link from "next/link";
import { LecturerPageHeader } from "@/components/lecturer/LecturerPageHeader";
import { MetricCard } from "@/components/lecturer/MetricCard";
import { StatusBadge, type StatusTone } from "@/components/lecturer/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/lecturer/EmptyState";
import { SubmissionsIcon, IntegrityIcon } from "@/components/lecturer/icons";

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

const SYSTEM_CHECK_TONES: Record<"READY" | "READY_WITH_WARNINGS" | "NOT_READY", StatusTone> = {
  READY: "success",
  READY_WITH_WARNINGS: "warning",
  NOT_READY: "critical",
};

// Tether System Check and Exam Readiness v1 — a report on the student's
// DEVICE/BROWSER READINESS before the exam started. Deliberately kept
// separate from marking status: this says nothing about whether the
// submission has been graded.
function SystemCheckBadge({ systemCheck }: { systemCheck: SubmissionRow["systemCheck"] }) {
  if (!systemCheck) return <StatusBadge tone="neutral">Not checked</StatusBadge>;
  return (
    <StatusBadge tone={SYSTEM_CHECK_TONES[systemCheck.overallStatus]} className="cursor-default">
      <span title={`System check: ${new Date(systemCheck.checkedAt).toLocaleString()}${systemCheck.clientVersion ? ` — client ${systemCheck.clientVersion}` : ""}`}>
        System check: {SYSTEM_CHECK_LABELS[systemCheck.overallStatus]}
      </span>
    </StatusBadge>
  );
}

const CANVAS_STATUS_LABELS: Record<NonNullable<CanvasStatus>, string> = {
  NOT_READY: "Not ready to send",
  PENDING: "Sending...",
  SENT: "Sent",
  FAILED: "Failed — retry",
  SKIPPED: "Not linked to Canvas",
};

const CANVAS_STATUS_TONES: Record<NonNullable<CanvasStatus>, StatusTone> = {
  NOT_READY: "neutral",
  PENDING: "info",
  SENT: "success",
  FAILED: "critical",
  SKIPPED: "neutral",
};

function CanvasBadge({ status }: { status: CanvasStatus }) {
  if (!status) return null;
  return <StatusBadge tone={CANVAS_STATUS_TONES[status]}>Canvas: {CANVAS_STATUS_LABELS[status]}</StatusBadge>;
}

// Tether Secure Exam Recovery and Resilient Autosave v1 (Part 12) — same
// badge micro-pattern as CanvasBadge/SystemCheckBadge above.
const RECOVERY_BADGE_TONES: Record<string, StatusTone> = {
  ACTIVE: "success",
  Resumed: "info",
  TEMPORARILY_DISCONNECTED: "warning",
  MANUAL_REVIEW_REQUIRED: "critical",
  SUBMITTED: "neutral",
  EXPIRED: "neutral",
  DEFAULT: "neutral",
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
    <StatusBadge tone={RECOVERY_BADGE_TONES[styleKey] ?? RECOVERY_BADGE_TONES.DEFAULT}>
      <span title={title}>{recovery.label}</span>
    </StatusBadge>
  );
}

// Tether Windows Lockdown Hardening v1 (Part 14) — same badge
// micro-pattern as RecoveryBadge/SystemCheckBadge above. "Needs review"
// (a currently-DETECTED, not-yet-closed signal) is the only state that
// warrants an eye-catching colour — a resolved/closed episode is calm
// (informational), and "detection unavailable" is neutral (a technical
// fact, not a signal about the student).
const LOCKDOWN_BADGE_TONES: Record<string, StatusTone> = {
  DETECTED: "critical",
  CLOSED: "neutral",
  DETECTION_UNAVAILABLE: "warning",
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
    <StatusBadge tone={LOCKDOWN_BADGE_TONES[lockdown.state] ?? LOCKDOWN_BADGE_TONES.CLOSED}>
      <span title={title}>{lockdown.label}</span>
    </StatusBadge>
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

const ROW_COLUMNS = "md:grid md:grid-cols-[1fr_120px_120px_170px_80px_140px] md:items-center md:gap-4";

function SubmissionListRow({ examId, submission: s }: { examId: string; submission: SubmissionRow }) {
  const review = needsReview(s);
  const scoreDisplay = s.status === "GRADED" && s.totalScore != null ? s.totalScore.toLocaleString() : "—";
  const submittedDisplay = s.submittedAt ? new Date(s.submittedAt).toLocaleString() : "—";

  return (
    <li className={`border-b border-lecturer-border px-4 py-3 last:border-b-0 ${ROW_COLUMNS}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-lecturer-text-primary">{s.student.name}</p>
        <p className="truncate text-xs text-lecturer-text-secondary">
          {s.student.email} · Attempt {s.attemptNumber}
        </p>
      </div>

      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Submitted</p>
        <p className="text-sm text-lecturer-text-primary">{submittedDisplay}</p>
      </div>

      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Marking</p>
        <p className="text-sm text-lecturer-text-primary">{MARKING_LABELS[s.status]}</p>
      </div>

      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Integrity</p>
        {review ? (
          <StatusBadge tone="warning">Needs review</StatusBadge>
        ) : hasAnySignal(s) ? (
          <div className="flex flex-wrap gap-1">
            <SystemCheckBadge systemCheck={s.systemCheck} />
            <CanvasBadge status={s.canvasStatus} />
            <RecoveryBadge recovery={s.recovery} />
            <LockdownBadge lockdown={s.lockdown} />
          </div>
        ) : (
          <span className="text-sm text-lecturer-text-secondary">No signals recorded</span>
        )}
      </div>

      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Score</p>
        <p className="text-sm text-lecturer-text-primary">{scoreDisplay}</p>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 md:mt-0 md:justify-end">
        <Link
          href={`/lecturer/submissions/${s.id}/evidence`}
          className="rounded text-sm font-medium text-lecturer-text-secondary hover:text-lecturer-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          Evidence
        </Link>
        {s.status !== "IN_PROGRESS" && (
          <Link
            href={`/lecturer/exams/${examId}/submissions/${s.id}`}
            className="rounded text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
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

  if (loading) return <LoadingState label="Loading submissions…" />;

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="mx-auto max-w-7xl">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: examTitle ?? "Exam", href: `/lecturer/exams/${id}` }, { label: "Submissions" }]}
        title={examTitle ?? "Exam"}
        description="Review student attempts, marking status, and integrity evidence."
      />

      {submissions.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Submitted" value={submittedCount} accent="info" icon={<SubmissionsIcon className="h-3.5 w-3.5" />} />
          <MetricCard label="Awaiting marking" value={awaitingMarkingCount} accent="neutral" icon={<SubmissionsIcon className="h-3.5 w-3.5" />} />
          <MetricCard label="Needs review" value={needsReviewCount} accent={needsReviewCount > 0 ? "warning" : "neutral"} icon={<IntegrityIcon className="h-3.5 w-3.5" />} />
          <MetricCard label="Marked" value={markedCount} accent="success" icon={<SubmissionsIcon className="h-3.5 w-3.5" />} />
        </div>
      )}

      <div className="mt-8">
        {submissions.length === 0 ? (
          <EmptyState title="No submissions yet" description="Student attempts will appear here after they submit this exam." />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="submission-search" className="block text-xs font-medium text-lecturer-text-secondary">
                  Search
                </label>
                <input
                  id="submission-search"
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search students…"
                  className="mt-1 w-56 rounded-lg border border-lecturer-border bg-lecturer-surface px-2.5 py-1.5 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                />
              </div>
              <div>
                <label htmlFor="filter-marking" className="block text-xs font-medium text-lecturer-text-secondary">
                  Marking
                </label>
                <select
                  id="filter-marking"
                  value={markingFilter}
                  onChange={(e) => setMarkingFilter(e.target.value as MarkingFilterValue)}
                  className="mt-1 rounded-lg border border-lecturer-border bg-lecturer-surface px-2.5 py-1.5 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  <option value="all">All</option>
                  <option value="IN_PROGRESS">In progress</option>
                  <option value="SUBMITTED">Not marked</option>
                  <option value="GRADED">Marked</option>
                </select>
              </div>
              <div>
                <label htmlFor="filter-integrity" className="block text-xs font-medium text-lecturer-text-secondary">
                  Integrity
                </label>
                <select
                  id="filter-integrity"
                  value={integrityFilter}
                  onChange={(e) => setIntegrityFilter(e.target.value as IntegrityFilterValue)}
                  className="mt-1 rounded-lg border border-lecturer-border bg-lecturer-surface px-2.5 py-1.5 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  <option value="all">All</option>
                  <option value="needs-review">Needs review</option>
                </select>
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded pb-1.5 text-sm font-medium text-lecturer-text-secondary underline underline-offset-2 hover:text-lecturer-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  Clear filters
                </button>
              )}
            </div>

            {hasActiveFilters && (
              <p className="mt-2 text-xs text-lecturer-text-secondary">
                {countLabel(filtered.length, "submission")} of {submissions.length.toLocaleString()} shown
              </p>
            )}

            <div className="mt-3 overflow-hidden rounded-xl border border-lecturer-border bg-lecturer-surface">
              <div
                className={`hidden border-b border-lecturer-border px-4 py-2 text-xs font-medium text-lecturer-text-secondary md:grid ${ROW_COLUMNS}`}
                aria-hidden="true"
              >
                <span>Student</span>
                <span>Submitted</span>
                <span>Marking</span>
                <span>Integrity</span>
                <span>Score</span>
                <span className="text-right">Action</span>
              </div>
              {filtered.length === 0 && <p className="p-6 text-center text-sm text-lecturer-text-secondary">No submissions match the current filters.</p>}
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
