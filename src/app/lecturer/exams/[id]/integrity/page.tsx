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
type RiskLevel = "CLEAN" | "LOW" | "MEDIUM" | "HIGH";

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

type ReviewStatusFilterValue = "all" | "needs-review" | "reviewed";
type SeverityFilterValue = "all" | Severity;
type CategoryFilterValue = "all" | IntegrityEventCategory;
type EvidenceClass = "review" | "control" | "context";

const REVIEW_PRIORITY_LABELS: Record<RiskLevel, string> = {
  CLEAN: "No priority signal",
  LOW: "Low review priority",
  MEDIUM: "Review recommended",
  HIGH: "High-priority review",
};

const REVIEW_PRIORITY_TONES: Record<RiskLevel, StatusTone> = {
  CLEAN: "neutral",
  LOW: "info",
  MEDIUM: "warning",
  HIGH: "critical",
};

const SEVERITY_LABELS: Record<Severity, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  INFO: "Info",
};

const SEVERITY_TONES: Record<Severity, StatusTone> = {
  HIGH: "critical",
  MEDIUM: "warning",
  LOW: "info",
  INFO: "neutral",
};

const CATEGORY_FILTER_OPTIONS: IntegrityEventCategory[] = [
  "evidence",
  "camera",
  "screen",
  "lockdown",
  "window",
  "info",
];

const STUDENT_REVIEW_QUEUE_INITIAL_LIMIT = 8;

const POSITIVE_CONTROL_EVENT_TYPES = new Set([
  "CAMERA_PERMISSION_GRANTED",
  "CAMERA_STARTED",
  "CAMERA_VISIBILITY_RESTORED",
  "SCREEN_SHARE_STARTED",
  "SCREEN_SHARE_RESTORED",
  "WINDOW_FOCUS_RETURN",
  "FULLSCREEN_FORCED_RETURN",
  "STUDENT_VERIFICATION_CONFIRMED",
  "PROHIBITED_APPLICATION_CLOSED",
  "NETWORK_ONLINE",
]);

const CONTEXT_EVENT_TYPES = new Set([
  "QUESTION_NAVIGATED_NEXT",
  "QUESTION_NAVIGATED_PREVIOUS",
  "QUESTION_NAVIGATED_DIRECT",
  "QUESTION_BACK_NAVIGATION_BLOCKED",
  "QUESTION_DIRECT_NAVIGATION_BLOCKED",
  "AI_ASSISTANCE_USED",
  "AI_ASSISTANCE_REQUEST_BLOCKED",
  "AI_ASSISTANCE_RESPONSE_REGENERATED",
  "AI_ASSISTANCE_REQUEST_FAILED",
  "AI_ASSISTANCE_LIMIT_REACHED",
  "CAMERA_PERMISSION_GRANTED",
  "CAMERA_STARTED",
  "STUDENT_VERIFICATION_CONFIRMED",
  "SCREEN_SHARE_STARTED",
  "SCREEN_SHARE_EVIDENCE_CAPTURED",
  "WINDOW_FOCUS_RETURN",
  "FULLSCREEN_FORCED_RETURN",
]);

const LOCAL_EVENT_LABEL_OVERRIDES: Partial<Record<string, string>> = {
  WINDOW_BLUR: "Student switched away from exam",
  WINDOW_FOCUS_RETURN: "Student returned to exam",
  SCREEN_SHARE_INTERRUPTED: "Screen sharing interrupted",
  SCREEN_SHARE_EVIDENCE_CAPTURED: "Screen evidence captured",
  CAMERA_PERMISSION_GRANTED: "Camera access granted",
  STUDENT_VERIFICATION_CONFIRMED: "Student identity verified",
  AI_ASSISTANCE_RESPONSE_REGENERATED: "Brainstorm safeguard applied",
  AI_ASSISTANCE_USED: "Tether Brainstorm guidance shown",
};

