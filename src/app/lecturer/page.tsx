"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  lecturerAvailabilityStatus,
  lecturerDashboardGroup,
  type LecturerAvailabilityStatus,
} from "@/lib/lecturerDashboardGrouping";

type ExamSummary = {
  id: string;
  title: string;
  published: boolean;
  durationMins: number;
  availableFrom: string | null;
  availableUntil: string | null;
  course: { id: string; name: string; code: string } | null;
  _count: { questions: number; submissions: number };
  needsReviewCount: number;
};

// Pilot UI release readiness v1 — see
// docs/tether-v1.7.2-pilot-release-readiness.md. Draft/Scheduled/Open/
// Closed and the mutually-exclusive dashboard grouping both come from
// src/lib/lecturerDashboardGrouping.ts — the SAME functions
// src/app/api/exams/route.ts uses for server-side closed-history
// capping, so an exam can never be capped out of the response while
// still shown as actionable here (or vice versa). The "closed" group it
// returns is split further below, by recency only, into the small
// headline slice and the collapsed history tail. Summary tiles above
// remain independent counts, not display-group sizes.
const RECENT_CLOSED_LIMIT = 5;

// Commercial UI polish pass — presentation-only cap on how many review
// rows render before the student needs to expand: never trims the
// underlying needsAttention array itself, and every exam needing review
// stays reachable via "Show all N exams" (see ReviewQueue below).
const REVIEW_QUEUE_INITIAL_LIMIT = 6;

