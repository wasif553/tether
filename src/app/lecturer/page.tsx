"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  lecturerAvailabilityStatus,
  lecturerDashboardGroup,
} from "@/lib/lecturerDashboardGrouping";
import { LecturerPageHeader, PrimaryButton, SecondaryLinkButton } from "@/components/lecturer/LecturerPageHeader";
import { MetricCard } from "@/components/lecturer/MetricCard";
import { SectionCard, SectionHeading } from "@/components/lecturer/SectionCard";
import { StatusBadge, availabilityToneFor } from "@/components/lecturer/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/lecturer/EmptyState";
import { ExamsIcon, IntegrityIcon, ReportsIcon } from "@/components/lecturer/icons";
import { ExamActionsMenu } from "@/components/lecturer/ExamActionsMenu";

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

// Course, Exam-per-Course v1 — see docs/exam-course-required-v1.md.
type CourseOption = { id: string; name: string; code: string };

/** Extracts a lecturer-friendly message from either response shape POST /api/exams can return: a plain `{ error: "..." }` string (auth/course-access failures) or `{ error: <zod .flatten() object> }` (schema validation failures, e.g. missing courseId/title/durationMins). */
function friendlyCreateExamError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && "fieldErrors" in err) {
      const fieldErrors = (err as { fieldErrors: Record<string, string[] | undefined> }).fieldErrors;
      const firstMessage = Object.values(fieldErrors).find((messages) => messages && messages.length > 0)?.[0];
      if (firstMessage) return firstMessage;
    }
  }
  return "Failed to create exam";
}

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

// Course, Exam-per-Course v1 — useSearchParams requires a Suspense
// boundary; the actual dashboard logic lives in LecturerDashboardInner
// below, matching this repo's existing pattern (see
// src/app/(auth)/login/page.tsx).
export default function LecturerDashboard() {
  return (
    <Suspense fallback={<LoadingState label="Loading…" />}>
      <LecturerDashboardInner />
    </Suspense>
  );
}

