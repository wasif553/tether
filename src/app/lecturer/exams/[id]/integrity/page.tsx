"use client";

import { useEffect, useMemo, useState, use as usePromise } from "react";
import Link from "next/link";
import {
  categoryForEventType,
  INTEGRITY_EVENT_CATEGORY_LABELS,
  type IntegrityEventCategory,
} from "@/lib/integrityEventLabels";
import { LecturerPageHeader, SecondaryLinkButton } from "@/components/lecturer/LecturerPageHeader";
import { MetricCard } from "@/components/lecturer/MetricCard";
import { SectionHeading } from "@/components/lecturer/SectionCard";
import { StatusBadge, type StatusTone } from "@/components/lecturer/StatusBadge";
import { LoadingState, ErrorState } from "@/components/lecturer/EmptyState";
import { IntegrityIcon } from "@/components/lecturer/icons";

type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

type IntegrityEventRow = {
  id: string;
  submissionId: string;
  eventType: string;
  eventLabel: string;
  severity: Severity;
  message: string;
  occurredAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
  student: { id: string; name: string; email: string };
  submissionStatus: string;
};

type RiskLevel = "CLEAN" | "LOW" | "MEDIUM" | "HIGH";

type StudentGroup = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  submissionId: string;
  submissionStatus: string;
  eventCount: number;
  severityCounts: Record<string, number>;
  riskScore: number;
  riskLevel: RiskLevel;
  unresolvedHighCount: number;
  reviewRecommended: boolean;
};

type IntegrityData = {
  events: IntegrityEventRow[];
  studentGroups: StudentGroup[];
  severityCounts: Record<string, number>;
  unresolvedHighSeverityCount: number;
};