// Final dashboard polish pass — one shared helper for every "N thing(s)"
// label in the dashboard (submissions, questions, signals, the review
// queue's own exam count), instead of duplicating the same singular/
// plural ternary at each call site. `toLocaleString()` adds thousands
// separators for large counts (e.g. needsReviewCount) and is a no-op for
// small ones (`(5).toLocaleString() === "5"`), so it's safe to apply
// everywhere uniformly — never abbreviates, always the exact count.
function countLabel(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export default function LecturerDashboard() {
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [durationMins, setDurationMins] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAllClosed, setShowAllClosed] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [showCreatePanel, setShowCreatePanel] = useState(false);

  async function loadExams(all = false) {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(all ? "/api/exams?all=true" : "/api/exams");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setLoadError(
          typeof body?.error === "string"
            ? body.error
            : `Could not load your exams (status ${res.status}). Try refreshing the page.`,
        );
        return;
      }
      setExams(await res.json());
    } catch {
      setLoadError("Could not load your exams — check your connection and try refreshing the page.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadExams();
  }, []);

  function loadFullHistory() {
    setLoadingHistory(true);
    loadExams(true).finally(() => {
      setShowAllClosed(true);
      setLoadingHistory(false);
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);

    const res = await fetch("/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, durationMins }),
    });

    setCreating(false);

    if (!res.ok) {
      setError("Failed to create exam");
      return;
    }

    setTitle("");
    setDurationMins(60);
    setShowCreatePanel(false);
    await loadExams(showAllClosed);
  }

  function openCreatePanel() {
    setError(null);
    setShowCreatePanel(true);
  }

  function closeCreatePanel() {
    setError(null);
    setShowCreatePanel(false);
  }

  const { summary, needsAttention, active, upcoming, draft, recentlyClosed, olderClosed } = useMemo(() => {
    const grouped: Record<ReturnType<typeof lecturerDashboardGroup>, ExamSummary[]> = {
      needsAttention: [],
      active: [],
      upcoming: [],
      draft: [],
      closed: [],
    };
    for (const exam of exams) grouped[lecturerDashboardGroup(exam)].push(exam);

    grouped.upcoming.sort((a, b) => new Date(a.availableFrom ?? 0).getTime() - new Date(b.availableFrom ?? 0).getTime());
    grouped.closed.sort((a, b) => new Date(b.availableUntil ?? 0).getTime() - new Date(a.availableUntil ?? 0).getTime());

    const closedAll = grouped.closed;
    const recentSlice = closedAll.slice(0, RECENT_CLOSED_LIMIT);
    const olderSlice = closedAll.slice(RECENT_CLOSED_LIMIT);

    // Summary tiles are independent counts across ALL loaded exams
    // (not display-group sizes) — "Active"/"Upcoming" here count every
    // matching exam regardless of whether it's also flagged in Needs
    // Attention, since the tile answers "how many are open right now",
    // not "how many cards are in the Active section below".
    const summaryCounts = {
      active: exams.filter((exam) => lecturerAvailabilityStatus(exam) === "Open").length,
      upcoming: exams.filter((exam) => lecturerAvailabilityStatus(exam) === "Scheduled").length,
      needsReview: exams.filter((exam) => exam.needsReviewCount > 0).length,
      drafts: exams.filter((exam) => lecturerAvailabilityStatus(exam) === "Draft").length,
    };

    return {
      summary: summaryCounts,
      needsAttention: grouped.needsAttention,
      active: grouped.active,
      upcoming: grouped.upcoming,
      draft: grouped.draft,
      recentlyClosed: recentSlice,
      olderClosed: olderSlice,
    };
  }, [exams]);

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#101828]">Lecturer Dashboard</h1>
          <p className="mt-1 text-sm text-[#667085]">Manage exams, review integrity signals and prepare upcoming assessments.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/lecturer/courses"
            className="rounded-lg border border-[#E4E7EC] bg-white px-4 py-2 text-sm font-medium text-[#101828] hover:bg-[#F7F8FA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
          >
            Manage courses
          </Link>
          <button
            type="button"
            onClick={() => (showCreatePanel ? closeCreatePanel() : openCreatePanel())}
            aria-expanded={showCreatePanel}
            aria-controls="create-exam-panel"
            className="rounded-lg bg-[#2563EB] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
          >
            Create exam
          </button>
        </div>
      </div>

      {showCreatePanel && (
        <CreateExamPanel
          title={title}
          durationMins={durationMins}
          creating={creating}
          error={error}
          onTitleChange={setTitle}
          onDurationChange={setDurationMins}
          onSubmit={handleCreate}
          onCancel={closeCreatePanel}
        />
      )}

      {!loading && !loadError && exams.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <DashboardMetric label="Active" value={summary.active} accent="success" />
          <DashboardMetric label="Upcoming" value={summary.upcoming} accent="info" />
          <DashboardMetric label="Needs review" value={summary.needsReview} accent={summary.needsReview > 0 ? "warning" : "neutral"} />
          <DashboardMetric label="Drafts" value={summary.drafts} accent="neutral" />
        </div>
      )}

      <div className="mt-6 space-y-8">
        {loading && <p className="text-sm text-[#667085]">Loading exams…</p>}

        {!loading && loadError && (
          <div className="rounded-xl border border-[#E4E7EC] bg-[#FEF2F2] p-4 text-sm text-[#DC2626]">
            <p>{loadError}</p>
            <button
              type="button"
              onClick={() => loadExams(showAllClosed)}
              className="mt-2 rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#DC2626]"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !loadError && exams.length === 0 && (
          <div className="rounded-xl border border-[#E4E7EC] bg-white p-10 text-center">
            <p className="text-base font-semibold text-[#101828]">No exams yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-[#667085]">Create your first exam to start preparing an assessment.</p>
            <button
              type="button"
              onClick={openCreatePanel}
              className="mt-4 rounded-lg bg-[#2563EB] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
            >
              Create exam
            </button>
          </div>
        )}

        {needsAttention.length > 0 && <ReviewQueue exams={needsAttention} />}

        {active.length > 0 && (
          <section>
            <SectionHeader title="Active" />
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {active.map((exam) => (
                <ExamCard key={exam.id} exam={exam} action="Open →" />
              ))}
            </div>
          </section>
        )}

        {upcoming.length > 0 && (
          <section>
            <SectionHeader title="Upcoming" />
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {upcoming.map((exam) => (
                <ExamCard key={exam.id} exam={exam} />
              ))}
            </div>
          </section>
        )}

        {draft.length > 0 && (
          <section>
            <SectionHeader title="Drafts" muted />
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {draft.map((exam) => (
                <ExamCard key={exam.id} exam={exam} variant="muted" action="Continue editing →" />
              ))}
            </div>
          </section>
        )}

        {recentlyClosed.length > 0 && (
          <section>
            <SectionHeader title="Recent examinations" muted />
            <div className="mt-3 space-y-2">
              {recentlyClosed.map((exam) => (
                <ExamCard key={exam.id} exam={exam} variant="muted" />
              ))}
            </div>
          </section>
        )}

        {(olderClosed.length > 0 || (!showAllClosed && recentlyClosed.length >= RECENT_CLOSED_LIMIT)) && (
          <div>
            {!showAllClosed ? (
              <button
                type="button"
                onClick={loadFullHistory}
                disabled={loadingHistory}
                className="rounded text-sm font-medium text-[#667085] underline underline-offset-2 hover:text-[#101828] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
              >
                {loadingHistory ? "Loading…" : "Show all older examinations"}
              </button>
            ) : (
              olderClosed.length > 0 && (
                <section>
                  <SectionHeader title="Older examinations" muted />
                  <div className="mt-3 space-y-2">
                    {olderClosed.map((exam) => (
                      <ExamCard key={exam.id} exam={exam} variant="muted" />
                    ))}
                  </div>
                </section>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CreateExamPanel({
  title,
  durationMins,
  creating,
  error,
  onTitleChange,
  onDurationChange,
  onSubmit,
  onCancel,
}: {
  title: string;
  durationMins: number;
  creating: boolean;
  error: string | null;
  onTitleChange: (value: string) => void;
  onDurationChange: (value: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <div id="create-exam-panel" className="mt-4 rounded-xl border border-[#E4E7EC] bg-white p-4 sm:p-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="create-exam-title" className="block text-sm font-medium text-[#101828]">
            Exam title
          </label>
          <input
            id="create-exam-title"
            required
            className="mt-1 w-full rounded-lg border border-[#E4E7EC] px-3 py-2 text-sm text-[#101828] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-36">
          <label htmlFor="create-exam-duration" className="block text-sm font-medium text-[#101828]">
            Duration (min)
          </label>
          <input
            id="create-exam-duration"
            required
            type="number"
            min={1}
            className="mt-1 w-full rounded-lg border border-[#E4E7EC] px-3 py-2 text-sm text-[#101828] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
            value={durationMins}
            onChange={(e) => onDurationChange(Number(e.target.value))}
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-[#2563EB] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
          >
            {creating ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-[#E4E7EC] px-4 py-2 text-sm font-medium text-[#667085] hover:bg-[#F7F8FA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            Cancel
          </button>
        </div>
      </form>
      {error && <p className="mt-3 text-sm text-[#DC2626]">{error}</p>}
    </div>
  );
}

function DashboardMetric({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "success" | "info" | "warning" | "neutral";
}) {
  const dotColor = {
    success: "bg-[#067647]",
    info: "bg-[#2563EB]",
    warning: "bg-[#D97706]",
    neutral: "bg-[#98A2B3]",
  }[accent];
  const isWarning = accent === "warning";

  return (
    <div
      className={`rounded-xl border p-4 ${isWarning ? "border-[#FEDF89] bg-[#FFFAEB]" : "border-[#E4E7EC] bg-white"}`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
        <span className="text-sm font-medium text-[#667085]">{label}</span>
      </div>
      <div className="mt-1.5 text-2xl font-bold text-[#101828]">{value}</div>
    </div>
  );
}

function SectionHeader({ title, badge, subtitle, muted }: { title: string; badge?: string; subtitle?: string; muted?: boolean }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className={muted ? "text-sm font-semibold text-[#667085]" : "text-lg font-semibold text-[#101828]"}>{title}</h2>
        {badge && <span className="text-sm font-medium text-[#667085]">{badge}</span>}
      </div>
      {subtitle && <p className="mt-0.5 text-sm text-[#667085]">{subtitle}</p>}
    </div>
  );
}

const REVIEW_COLUMNS = "md:grid md:grid-cols-[1fr_110px_130px_130px_90px] md:items-center md:gap-4";

// Highest-priority content on the dashboard (Task: "Needs your
// attention"). Renders from the SAME needsAttention array the parent
// already computed via lecturerDashboardGroup — never re-derives
// membership, never changes which exams qualify. `showAll` is local,
// presentation-only state: every exam stays in `exams` and reachable,
// only the INITIAL render is capped to keep the dashboard scannable.
function ReviewQueue({ exams }: { exams: ExamSummary[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? exams : exams.slice(0, REVIEW_QUEUE_INITIAL_LIMIT);
  const hasMore = exams.length > REVIEW_QUEUE_INITIAL_LIMIT;

  return (
    <section>
      <SectionHeader
        title="Needs your attention"
        badge={countLabel(exams.length, "exam")}
        subtitle="Integrity signals awaiting lecturer review."
      />

      <div className="mt-3 overflow-hidden rounded-xl border border-[#E4E7EC] border-l-4 border-l-[#D97706] bg-white">
        <div className={`hidden border-b border-[#E4E7EC] bg-[#F7F8FA] px-4 py-2 text-xs font-medium uppercase tracking-wide text-[#667085] ${REVIEW_COLUMNS}`}>
          <span>Exam / course</span>
          <span>Status</span>
          <span>Submissions</span>
          <span>Integrity signals</span>
          <span className="text-right">Action</span>
        </div>
        <ul className="divide-y divide-[#E4E7EC]">
          {visible.map((exam) => (
            <ReviewRow key={exam.id} exam={exam} />
          ))}
        </ul>
      </div>

      {hasMore && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="rounded text-sm font-medium text-[#2563EB] hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            {showAll ? "Show fewer" : `Show all ${countLabel(exams.length, "exam")}`}
          </button>
        </div>
      )}
    </section>
  );
}

function ReviewRow({ exam }: { exam: ExamSummary }) {
  const status = lecturerAvailabilityStatus(exam);
  return (
    <li>
      <Link
        href={`/lecturer/exams/${exam.id}/integrity`}
        className={`block px-4 py-3 hover:bg-[#F7F8FA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2563EB] ${REVIEW_COLUMNS}`}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#101828]">{exam.title}</p>
          {exam.course && (
            <p className="truncate text-xs text-[#667085]">
              {exam.course.code} — {exam.course.name}
            </p>
          )}
        </div>
        <div className="mt-2 md:mt-0">
          <StatusPill status={status} />
        </div>
        <div className="mt-2 text-sm text-[#667085] md:mt-0">{countLabel(exam._count.submissions, "submission")}</div>
        <div className="mt-2 md:mt-0">
          <span className="inline-flex items-center rounded-full bg-[#FEF3C7] px-2 py-0.5 text-xs font-medium text-[#92400E]">
            {countLabel(exam.needsReviewCount, "signal")}
          </span>
        </div>
        <div className="mt-2 md:mt-0 md:text-right">
          <span className="text-sm font-semibold text-[#2563EB]">Review →</span>
        </div>
      </Link>
    </li>
  );
}

const STATUS_PILL_STYLES: Record<LecturerAvailabilityStatus, string> = {
  Open: "bg-[#ECFDF3] text-[#067647]",
  Scheduled: "bg-[#EFF6FF] text-[#1D4ED8]",
  Draft: "bg-[#F2F4F7] text-[#667085]",
  Closed: "bg-[#F2F4F7] text-[#667085]",
};

function StatusPill({ status }: { status: LecturerAvailabilityStatus }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL_STYLES[status]}`}>{status}</span>;
}

// Essential fields only (title, course, submission/review counts already
// cheaply available from the single aggregate query, one status pill) —
// no per-exam extra DB round trip. `variant="muted"` visually
// de-emphasizes drafts/closed exams.
// `action`, when given, renders a subtle right-aligned affordance (e.g.
// "Open →", "Continue editing →") so it's clear the whole card is
// clickable — never a second link/destination, purely a visual hint on
// the SAME existing /lecturer/exams/${exam.id} link.
function ExamCard({ exam, variant = "default", action }: { exam: ExamSummary; variant?: "default" | "muted"; action?: string }) {
  const status = lecturerAvailabilityStatus(exam);
  const muted = variant === "muted";

  return (
    <Link
      href={`/lecturer/exams/${exam.id}`}
      className={`block rounded-xl border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
        muted ? "border-[#E4E7EC] bg-staff-canvas hover:border-[#98A2B3]" : "border-[#E4E7EC] bg-white hover:border-[#98A2B3]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#101828]">{exam.title}</p>
          {exam.course && (
            <p className="mt-0.5 truncate text-xs text-[#667085]">
              {exam.course.code} — {exam.course.name}
            </p>
          )}
        </div>
        <StatusPill status={status} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-xs text-[#667085]">
          {countLabel(exam._count.questions, "question")} · {exam.durationMins} min · {countLabel(exam._count.submissions, "submission")}
        </p>
        {action && <span className="shrink-0 text-xs font-medium text-[#2563EB]">{action}</span>}
      </div>
    </Link>
  );
}