function LecturerDashboardInner() {
  const searchParams = useSearchParams();
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
  // Course, Exam-per-Course v1 — courses this lecturer can create an
  // exam in. Fetched once on mount (not lazily on panel-open) so the
  // "Create exam" button and "no courses yet" guidance can react
  // immediately without a loading flash the first time the panel opens.
  const [courses, setCourses] = useState<CourseOption[] | null>(null);
  const [courseId, setCourseId] = useState("");
  // Course, Exam-per-Course v1 — set when arriving via a course page's
  // "New exam →" link (?courseId=...); locks the course selector so the
  // lecturer isn't asked to re-pick a course they're already inside.
  const [courseLocked, setCourseLocked] = useState(false);

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

  // Course, Exam-per-Course v1 — loaded once; GET /api/courses already
  // scopes to "courses this lecturer teaches" server-side (see that
  // route), so no extra filtering is needed client-side. The API orders
  // by createdAt desc, so sort by code then name here to satisfy the
  // "course code, then course name" ordering the course selector wants.
  useEffect(() => {
    fetch("/api/courses")
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: CourseOption[]) =>
        setCourses([...rows].sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name))),
      )
      .catch(() => setCourses([]));
  }, []);

  useEffect(() => {
    const preselectedCourseId = searchParams.get("courseId");
    if (preselectedCourseId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCourseId(preselectedCourseId);
      setCourseLocked(true);
      setShowCreatePanel(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      body: JSON.stringify({ title, durationMins, courseId }),
    });

    setCreating(false);

    if (!res.ok) {
      setError(friendlyCreateExamError(await res.json().catch(() => null)));
      return;
    }

    setTitle("");
    setDurationMins(60);
    setCourseId("");
    setCourseLocked(false);
    setShowCreatePanel(false);
    await loadExams(showAllClosed);
  }

  function openCreatePanel() {
    setError(null);
    setCourseId("");
    setCourseLocked(false);
    setShowCreatePanel(true);
  }

  function closeCreatePanel() {
    setError(null);
    setCourseId("");
    setCourseLocked(false);
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
    <div className="mx-auto max-w-none">
      <LecturerPageHeader
        title="Lecturer Dashboard"
        description="Manage assessments, monitor integrity signals and review student activity."
        actions={
          <>
            <SecondaryLinkButton href="/lecturer/courses">Manage courses</SecondaryLinkButton>
            <PrimaryButton type="button" onClick={() => (showCreatePanel ? closeCreatePanel() : openCreatePanel())} aria-expanded={showCreatePanel} aria-controls="create-exam-panel">
              Create exam
            </PrimaryButton>
          </>
        }
      />

      {showCreatePanel && (
        <CreateExamPanel
          courses={courses}
          courseId={courseId}
          courseLocked={courseLocked}
          title={title}
          durationMins={durationMins}
          creating={creating}
          error={error}
          onCourseIdChange={setCourseId}
          onTitleChange={setTitle}
          onDurationChange={setDurationMins}
          onSubmit={handleCreate}
          onCancel={closeCreatePanel}
        />
      )}

      {!loading && !loadError && exams.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Active exams" value={summary.active} accent="success" icon={<ExamsIcon className="h-[18px] w-[18px]" />} />
          <MetricCard label="Upcoming" value={summary.upcoming} accent="info" icon={<ReportsIcon className="h-[18px] w-[18px]" />} />
          <MetricCard
            label="Needs review"
            value={summary.needsReview}
            accent={summary.needsReview > 0 ? "warning" : "neutral"}
            icon={<IntegrityIcon className="h-[18px] w-[18px]" />}
          />
          <MetricCard label="Drafts" value={summary.drafts} accent="neutral" icon={<ExamsIcon className="h-[18px] w-[18px]" />} />
        </div>
      )}

      <div className="mt-7 space-y-7">
        {loading && <LoadingState label="Loading exams…" />}

        {!loading && loadError && <ErrorState message={loadError} onRetry={() => loadExams(showAllClosed)} />}

        {!loading && !loadError && exams.length === 0 && (
          <EmptyState
            title="No exams yet"
            description="Create your first exam to start preparing an assessment."
            action={
              <PrimaryButton type="button" onClick={openCreatePanel}>
                Create exam
              </PrimaryButton>
            }
          />
        )}

        {needsAttention.length > 0 && <ReviewQueue exams={needsAttention} />}

        {active.length > 0 && (
          <section>
            <SectionHeading title="Active" />
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {active.map((exam) => (
                <ExamCard key={exam.id} exam={exam} action="Open →" onCardChanged={() => loadExams(showAllClosed)} />
              ))}
            </div>
          </section>
        )}

        {upcoming.length > 0 && (
          <section>
            <SectionHeading title="Upcoming" />
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {upcoming.map((exam) => (
                <ExamCard key={exam.id} exam={exam} onCardChanged={() => loadExams(showAllClosed)} />
              ))}
            </div>
          </section>
        )}

        {draft.length > 0 && (
          <section>
            <SectionHeading title="Drafts" muted />
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {draft.map((exam) => (
                <ExamCard key={exam.id} exam={exam} action="Continue editing →" onCardChanged={() => loadExams(showAllClosed)} />
              ))}
            </div>
          </section>
        )}

        {recentlyClosed.length > 0 && (
          <section>
            <SectionHeading title="Recently closed" muted />
            <div className="mt-3 space-y-2">
              {recentlyClosed.map((exam) => (
                <ExamCard key={exam.id} exam={exam} variant="history" />
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
                className="rounded text-sm font-medium text-lecturer-text-secondary underline underline-offset-2 hover:text-lecturer-text-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
              >
                {loadingHistory ? "Loading…" : "Show all older examinations"}
              </button>
            ) : (
              olderClosed.length > 0 && (
                <section>
                  <SectionHeading title="Older examinations" muted />
                  <div className="mt-3 space-y-2">
                    {olderClosed.map((exam) => (
                      <ExamCard key={exam.id} exam={exam} variant="history" />
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

// Course, Exam-per-Course v1 — every new exam must belong to a course
// (see docs/exam-course-required-v1.md). `courses === null` means still
// loading (renders the same form, since the select simply shows no
// options yet); `courses.length === 0` means the lecturer teaches no
// course at all, which is a distinct, guided empty state rather than a
// dropdown that can only ever fail to submit.
function CreateExamPanel({
  courses,
  courseId,
  courseLocked,
  title,
  durationMins,
  creating,
  error,
  onCourseIdChange,
  onTitleChange,
  onDurationChange,
  onSubmit,
  onCancel,
}: {
  courses: CourseOption[] | null;
  courseId: string;
  courseLocked: boolean;
  title: string;
  durationMins: number;
  creating: boolean;
  error: string | null;
  onCourseIdChange: (value: string) => void;
  onTitleChange: (value: string) => void;
  onDurationChange: (value: number) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const noCourses = !courseLocked && courses !== null && courses.length === 0;
  const lockedCourse = courses?.find((course) => course.id === courseId);

  return (
    <SectionCard className="mt-4" padded={false}>
      <div id="create-exam-panel" className="p-4 sm:p-5">
        {noCourses ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-lecturer-text-primary">Create a course first</p>
              <p className="mt-0.5 text-sm text-lecturer-text-secondary">
                Exams belong to a course. Create your first course before creating an exam.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <SecondaryLinkButton href="/lecturer/courses">Create course</SecondaryLinkButton>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-lecturer-border px-4 py-2 text-sm font-medium text-lecturer-text-secondary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <form onSubmit={onSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="flex-1 sm:min-w-[220px]">
                <label htmlFor="create-exam-course" className="block text-sm font-medium text-lecturer-text-primary">
                  Course
                </label>
                {courseLocked ? (
                  <div
                    id="create-exam-course"
                    className="mt-1 w-full truncate rounded-lg border border-lecturer-border bg-lecturer-border-subtle/60 px-3 py-2 text-sm font-medium text-lecturer-text-primary"
                  >
                    {lockedCourse ? `${lockedCourse.code} — ${lockedCourse.name}` : "Loading course…"}
                  </div>
                ) : (
                  <select
                    id="create-exam-course"
                    required
                    className="mt-1 w-full rounded-lg border border-lecturer-border bg-lecturer-surface px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                    value={courseId}
                    onChange={(e) => onCourseIdChange(e.target.value)}
                  >
                    <option value="" disabled>
                      Select a course
                    </option>
                    {courses?.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.code} — {course.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex-1">
                <label htmlFor="create-exam-title" className="block text-sm font-medium text-lecturer-text-primary">
                  Exam title
                </label>
                <input
                  id="create-exam-title"
                  required
                  className="mt-1 w-full rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                  value={title}
                  onChange={(e) => onTitleChange(e.target.value)}
                />
              </div>
              <div className="w-full sm:w-36">
                <label htmlFor="create-exam-duration" className="block text-sm font-medium text-lecturer-text-primary">
                  Duration (min)
                </label>
                <input
                  id="create-exam-duration"
                  required
                  type="number"
                  min={1}
                  className="mt-1 w-full rounded-lg border border-lecturer-border px-3 py-2 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                  value={durationMins}
                  onChange={(e) => onDurationChange(Number(e.target.value))}
                />
              </div>
              <div className="flex gap-2">
                <PrimaryButton type="submit" disabled={creating || !courseId}>
                  {creating ? "Creating…" : "Create exam"}
                </PrimaryButton>
                <button
                  type="button"
                  onClick={onCancel}
                  className="rounded-lg border border-lecturer-border px-4 py-2 text-sm font-medium text-lecturer-text-secondary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                >
                  Cancel
                </button>
              </div>
            </form>
            {error && <p className="mt-3 text-sm text-[#B42318]">{error}</p>}
          </>
        )}
      </div>
    </SectionCard>
  );
}

const REVIEW_COLUMNS = "md:grid md:grid-cols-[minmax(220px,1fr)_110px_120px_130px_220px] md:items-center md:gap-4";

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
      <SectionHeading title="Needs your attention" badge={countLabel(exams.length, "exam")} subtitle="Integrity signals awaiting lecturer review." />

      <SectionCard accent="warning" padded={false} className="mt-3">
        <div className={`hidden border-b border-lecturer-border bg-lecturer-border-subtle/60 px-4 py-1.5 text-xs font-medium tracking-wide text-lecturer-text-secondary uppercase ${REVIEW_COLUMNS}`}>
          <span>Exam / course</span>
          <span>Status</span>
          <span>Submissions</span>
          <span>Signals</span>
          <span className="text-right">Action</span>
        </div>
        <ul className="divide-y divide-lecturer-border">
          {visible.map((exam) => (
            <ReviewRow key={exam.id} exam={exam} />
          ))}
        </ul>
      </SectionCard>

      {hasMore && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="rounded text-sm font-medium text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
          >
            {showAll ? "Show fewer" : `Show all ${countLabel(exams.length, "exam")}`}
          </button>
        </div>
      )}
    </section>
  );
}

// Commercial UI polish pass — corrective fix: this row has TWO distinct
// destinations (open the exam workspace vs. review its integrity
// signals), so it can no longer be a single wrapping <Link> the way
// ExamCard's single-destination rows are — see "Needs your attention
// exam navigation" fix. Exam title and "Open exam →" both go to the
// Exam Workspace (/lecturer/exams/{id}); "Review signals" is the
// separate, explicitly-labelled entry point into Integrity Review
// (/lecturer/exams/{id}/integrity). No nested <Link>s — each is its own
// sibling element with its own focus-visible state.
function ReviewRow({ exam }: { exam: ExamSummary }) {
  const status = lecturerAvailabilityStatus(exam);
  return (
    <li className={`px-4 py-2 ${REVIEW_COLUMNS}`}>
      <div className="min-w-0 leading-tight">
        <Link
          href={`/lecturer/exams/${exam.id}`}
          className="truncate rounded text-sm font-semibold text-lecturer-text-primary hover:text-lecturer-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          {exam.title}
        </Link>
        {exam.course && (
          <p className="truncate text-xs text-lecturer-text-secondary">
            {exam.course.code} — {exam.course.name}
          </p>
        )}
      </div>
      <div className="mt-1.5 md:mt-0">
        <StatusBadge tone={availabilityToneFor(status)}>{status}</StatusBadge>
      </div>
      <div className="mt-1.5 text-sm text-lecturer-text-secondary md:mt-0">{countLabel(exam._count.submissions, "submission")}</div>
      <div className="mt-1.5 md:mt-0">
        {/* Signal volume ≠ misconduct: a raw count is toned down to a
            neutral badge — the amber "needs review" semantic is already
            carried by this section's own accent bar and title, not by
            colouring every row's number. */}
        <StatusBadge tone="neutral">{countLabel(exam.needsReviewCount, "signal")}</StatusBadge>
      </div>
      <div className="mt-2 flex items-center gap-3 md:mt-0 md:justify-end">
        <Link
          href={`/lecturer/exams/${exam.id}/integrity`}
          className="rounded text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          Review signals →
        </Link>
        <Link
          href={`/lecturer/exams/${exam.id}`}
          className="rounded text-xs font-medium text-lecturer-text-secondary hover:text-lecturer-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          Open exam
        </Link>
      </div>
    </li>
  );
}

// Essential fields only (title, course, submission/review counts already
// cheaply available from the single aggregate query, one status pill) —
// no per-exam extra DB round trip. `variant="history"` is reserved for
// genuinely lower-priority historical rows (Recently closed/Older
// examinations) — a subtly quieter surface is appropriate there. Drafts
// deliberately use the SAME "default" white-card treatment as Active
// (polish pass v2: the old shared "muted" variant made Draft cards blend
// into the page background and read as unfinished — differentiation
// between Draft/Active now comes only from the restrained neutral
// "Draft" status badge, not from a different card surface).
// `action`, when given, renders a subtle right-aligned affordance (e.g.
// "Open →", "Continue editing →") so it's clear the whole card is
// clickable — never a second link/destination, purely a visual hint on
// the SAME existing /lecturer/exams/${exam.id} link.
// Exam Archive Lifecycle v1 — an archived exam is excluded from GET
// /api/exams entirely (see src/app/api/exams/route.ts), so ExamCard on
// the dashboard never actually receives one; onCardChanged only ever
// needs to handle "Archive" (and, for eligible drafts, "Delete"). The
// menu button is a SIBLING to the title Link, not nested inside it — an
// <a> containing a <button> is invalid HTML, the same nested-interactive-
// element pattern ReviewRow above was already rewritten to avoid.
function ExamCard({
  exam,
  variant = "default",
  action,
  onCardChanged,
}: {
  exam: ExamSummary;
  variant?: "default" | "history";
  action?: string;
  onCardChanged?: () => void;
}) {
  const status = lecturerAvailabilityStatus(exam);
  const history = variant === "history";
  const href = `/lecturer/exams/${exam.id}`;

  return (
    <div
      className={`rounded-xl border p-4 transition-all ${
        history ? "border-lecturer-border bg-staff-canvas" : "border-lecturer-border bg-lecturer-surface hover:border-lecturer-accent/50 hover:shadow-sm"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <Link href={href} className="min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent">
          <p className="truncate text-sm font-semibold text-lecturer-text-primary hover:text-lecturer-accent">{exam.title}</p>
          {exam.course && (
            <p className="mt-0.5 truncate text-xs text-lecturer-text-secondary">
              {exam.course.code} — {exam.course.name}
            </p>
          )}
        </Link>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge tone={availabilityToneFor(status)}>{status}</StatusBadge>
          {onCardChanged && (
            <ExamActionsMenu
              examId={exam.id}
              examTitle={exam.title}
              archived={false}
              deletable={!exam.published && exam._count.submissions === 0}
              href={href}
              onChanged={onCardChanged}
            />
          )}
        </div>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-xs text-lecturer-text-secondary">
          {countLabel(exam._count.questions, "question")} · {exam.durationMins} min · {countLabel(exam._count.submissions, "submission")}
        </p>
        {action && (
          <Link href={href} className="shrink-0 text-xs font-medium text-lecturer-accent hover:text-lecturer-accent-hover">
            {action}
          </Link>
        )}
      </div>
    </div>
  );
}