// Integrity review commercial UI polish — one shared helper for every
// "N thing(s)" label, mirroring the equivalent helper on the Lecturer
// Dashboard (src/app/lecturer/page.tsx). Never abbreviates; safe to call
// on any count.
function countLabel(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** Same idea as countLabel, but returns only the WORD form (the caller already renders the number separately, e.g. in a metric tile). */
function pluralWord(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

// "Risk" reads too close to a misconduct judgement for lecturer-facing
// copy — see the terminology-change requirement this pass implements.
// The underlying RiskLevel VALUES, thresholds, and ordering (from
// src/lib/integrityRisk.ts, via the API's riskLevelForScore) are
// completely untouched; only this page's own display strings change.
const REVIEW_PRIORITY_LABELS: Record<RiskLevel, string> = {
  CLEAN: "Clean",
  LOW: "Low review priority",
  MEDIUM: "Medium review priority",
  HIGH: "High review priority",
};

const REVIEW_PRIORITY_TONES: Record<RiskLevel, StatusTone> = {
  CLEAN: "neutral",
  LOW: "info",
  MEDIUM: "warning",
  HIGH: "critical",
};

function ReviewPriorityBadge({ level }: { level: RiskLevel }) {
  return <StatusBadge tone={REVIEW_PRIORITY_TONES[level]}>{REVIEW_PRIORITY_LABELS[level]}</StatusBadge>;
}

const SEVERITY_LABELS: Record<Severity, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low", INFO: "Info" };
const SEVERITY_TONES: Record<Severity, StatusTone> = { HIGH: "critical", MEDIUM: "warning", LOW: "info", INFO: "neutral" };

function SeverityBadge({ severity }: { severity: Severity }) {
  return <StatusBadge tone={SEVERITY_TONES[severity]}>{SEVERITY_LABELS[severity]}</StatusBadge>;
}

function ReviewStatusBadge({ resolved, resolvedByName }: { resolved: boolean; resolvedByName: string | null }) {
  if (resolved) return <StatusBadge tone="success">Reviewed{resolvedByName ? ` by ${resolvedByName}` : ""}</StatusBadge>;
  return <StatusBadge tone="neutral">Needs review</StatusBadge>;
}

// Human-readable event names — presentation mapping only, never touches
// stored eventType/eventLabel. `labelForEventType` (server-side, see
// src/lib/integrityEventLabels.ts) already supplies a friendly label for
// most event types; this ONLY overrides the specific codes called out as
// still lecturer-unsuitable (WINDOW_BLUR/WINDOW_FOCUS_RETURN fall back to
// their raw code today) or where the existing label repeats information
// now shown separately as its own badge (e.g. "— needs review" is
// dropped since ReviewStatusBadge already conveys that). Anything not
// listed here keeps using the backend's own eventLabel unchanged.
const LOCAL_EVENT_LABEL_OVERRIDES: Partial<Record<string, string>> = {
  WINDOW_BLUR: "Student switched away from exam",
  WINDOW_FOCUS_RETURN: "Student returned to exam",
  SCREEN_SHARE_INTERRUPTED: "Screen sharing interrupted",
  SCREEN_SHARE_EVIDENCE_CAPTURED: "Screen evidence captured",
  CAMERA_PERMISSION_GRANTED: "Camera access granted",
  STUDENT_VERIFICATION_CONFIRMED: "Student identity verified",
};

function displayLabelForEvent(event: IntegrityEventRow): string {
  return LOCAL_EVENT_LABEL_OVERRIDES[event.eventType] ?? event.eventLabel;
}

const CATEGORY_FILTER_OPTIONS: IntegrityEventCategory[] = ["evidence", "camera", "screen", "lockdown", "window", "info"];

type ReviewStatusFilterValue = "all" | "needs-review" | "reviewed";
type SeverityFilterValue = "all" | Severity;
type CategoryFilterValue = "all" | IntegrityEventCategory;

const STUDENT_REVIEW_QUEUE_INITIAL_LIMIT = 5;

export default function ExamIntegrityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);

  const [examTitle, setExamTitle] = useState<string | null>(null);
  const [data, setData] = useState<IntegrityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeNoteEventId, setActiveNoteEventId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAllStudents, setShowAllStudents] = useState(false);

  // Presentation-only client-side filters over the ALREADY-loaded event
  // list — no additional request, never changes what's stored or what
  // `data.events` itself contains.
  const [reviewStatusFilter, setReviewStatusFilter] = useState<ReviewStatusFilterValue>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilterValue>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilterValue>("all");
  const [studentFilter, setStudentFilter] = useState<string>("all");

  async function load() {
    setLoading(true);
    setError(null);

    const [examRes, eventsRes] = await Promise.all([
      fetch(`/api/exams/${id}`),
      fetch(`/api/lecturer/exams/${id}/integrity-events`),
    ]);

    if (examRes.ok) {
      const exam = await examRes.json();
      setExamTitle(exam.title);
    }

    if (!eventsRes.ok) {
      setError(
        eventsRes.status === 403
          ? "You don't have access to this exam's integrity events."
          : "Failed to load integrity events.",
      );
      setLoading(false);
      return;
    }

    setData(await eventsRes.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [id]);

  async function handleResolve(eventId: string) {
    if (!noteText.trim()) return;
    setSaving(true);
    const res = await fetch(`/api/lecturer/integrity-events/${eventId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolutionNote: noteText.trim() }),
    });
    setSaving(false);
    if (res.ok) {
      setActiveNoteEventId(null);
      setNoteText("");
      await load();
    }
  }

  const events = useMemo(() => data?.events ?? [], [data]);

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (reviewStatusFilter === "needs-review" && e.resolvedAt) return false;
      if (reviewStatusFilter === "reviewed" && !e.resolvedAt) return false;
      if (severityFilter !== "all" && e.severity !== severityFilter) return false;
      if (categoryFilter !== "all" && categoryForEventType(e.eventType) !== categoryFilter) return false;
      if (studentFilter !== "all" && e.student.id !== studentFilter) return false;
      return true;
    });
  }, [events, reviewStatusFilter, severityFilter, categoryFilter, studentFilter]);

  const hasActiveFilters =
    reviewStatusFilter !== "all" || severityFilter !== "all" || categoryFilter !== "all" || studentFilter !== "all";

  function clearFilters() {
    setReviewStatusFilter("all");
    setSeverityFilter("all");
    setCategoryFilter("all");
    setStudentFilter("all");
  }

  if (loading) return <LoadingState label="Loading integrity events…" />;
  if (error) return <ErrorState message={error} />;
  if (!data) return <ErrorState message="No data available." />;

  const totalEvents = data.events.length;
  const highSeverityEvents = data.severityCounts.HIGH ?? 0;
  const studentsWithEvents = data.studentGroups.length;
  const unresolvedEvents = data.events.filter((e) => !e.resolvedAt).length;
  const visibleStudents = showAllStudents ? data.studentGroups : data.studentGroups.slice(0, STUDENT_REVIEW_QUEUE_INITIAL_LIMIT);
  const hasMoreStudents = data.studentGroups.length > STUDENT_REVIEW_QUEUE_INITIAL_LIMIT;

  return (
    <div className="mx-auto max-w-none">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: examTitle ?? "Exam", href: `/lecturer/exams/${id}` }, { label: "Integrity" }]}
        title={examTitle ?? "Exam"}
        description="Review integrity evidence recorded during this examination."
        actions={
          <>
            <SecondaryLinkButton href={`/lecturer/exams/${id}/analytics`} className="px-3 py-1.5">
              Analytics
            </SecondaryLinkButton>
            <a
              href={`/api/lecturer/exams/${id}/integrity-events/export.csv`}
              className="rounded-lg border border-lecturer-border bg-lecturer-surface px-3 py-1.5 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2"
            >
              Export CSV
            </a>
          </>
        }
      />

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          value={totalEvents}
          label={pluralWord(totalEvents, "Integrity event", "Integrity events")}
          accent="neutral"
          icon={<IntegrityIcon className="h-[18px] w-[18px]" />}
        />
        <MetricCard value={studentsWithEvents} label={pluralWord(studentsWithEvents, "Student affected", "Students affected")} accent="info" icon={<IntegrityIcon className="h-[18px] w-[18px]" />} />
        <MetricCard value={unresolvedEvents} label="Awaiting review" accent={unresolvedEvents > 0 ? "warning" : "neutral"} icon={<IntegrityIcon className="h-[18px] w-[18px]" />} />
        <MetricCard value={highSeverityEvents} label="High severity" accent={highSeverityEvents > 0 ? "critical" : "neutral"} icon={<IntegrityIcon className="h-[18px] w-[18px]" />} />
      </div>

      <div className="mt-8 space-y-8">
        <section>
          <SectionHeading
            title="Students requiring review"
            badge={countLabel(data.studentGroups.length, "student")}
            subtitle="Prioritisation helps lecturers decide what to review first — a deterministic point score, not AI. It is evidence for human review, not a misconduct determination."
          />
          <div className="mt-3 space-y-2">
            {data.studentGroups.length === 0 && <p className="text-sm text-lecturer-text-secondary">No integrity events recorded.</p>}
            {visibleStudents.map((group) => (
              <StudentReviewCard key={group.studentId} group={group} events={data.events} />
            ))}
          </div>
          {hasMoreStudents && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowAllStudents((v) => !v)}
                className="rounded text-sm font-medium text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
              >
                {showAllStudents ? "Show fewer" : `Show all ${countLabel(data.studentGroups.length, "student")}`}
              </button>
            </div>
          )}
        </section>

        <section>
          <SectionHeading title="Event timeline" subtitle="Every recorded integrity event for this exam, most recent first." />

          {data.events.length > 0 && (
            <IntegrityFilters
              reviewStatusFilter={reviewStatusFilter}
              onReviewStatusFilterChange={setReviewStatusFilter}
              severityFilter={severityFilter}
              onSeverityFilterChange={setSeverityFilter}
              categoryFilter={categoryFilter}
              onCategoryFilterChange={setCategoryFilter}
              studentFilter={studentFilter}
              onStudentFilterChange={setStudentFilter}
              students={data.studentGroups}
              hasActiveFilters={hasActiveFilters}
              onClearFilters={clearFilters}
            />
          )}

          {hasActiveFilters && (
            <p className="mt-2 text-xs text-lecturer-text-secondary">
              Showing {filteredEvents.length.toLocaleString()} of {events.length.toLocaleString()} events
            </p>
          )}

          <div className="mt-3 overflow-hidden rounded-xl border border-lecturer-border bg-lecturer-surface">
            {data.events.length === 0 && <p className="p-6 text-center text-sm text-lecturer-text-secondary">No integrity events recorded.</p>}
            {data.events.length > 0 && filteredEvents.length === 0 && (
              <p className="p-6 text-center text-sm text-lecturer-text-secondary">No events match the current filters.</p>
            )}
            <ul>
              {filteredEvents.map((event) => (
                <EventTimelineRow
                  key={event.id}
                  event={event}
                  activeNoteEventId={activeNoteEventId}
                  noteText={noteText}
                  saving={saving}
                  onStartReview={() => {
                    setActiveNoteEventId(event.id);
                    setNoteText("");
                  }}
                  onCancelReview={() => {
                    setActiveNoteEventId(null);
                    setNoteText("");
                  }}
                  onNoteChange={setNoteText}
                  onConfirmReview={() => handleResolve(event.id)}
                />
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}

// WHO needs review (name/email), WHY (priority badge + event categories +
// the same reviewRecommended signal the API already computes), and WHAT
// to do about it (one primary action). Event categories are derived
// client-side from data ALREADY loaded on this page (categoryForEventType
// over data.events) — no new field, no new request.
function StudentReviewCard({ group, events }: { group: StudentGroup; events: IntegrityEventRow[] }) {
  const categories = useMemo(() => {
    const present = new Set(
      events.filter((e) => e.student.id === group.studentId).map((e) => categoryForEventType(e.eventType)),
    );
    present.delete("info");
    return Array.from(present).map((c) => INTEGRITY_EVENT_CATEGORY_LABELS[c]);
  }, [events, group.studentId]);

  return (
    <div className="rounded-xl border border-lecturer-border bg-lecturer-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-lecturer-text-primary">{group.studentName}</p>
          <p className="truncate text-xs text-lecturer-text-secondary">{group.studentEmail}</p>
        </div>
        <ReviewPriorityBadge level={group.riskLevel} />
      </div>
      <p className="mt-2 text-xs text-lecturer-text-secondary">
        {countLabel(group.eventCount, "event")}
        {categories.length > 0 ? ` · ${categories.join(" · ")}` : ""}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {group.reviewRecommended ? <StatusBadge tone="warning">Needs review</StatusBadge> : <span className="text-xs text-lecturer-text-secondary">No unresolved high-severity signals</span>}
        <Link
          href={`/lecturer/submissions/${group.submissionId}/evidence`}
          className="rounded text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          Review evidence →
        </Link>
      </div>
    </div>
  );
}

function IntegrityFilters({
  reviewStatusFilter,
  onReviewStatusFilterChange,
  severityFilter,
  onSeverityFilterChange,
  categoryFilter,
  onCategoryFilterChange,
  studentFilter,
  onStudentFilterChange,
  students,
  hasActiveFilters,
  onClearFilters,
}: {
  reviewStatusFilter: ReviewStatusFilterValue;
  onReviewStatusFilterChange: (value: ReviewStatusFilterValue) => void;
  severityFilter: SeverityFilterValue;
  onSeverityFilterChange: (value: SeverityFilterValue) => void;
  categoryFilter: CategoryFilterValue;
  onCategoryFilterChange: (value: CategoryFilterValue) => void;
  studentFilter: string;
  onStudentFilterChange: (value: string) => void;
  students: StudentGroup[];
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  const SELECT_CLASS = "mt-1 rounded-lg border border-lecturer-border bg-lecturer-surface px-2.5 py-1.5 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent";
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="filter-review-status" className="block text-xs font-medium text-lecturer-text-secondary">
          Review status
        </label>
        <select id="filter-review-status" value={reviewStatusFilter} onChange={(e) => onReviewStatusFilterChange(e.target.value as ReviewStatusFilterValue)} className={SELECT_CLASS}>
          <option value="all">All</option>
          <option value="needs-review">Needs review</option>
          <option value="reviewed">Reviewed</option>
        </select>
      </div>

      <div>
        <label htmlFor="filter-severity" className="block text-xs font-medium text-lecturer-text-secondary">
          Severity
        </label>
        <select id="filter-severity" value={severityFilter} onChange={(e) => onSeverityFilterChange(e.target.value as SeverityFilterValue)} className={SELECT_CLASS}>
          <option value="all">All</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
          <option value="INFO">Info</option>
        </select>
      </div>

      <div>
        <label htmlFor="filter-category" className="block text-xs font-medium text-lecturer-text-secondary">
          Event
        </label>
        <select id="filter-category" value={categoryFilter} onChange={(e) => onCategoryFilterChange(e.target.value as CategoryFilterValue)} className={SELECT_CLASS}>
          <option value="all">All event types</option>
          {CATEGORY_FILTER_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {INTEGRITY_EVENT_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>

      {students.length > 1 && (
        <div>
          <label htmlFor="filter-student" className="block text-xs font-medium text-lecturer-text-secondary">
            Student
          </label>
          <select id="filter-student" value={studentFilter} onChange={(e) => onStudentFilterChange(e.target.value)} className={SELECT_CLASS}>
            <option value="all">All students</option>
            {students.map((s) => (
              <option key={s.studentId} value={s.studentId}>
                {s.studentName}
              </option>
            ))}
          </select>
        </div>
      )}

      {hasActiveFilters && (
        <button
          type="button"
          onClick={onClearFilters}
          className="rounded pb-1.5 text-sm font-medium text-lecturer-text-secondary underline underline-offset-2 hover:text-lecturer-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function EventTimelineRow({
  event,
  activeNoteEventId,
  noteText,
  saving,
  onStartReview,
  onCancelReview,
  onNoteChange,
  onConfirmReview,
}: {
  event: IntegrityEventRow;
  activeNoteEventId: string | null;
  noteText: string;
  saving: boolean;
  onStartReview: () => void;
  onCancelReview: () => void;
  onNoteChange: (value: string) => void;
  onConfirmReview: () => void;
}) {
  const resolved = Boolean(event.resolvedAt);
  const time = new Date(event.occurredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const isReviewing = activeNoteEventId === event.id;

  return (
    <li className="border-b border-lecturer-border px-4 py-3 last:border-b-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-lecturer-text-secondary">{time}</span>
            <SeverityBadge severity={event.severity} />
            <ReviewStatusBadge resolved={resolved} resolvedByName={event.resolvedByName} />
          </div>
          <p className="mt-1 text-sm font-semibold text-lecturer-text-primary">{displayLabelForEvent(event)}</p>
          <p className="mt-0.5 text-sm text-lecturer-text-secondary">{event.message}</p>
          <p className="mt-0.5 text-xs text-lecturer-text-secondary">
            {event.student.name} · {event.student.email}
          </p>
          {event.resolutionNote && <p className="mt-1 text-xs text-lecturer-text-secondary">Note: {event.resolutionNote}</p>}

          <details className="mt-1.5">
            <summary className="w-fit cursor-pointer rounded text-xs font-medium text-lecturer-text-secondary hover:text-lecturer-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent">
              Technical details
            </summary>
            <div className="mt-1.5 space-y-0.5 text-xs text-lecturer-text-secondary">
              <p>
                Event type: <span className="font-mono">{event.eventType}</span>
              </p>
              <p>Timestamp: {new Date(event.occurredAt).toISOString()}</p>
              <p>Submission: {event.submissionId}</p>
              <p>Severity: {event.severity}</p>
              <p>Status: {resolved ? "Reviewed" : "Needs review"}</p>
            </div>
          </details>
        </div>

        {!resolved && (
          <div className="shrink-0">
            {isReviewing ? (
              <div className="flex flex-col gap-1.5 sm:items-end">
                <input
                  autoFocus
                  placeholder="Resolution note"
                  aria-label="Resolution note"
                  className="w-full rounded-lg border border-lecturer-border px-2.5 py-1.5 text-xs text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent sm:w-44"
                  value={noteText}
                  onChange={(e) => onNoteChange(e.target.value)}
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={onConfirmReview}
                    disabled={saving || !noteText.trim()}
                    className="rounded-lg bg-lecturer-accent px-2.5 py-1 text-xs font-semibold text-white hover:bg-lecturer-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                  >
                    {saving ? "Saving…" : "Mark reviewed"}
                  </button>
                  <button
                    type="button"
                    onClick={onCancelReview}
                    className="rounded-lg border border-lecturer-border px-2.5 py-1 text-xs font-medium text-lecturer-text-secondary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={onStartReview}
                className="rounded text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
              >
                Review →
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