function countLabel(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function displayLabelForEvent(event: IntegrityEventRow): string {
  return LOCAL_EVENT_LABEL_OVERRIDES[event.eventType] ?? event.eventLabel;
}

function evidenceClassForEvent(event: IntegrityEventRow): EvidenceClass {
  if (POSITIVE_CONTROL_EVENT_TYPES.has(event.eventType)) return "control";
  if (CONTEXT_EVENT_TYPES.has(event.eventType) || event.severity === "INFO") return "context";
  return "review";
}

function isReviewableEvent(event: IntegrityEventRow): boolean {
  return evidenceClassForEvent(event) === "review";
}

function ReviewPriorityBadge({ level }: { level: RiskLevel }) {
  return <StatusBadge tone={REVIEW_PRIORITY_TONES[level]}>{REVIEW_PRIORITY_LABELS[level]}</StatusBadge>;
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return <StatusBadge tone={SEVERITY_TONES[severity]}>{SEVERITY_LABELS[severity]}</StatusBadge>;
}

function EvidenceClassBadge({ event }: { event: IntegrityEventRow }) {
  const evidenceClass = evidenceClassForEvent(event);
  if (evidenceClass === "review") {
    return <StatusBadge tone={event.severity === "HIGH" ? "critical" : "warning"}>Review signal</StatusBadge>;
  }
  if (evidenceClass === "control") return <StatusBadge tone="success">Control evidence</StatusBadge>;
  return <StatusBadge tone="neutral">Context only</StatusBadge>;
}

export default function ExamIntegrityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [examTitle, setExamTitle] = useState<string | null>(null);
  const [data, setData] = useState<IntegrityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeNoteEventId, setActiveNoteEventId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAllStudents, setShowAllStudents] = useState(false);
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
  const reviewableEvents = useMemo(() => events.filter(isReviewableEvent), [events]);
  const reviewableStudentIds = useMemo(
    () => new Set(reviewableEvents.map((event) => event.student.id)),
    [reviewableEvents],
  );

  const reviewQueue = useMemo(
    () => (data?.studentGroups ?? []).filter((group) => reviewableStudentIds.has(group.studentId)),
    [data, reviewableStudentIds],
  );

  const reviewedStudentCount = useMemo(() => {
    return reviewQueue.filter((group) => {
      const studentEvents = reviewableEvents.filter((event) => event.student.id === group.studentId);
      return studentEvents.length > 0 && studentEvents.every((event) => Boolean(event.resolvedAt));
    }).length;
  }, [reviewQueue, reviewableEvents]);

  const highPriorityStudentCount = reviewQueue.filter(
    (group) => group.riskLevel === "HIGH" || group.unresolvedHighCount > 0,
  ).length;

  const unresolvedReviewableCount = reviewableEvents.filter((event) => !event.resolvedAt).length;

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      if (reviewStatusFilter === "needs-review" && event.resolvedAt) return false;
      if (reviewStatusFilter === "reviewed" && !event.resolvedAt) return false;
      if (severityFilter !== "all" && event.severity !== severityFilter) return false;
      if (categoryFilter !== "all" && categoryForEventType(event.eventType) !== categoryFilter) return false;
      if (studentFilter !== "all" && event.student.id !== studentFilter) return false;
      return true;
    });
  }, [events, reviewStatusFilter, severityFilter, categoryFilter, studentFilter]);

  const hasActiveFilters =
    reviewStatusFilter !== "all" ||
    severityFilter !== "all" ||
    categoryFilter !== "all" ||
    studentFilter !== "all";

  function clearFilters() {
    setReviewStatusFilter("all");
    setSeverityFilter("all");
    setCategoryFilter("all");
    setStudentFilter("all");
  }

  if (loading) return <LoadingState label="Loading integrity evidence…" />;
  if (error) return <ErrorState message={error} />;
  if (!data) return <ErrorState message="No data available." />;

  const visibleStudents = showAllStudents
    ? reviewQueue
    : reviewQueue.slice(0, STUDENT_REVIEW_QUEUE_INITIAL_LIMIT);

  const hasMoreStudents = reviewQueue.length > STUDENT_REVIEW_QUEUE_INITIAL_LIMIT;
  const contextEventCount = events.length - reviewableEvents.length;

  return (
    <div className="mx-auto max-w-none">
      <LecturerPageHeader
        breadcrumbs={[
          { label: "Dashboard", href: "/lecturer" },
          { label: examTitle ?? "Exam", href: `/lecturer/exams/${id}` },
          { label: "Integrity" },
        ]}
        title="Exam integrity"
        description={`${examTitle ?? "Exam"} · Find the submissions that genuinely need human review.`}
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
          value={reviewQueue.length}
          label="Students needing review"
          accent={reviewQueue.length > 0 ? "warning" : "neutral"}
          icon={<IntegrityIcon className="h-[18px] w-[18px]" />}
        />
        <MetricCard
          value={highPriorityStudentCount}
          label="High priority"
          accent={highPriorityStudentCount > 0 ? "critical" : "neutral"}
          icon={<IntegrityIcon className="h-[18px] w-[18px]" />}
        />
        <MetricCard
          value={unresolvedReviewableCount}
          label="Open review signals"
          accent={unresolvedReviewableCount > 0 ? "warning" : "neutral"}
          icon={<IntegrityIcon className="h-[18px] w-[18px]" />}
        />
        <MetricCard
          value={reviewedStudentCount}
          label="Students reviewed"
          accent={reviewedStudentCount > 0 ? "success" : "neutral"}
          icon={<IntegrityIcon className="h-[18px] w-[18px]" />}
        />
      </div>

      <div className="mt-5 rounded-xl border border-lecturer-border bg-lecturer-surface px-4 py-3 text-sm text-lecturer-text-secondary">
        <span className="font-semibold text-lecturer-text-primary">How to use this page:</span>{" "}
        review signals are observations that may require attention, not misconduct findings.
        Routine navigation, successful controls and Brainstorm safeguards remain available in the
        full audit log but do not drive the review queue.
      </div>

      <div className="mt-8 space-y-8">
        <section>
          <SectionHeading
            title="Review queue"
            badge={countLabel(reviewQueue.length, "student")}
            subtitle="Students are prioritised from the integrity signals already recorded by Tether — a deterministic point score, not AI. It is evidence for human review, not a misconduct determination."
          />
          <div className="mt-3 space-y-2">
            {reviewQueue.length === 0 && (
              <div className="rounded-xl border border-lecturer-border bg-lecturer-surface p-5">
                <p className="text-sm font-semibold text-lecturer-text-primary">
                  No meaningful integrity signals require review.
                </p>
                <p className="mt-1 text-sm text-lecturer-text-secondary">
                  Tether still retained {countLabel(events.length, "audit event")} for the full technical record.
                </p>
              </div>
            )}

            {visibleStudents.map((group) => (
              <StudentReviewCard key={group.studentId} group={group} events={events} />
            ))}
          </div>

          {hasMoreStudents && (
            <button
              type="button"
              onClick={() => setShowAllStudents((value) => !value)}
              className="mt-3 rounded text-sm font-medium text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
            >
              {showAllStudents ? "Show fewer" : `Show all ${countLabel(reviewQueue.length, "student")}`}
            </button>
          )}
        </section>

        <section>
          <SectionHeading
            title="Evidence model"
            subtitle="What Tether keeps for the lecturer and institutional audit trail."
          />
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <EvidenceModelCard
              title="Review signals"
              tone="warning"
              body={`${countLabel(reviewableEvents.length, "signal")} such as camera, screen-share, lockdown, window/focus and other policy-relevant observations.`}
            />
            <EvidenceModelCard
              title="Control evidence"
              tone="success"
              body="Successful identity, camera, screen-share and recovery events show that safeguards were active or restored."
            />
            <EvidenceModelCard
              title="Context & audit"
              tone="neutral"
              body={`${countLabel(contextEventCount, "event")} including navigation, Brainstorm safeguards and technical activity retained without being treated as suspicious.`}
            />
          </div>
        </section>

        <details className="rounded-xl border border-lecturer-border bg-lecturer-surface">
          <summary className="cursor-pointer list-none px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-lecturer-text-primary">Full activity log</p>
                <p className="mt-0.5 text-xs text-lecturer-text-secondary">
                  {countLabel(events.length, "recorded event")} · complete audit trail, most recent first
                </p>
              </div>
              <span className="text-sm font-semibold text-lecturer-accent">Show audit log</span>
            </div>
          </summary>

          <div className="border-t border-lecturer-border px-4 pb-4">
            {events.length > 0 && (
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

            <div className="mt-3 overflow-hidden rounded-xl border border-lecturer-border">
              {events.length === 0 && (
                <p className="p-6 text-center text-sm text-lecturer-text-secondary">
                  No integrity events recorded.
                </p>
              )}

              {events.length > 0 && filteredEvents.length === 0 && (
                <p className="p-6 text-center text-sm text-lecturer-text-secondary">
                  No events match the current filters.
                </p>
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
          </div>
        </details>
      </div>
    </div>
  );
}

function EvidenceModelCard({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone: "warning" | "success" | "neutral";
}) {
  const dotClass =
    tone === "warning" ? "bg-amber-500" : tone === "success" ? "bg-green-500" : "bg-slate-400";

  return (
    <div className="rounded-xl border border-lecturer-border bg-lecturer-surface p-4">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
        <p className="text-sm font-semibold text-lecturer-text-primary">{title}</p>
      </div>
      <p className="mt-2 text-sm leading-5 text-lecturer-text-secondary">{body}</p>
    </div>
  );
}

function StudentReviewCard({ group, events }: { group: StudentGroup; events: IntegrityEventRow[] }) {
  const studentReviewableEvents = useMemo(
    () => events.filter((event) => event.student.id === group.studentId && isReviewableEvent(event)),
    [events, group.studentId],
  );

  const unresolved = studentReviewableEvents.filter((event) => !event.resolvedAt);

  const signalCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of studentReviewableEvents) {
      const label = displayLabelForEvent(event).replace(/\s+—\s+needs review$/i, "");
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  }, [studentReviewableEvents]);

  const categories = useMemo(() => {
    const present = new Set(
      studentReviewableEvents.map((event) => categoryForEventType(event.eventType)),
    );
    return Array.from(present).map((category) =>
      INTEGRITY_EVENT_CATEGORY_LABELS[category].replace(" events", ""),
    );
  }, [studentReviewableEvents]);

  const allReviewed = studentReviewableEvents.length > 0 && unresolved.length === 0;

  return (
    <div className="rounded-xl border border-lecturer-border bg-lecturer-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-lecturer-text-primary">{group.studentName}</p>
          <p className="truncate text-xs text-lecturer-text-secondary">{group.studentEmail}</p>
        </div>
        {allReviewed ? <StatusBadge tone="success">Reviewed</StatusBadge> : <ReviewPriorityBadge level={group.riskLevel} />}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {signalCounts.map(([label, count]) => (
          <span key={label} className="rounded-full bg-lecturer-border-subtle px-2.5 py-1 text-xs text-lecturer-text-primary">
            {label}
            {count > 1 ? ` ×${count}` : ""}
          </span>
        ))}
      </div>

      <p className="mt-2 text-xs text-lecturer-text-secondary">
        {countLabel(unresolved.length, "open signal")} ·{" "}
        {categories.length > 0 ? categories.join(" · ") : "Reviewable integrity evidence"}
      </p>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-lecturer-text-secondary">
          Signals support human review; they do not establish misconduct.
        </span>
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
  const selectClass =
    "mt-1 rounded-lg border border-lecturer-border bg-lecturer-surface px-2.5 py-1.5 text-sm text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent";

  return (
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="filter-review-status" className="block text-xs font-medium text-lecturer-text-secondary">
          Review status
        </label>
        <select
          id="filter-review-status"
          value={reviewStatusFilter}
          onChange={(event) => onReviewStatusFilterChange(event.target.value as ReviewStatusFilterValue)}
          className={selectClass}
        >
          <option value="all">All</option>
          <option value="needs-review">Needs review</option>
          <option value="reviewed">Reviewed</option>
        </select>
      </div>

      <div>
        <label htmlFor="filter-severity" className="block text-xs font-medium text-lecturer-text-secondary">
          Severity
        </label>
        <select
          id="filter-severity"
          value={severityFilter}
          onChange={(event) => onSeverityFilterChange(event.target.value as SeverityFilterValue)}
          className={selectClass}
        >
          <option value="all">All</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
          <option value="INFO">Info</option>
        </select>
      </div>

      <div>
        <label htmlFor="filter-category" className="block text-xs font-medium text-lecturer-text-secondary">
          Evidence type
        </label>
        <select
          id="filter-category"
          value={categoryFilter}
          onChange={(event) => onCategoryFilterChange(event.target.value as CategoryFilterValue)}
          className={selectClass}
        >
          <option value="all">All evidence types</option>
          {CATEGORY_FILTER_OPTIONS.map((category) => (
            <option key={category} value={category}>
              {INTEGRITY_EVENT_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </div>

      {students.length > 1 && (
        <div>
          <label htmlFor="filter-student" className="block text-xs font-medium text-lecturer-text-secondary">
            Student
          </label>
          <select
            id="filter-student"
            value={studentFilter}
            onChange={(event) => onStudentFilterChange(event.target.value)}
            className={selectClass}
          >
            <option value="all">All students</option>
            {students.map((student) => (
              <option key={student.studentId} value={student.studentId}>
                {student.studentName}
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
  const reviewable = isReviewableEvent(event);
  const time = new Date(event.occurredAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const isReviewing = activeNoteEventId === event.id;

  return (
    <li className="border-b border-lecturer-border px-4 py-3 last:border-b-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-lecturer-text-secondary">{time}</span>
            <SeverityBadge severity={event.severity} />
            <EvidenceClassBadge event={event} />
            {reviewable && resolved && <StatusBadge tone="success">Reviewed</StatusBadge>}
          </div>

          <p className="mt-1 text-sm font-semibold text-lecturer-text-primary">{displayLabelForEvent(event)}</p>
          <p className="mt-0.5 text-sm text-lecturer-text-secondary">{event.message}</p>
          <p className="mt-0.5 text-xs text-lecturer-text-secondary">
            {event.student.name} · {event.student.email}
          </p>

          {event.eventType === "AI_ASSISTANCE_RESPONSE_REGENERATED" && (
            <p className="mt-1 text-xs font-medium text-lecturer-text-secondary">
              System safeguard — not an integrity violation.
            </p>
          )}

          {event.resolutionNote && (
            <p className="mt-1 text-xs text-lecturer-text-secondary">Review note: {event.resolutionNote}</p>
          )}

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
            </div>
          </details>
        </div>

        {reviewable && !resolved && (
          <div className="shrink-0">
            {isReviewing ? (
              <div className="flex flex-col gap-1.5 sm:items-end">
                <input
                  autoFocus
                  placeholder="Review note"
                  aria-label="Review note"
                  className="w-full rounded-lg border border-lecturer-border px-2.5 py-1.5 text-xs text-lecturer-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent sm:w-44"
                  value={noteText}
                  onChange={(event) => onNoteChange(event.target.value)}
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
