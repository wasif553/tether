"use client";

import { useEffect, useMemo, useState, use as usePromise } from "react";
import Link from "next/link";
import { lecturerAvailabilityStatus, type LecturerAvailabilityStatus } from "@/lib/lecturerDashboardGrouping";
import { LecturerPageHeader } from "@/components/lecturer/LecturerPageHeader";
import { MetricCard } from "@/components/lecturer/MetricCard";
import { SectionHeading } from "@/components/lecturer/SectionCard";
import { StatusBadge, availabilityToneFor } from "@/components/lecturer/StatusBadge";
import { ErrorState, LoadingState } from "@/components/lecturer/EmptyState";

type Summary = {
  totalStudentsStarted: number;
  totalSubmitted: number;
  totalGraded: number;
  averageScorePct: number | null;
  medianScorePct: number | null;
  highestScorePct: number | null;
  lowestScorePct: number | null;
  passRatePct: number | null;
  completionRatePct: number | null;
  pendingGradingCount: number;
};

type ScoreBand = { band: string; min: number; max: number; count: number };

type QuestionAnalytics = {
  questionId: string;
  questionText: string;
  questionType: string;
  maxScore: number;
  attempts: number;
  correctRatePct: number | null;
  averageScorePct: number | null;
  averageTimeSpentSeconds: number | null;
  reviewRecommended: boolean;
  reviewReason: string | null;
};

type StudentResult = {
  submissionId: string;
  attemptNumber: number;
  studentName: string;
  studentEmail: string;
  status: string;
  scorePct: number | null;
  totalScore: number | null;
  maxScore: number | null;
  submittedAt: string | null;
  gradedAt: string | null;
};

type Insight = {
  severity: "INFO" | "WARNING" | "HIGH";
  title: string;
  description: string;
  recommendedAction: string;
};

type IntegritySummary = {
  totalEvents: number;
  highSeverityEvents: number;
  mediumSeverityEvents: number;
  lowSeverityEvents: number;
  unresolvedEvents: number;
  studentsWithEvents: number;
};

type IntegrityRiskSummary = {
  cleanSessions: number;
  lowRiskSessions: number;
  mediumRiskSessions: number;
  highRiskSessions: number;
  highRiskStudentCount: number;
};

type Analytics = {
  summary: Summary;
  scoreDistribution: ScoreBand[];
  questionAnalytics: QuestionAnalytics[];
  studentResults: StudentResult[];
  integritySummary: IntegritySummary;
  integrityRiskSummary: IntegrityRiskSummary;
  insights: Insight[];
};

function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function dateStr(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function countLabel(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function pluralWord(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

// Presentation-only mapping — Question.type is untouched. Same pattern as
// MARKING_LABELS on the Submissions workspace page.
const QUESTION_TYPE_LABELS: Record<string, string> = {
  MULTIPLE_CHOICE: "Multiple choice",
  SHORT_ANSWER: "Short answer",
  ESSAY: "Essay",
};

// Same marking-status vocabulary already established on the Submissions
// workspace page — not a new lifecycle, just human-readable labels for
// the same submission `status` values.
const MARKING_LABELS: Record<string, string> = {
  IN_PROGRESS: "In progress",
  SUBMITTED: "Not marked",
  GRADED: "Marked",
};

// Presentation-only "is this cohort tiny" cutoff for score-distribution
// and insights wording (e.g. "Limited data · based on 1 graded
// submission"). This does NOT change any analytics calculation, bin, or
// threshold in src/lib/analytics.ts — it only decides whether to show an
// extra caveat sentence.
const SMALL_SAMPLE_THRESHOLD = 5;

const QUESTION_ROW_COLUMNS = "md:grid md:grid-cols-[1.4fr_130px_90px_150px_110px_170px] md:items-center md:gap-4";

function QuestionAnalyticsRow({ q }: { q: QuestionAnalytics }) {
  const hasData = q.attempts > 0;
  const scoreLabel =
    q.correctRatePct != null
      ? `${pct(q.correctRatePct)} correct`
      : q.averageScorePct != null
        ? `${pct(q.averageScorePct)} avg`
        : "Not enough data";
  const timeLabel = q.averageTimeSpentSeconds != null ? `${Math.round(q.averageTimeSpentSeconds)}s` : "Not enough data";

  return (
    <li className={`border-b border-lecturer-border px-4 py-3 last:border-b-0 ${QUESTION_ROW_COLUMNS}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-lecturer-text-primary" title={q.questionText}>
          {q.questionText}
        </p>
        <p className="text-xs text-lecturer-text-secondary">{q.maxScore} pt(s)</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Type</p>
        <p className="text-sm text-lecturer-text-primary">{QUESTION_TYPE_LABELS[q.questionType] ?? q.questionType}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Attempts</p>
        <p className="text-sm text-lecturer-text-primary">{q.attempts}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Average score / Correct</p>
        <p className="text-sm text-lecturer-text-primary">{scoreLabel}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Average time</p>
        <p className="text-sm text-lecturer-text-primary">{timeLabel}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Review status</p>
        {!hasData ? (
          <span className="text-sm text-lecturer-text-secondary">Not enough data</span>
        ) : q.reviewRecommended ? (
          <StatusBadge tone="warning">Review suggested</StatusBadge>
        ) : (
          <StatusBadge tone="success">Looks healthy</StatusBadge>
        )}
        {q.reviewReason && <p className="mt-0.5 text-xs text-lecturer-text-secondary">{q.reviewReason}</p>}
      </div>
    </li>
  );
}

const STUDENT_ROW_COLUMNS = "md:grid md:grid-cols-[1fr_110px_110px_130px_170px_170px_100px] md:items-center md:gap-4";

function StudentResultRow({ examId, s }: { examId: string; s: StudentResult }) {
  const scoreLabel = s.totalScore != null ? `${s.totalScore} / ${s.maxScore} (${pct(s.scorePct)})` : "—";

  return (
    <li className={`border-b border-lecturer-border px-4 py-3 last:border-b-0 ${STUDENT_ROW_COLUMNS}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-lecturer-text-primary">{s.studentName}</p>
        <p className="truncate text-xs text-lecturer-text-secondary">
          {s.studentEmail} · Attempt {s.attemptNumber}
        </p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Marking</p>
        <p className="text-sm text-lecturer-text-primary">{MARKING_LABELS[s.status] ?? s.status}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Score</p>
        <p className="text-sm text-lecturer-text-primary">{scoreLabel}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Submitted</p>
        <p className="text-sm text-lecturer-text-primary">{dateStr(s.submittedAt)}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-lecturer-text-secondary md:sr-only">Graded</p>
        <p className="text-sm text-lecturer-text-primary">{dateStr(s.gradedAt)}</p>
      </div>
      <div className="mt-3 md:mt-0 md:text-right">
        {s.status !== "IN_PROGRESS" && (
          <Link
            href={`/lecturer/exams/${examId}/submissions/${s.submissionId}`}
            className="rounded text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
          >
            {s.status === "GRADED" ? "Review →" : "Grade →"}
          </Link>
        )}
      </div>
    </li>
  );
}

const INSIGHT_STYLES: Record<Insight["severity"], string> = {
  HIGH: "border-[#FECDCA] bg-[#FEF2F2]",
  WARNING: "border-[#FEDF89] bg-[#FFFAEB]",
  INFO: "border-lecturer-border bg-lecturer-surface",
};

export default function ExamAnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);

  const [examTitle, setExamTitle] = useState<string | null>(null);
  const [availabilityStatus, setAvailabilityStatus] = useState<LecturerAvailabilityStatus | null>(null);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);

    const [examRes, analyticsRes] = await Promise.all([
      fetch(`/api/exams/${id}`),
      fetch(`/api/lecturer/exams/${id}/analytics`),
    ]);

    if (examRes.ok) {
      const exam = await examRes.json();
      setExamTitle(exam.title);
      // Same Draft/Scheduled/Open/Closed classification already used on
      // the Lecturer Dashboard and Exam Workspace — no new lifecycle
      // vocabulary, and no extra request (exam.availableFrom/Until are
      // already part of this same /api/exams/[id] response).
      setAvailabilityStatus(
        lecturerAvailabilityStatus({
          published: exam.published,
          availableFrom: exam.availableFrom,
          availableUntil: exam.availableUntil,
          needsReviewCount: 0,
        }),
      );
    }

    if (!analyticsRes.ok) {
      setError(
        analyticsRes.status === 403
          ? "You don't have access to this exam's analytics."
          : "Failed to load analytics. Try refreshing the page.",
      );
      setLoading(false);
      return;
    }

    setData(await analyticsRes.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [id]);

  const maxBandCount = useMemo(
    () => (data ? Math.max(1, ...data.scoreDistribution.map((b) => b.count)) : 1),
    [data],
  );

  // Exact, not approximated: passRatePct is (passed / totalGraded) * 100
  // at full float precision (see src/lib/analytics.ts passRatePct) — this
  // recovers the integer passed-count from that same precise value
  // rather than introducing any new calculation.
  const passedCount = useMemo(() => {
    if (!data || data.summary.passRatePct == null) return null;
    return Math.round((data.summary.passRatePct / 100) * data.summary.totalGraded);
  }, [data]);

  if (loading) return <LoadingState label="Loading analytics…" />;

  if (error) return <ErrorState message={error} onRetry={load} />;

  if (!data) return <ErrorState message="No analytics available." />;

  const { summary, integritySummary, integrityRiskSummary } = data;
  const isSmallSample = summary.totalGraded > 0 && summary.totalGraded < SMALL_SAMPLE_THRESHOLD;

  return (
    <div className="mx-auto max-w-7xl">
      <LecturerPageHeader
        breadcrumbs={[{ label: "Dashboard", href: "/lecturer" }, { label: examTitle ?? "Exam", href: `/lecturer/exams/${id}` }, { label: "Analytics" }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {examTitle ?? "Exam"}
            {availabilityStatus && <StatusBadge tone={availabilityToneFor(availabilityStatus)}>{availabilityStatus}</StatusBadge>}
          </span>
        }
        description="Performance, question outcomes, and integrity review signals."
        actions={
          <a
            href={`/api/lecturer/exams/${id}/analytics/export.csv`}
            className="rounded-lg border border-lecturer-border bg-lecturer-surface px-3 py-1.5 text-sm font-medium text-lecturer-text-primary hover:bg-lecturer-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent focus-visible:ring-offset-2"
          >
            Export CSV
          </a>
        }
      />

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="Average score"
          value={pct(summary.averageScorePct)}
        />
        <MetricCard
          label="Median score"
          value={pct(summary.medianScorePct)}
        />
        <MetricCard
          label="Pass rate"
          value={pct(summary.passRatePct)}
        />
        <MetricCard label="Completion" value={pct(summary.completionRatePct)} />
        <MetricCard label="Submitted" value={`${summary.totalSubmitted} / ${summary.totalStudentsStarted}`} />
        <MetricCard
          label="Awaiting marking"
          value={summary.pendingGradingCount}
          accent={summary.pendingGradingCount > 0 ? "warning" : "neutral"}
        />
      </div>
      {(summary.totalGraded > 0 || passedCount != null) && (
        <p className="mt-2 text-xs text-lecturer-text-secondary">
          {summary.totalGraded > 0 && countLabel(summary.totalGraded, "graded submission")}
          {passedCount != null && ` · ${passedCount} of ${summary.totalGraded} passed`}
        </p>
      )}

      <div className="mt-8 space-y-8">
        <section>
          <SectionHeading
            title="Score distribution"
            subtitle={
              summary.totalGraded > 0
                ? isSmallSample
                  ? `Limited data · based on ${countLabel(summary.totalGraded, "graded submission")}`
                  : countLabel(summary.totalGraded, "graded submission")
                : undefined
            }
          />
          <div className="mt-3 rounded-xl border border-lecturer-border bg-lecturer-surface p-4">
            {data.scoreDistribution.every((b) => b.count === 0) ? (
              <p className="text-sm text-lecturer-text-secondary">Not enough graded submissions yet.</p>
            ) : (
              <div className="flex items-end gap-1">
                {data.scoreDistribution.map((band) => (
                  <div key={band.band} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t bg-lecturer-accent"
                      style={{ height: `${(band.count / maxBandCount) * 120 + (band.count > 0 ? 4 : 0)}px` }}
                      title={`${band.band}%: ${band.count}`}
                    />
                    <span className="text-[10px] text-lecturer-text-secondary">{band.band}</span>
                    <span className="text-[10px] text-lecturer-text-muted">{band.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section>
          <SectionHeading title="Question analysis" subtitle="Per-question performance across all finalized submissions." />
          <div className="mt-3 overflow-hidden rounded-xl border border-lecturer-border bg-lecturer-surface">
            <div
              className={`hidden border-b border-lecturer-border px-4 py-2 text-xs font-medium text-lecturer-text-secondary md:grid ${QUESTION_ROW_COLUMNS}`}
              aria-hidden="true"
            >
              <span>Question</span>
              <span>Type</span>
              <span>Attempts</span>
              <span>Average score / Correct</span>
              <span>Average time</span>
              <span>Review status</span>
            </div>
            {data.questionAnalytics.length === 0 && <p className="p-6 text-center text-sm text-lecturer-text-secondary">No questions in this exam yet.</p>}
            <ul>
              {data.questionAnalytics.map((q) => (
                <QuestionAnalyticsRow key={q.questionId} q={q} />
              ))}
            </ul>
          </div>
        </section>

        <section>
          <SectionHeading title="Student results" subtitle="Every attempt on this exam, most recently started first." />
          <div className="mt-3 overflow-hidden rounded-xl border border-lecturer-border bg-lecturer-surface">
            <div
              className={`hidden border-b border-lecturer-border px-4 py-2 text-xs font-medium text-lecturer-text-secondary md:grid ${STUDENT_ROW_COLUMNS}`}
              aria-hidden="true"
            >
              <span>Student</span>
              <span>Marking</span>
              <span>Score</span>
              <span>Submitted</span>
              <span>Graded</span>
              <span className="text-right">Action</span>
            </div>
            {data.studentResults.length === 0 && <p className="p-6 text-center text-sm text-lecturer-text-secondary">No students have started this exam yet.</p>}
            <ul>
              {data.studentResults.map((s) => (
                <StudentResultRow key={s.submissionId} examId={id} s={s} />
              ))}
            </ul>
          </div>
        </section>

        <section>
          <SectionHeading title="Integrity review" />
          <div className="mt-3 rounded-xl border border-lecturer-border bg-lecturer-surface p-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricCard label={pluralWord(integritySummary.totalEvents, "event")} value={integritySummary.totalEvents} />
              <MetricCard label={pluralWord(integritySummary.studentsWithEvents, "student")} value={integritySummary.studentsWithEvents} />
              <MetricCard label="Awaiting review" value={integritySummary.unresolvedEvents} accent={integritySummary.unresolvedEvents > 0 ? "warning" : "neutral"} />
              <MetricCard label="High severity" value={integritySummary.highSeverityEvents} accent={integritySummary.highSeverityEvents > 0 ? "warning" : "neutral"} />
            </div>

            <h3 className="mt-5 text-sm font-semibold text-lecturer-text-primary">Review priority by session</h3>
            <p className="mt-0.5 text-xs text-lecturer-text-secondary">These scores help prioritise evidence for human review; they are not misconduct determinations.</p>
            <div className="mt-3 space-y-1.5">
              <PriorityBar label="High priority" count={integrityRiskSummary.highRiskSessions} total={totalRiskSessions(integrityRiskSummary)} tone="high" />
              <PriorityBar label="Medium priority" count={integrityRiskSummary.mediumRiskSessions} total={totalRiskSessions(integrityRiskSummary)} tone="medium" />
              <PriorityBar label="Low priority" count={integrityRiskSummary.lowRiskSessions} total={totalRiskSessions(integrityRiskSummary)} tone="low" />
              <PriorityBar label="No priority" count={integrityRiskSummary.cleanSessions} total={totalRiskSessions(integrityRiskSummary)} tone="none" />
            </div>

            {integrityRiskSummary.highRiskStudentCount > 0 && (
              <p className="mt-3 text-xs text-lecturer-text-secondary">
                {countLabel(integrityRiskSummary.highRiskStudentCount, "student")} {integrityRiskSummary.highRiskStudentCount === 1 ? "has" : "have"} at least one high-priority session for review.
              </p>
            )}

            <Link
              href={`/lecturer/exams/${id}/integrity`}
              className="mt-4 inline-block rounded text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
            >
              Open integrity review →
            </Link>
          </div>
        </section>

        <section>
          <SectionHeading title="Insights" />
          <div className="mt-3 space-y-2">
            {isSmallSample && (
              <div className="rounded-xl border border-lecturer-border bg-lecturer-surface p-3">
                <p className="text-sm font-medium text-lecturer-text-primary">Limited performance data</p>
                <p className="mt-1 text-sm text-lecturer-text-secondary">Analytics currently include {countLabel(summary.totalGraded, "graded submission")}.</p>
              </div>
            )}
            {data.insights.length === 0 && <p className="text-sm text-lecturer-text-secondary">No insights yet.</p>}
            {data.insights.map((insight, i) => {
              const isIntegrityInsight = /integrity/i.test(insight.title) || /integrity/i.test(insight.description);
              return (
                <div key={i} className={`rounded-xl border p-4 ${INSIGHT_STYLES[insight.severity]}`}>
                  <p className="text-sm font-semibold text-lecturer-text-primary">{insight.title}</p>
                  <p className="mt-1 text-sm text-lecturer-text-secondary">{insight.description}</p>
                  <p className="mt-1 text-sm text-lecturer-text-secondary">{insight.recommendedAction}</p>
                  {isIntegrityInsight && (
                    <Link
                      href={`/lecturer/exams/${id}/integrity`}
                      className="mt-2 inline-block rounded text-sm font-semibold text-lecturer-accent hover:text-lecturer-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lecturer-accent"
                    >
                      Open integrity review →
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function totalRiskSessions(r: IntegrityRiskSummary): number {
  return r.cleanSessions + r.lowRiskSessions + r.mediumRiskSessions + r.highRiskSessions;
}

const PRIORITY_BAR_COLORS: Record<"high" | "medium" | "low" | "none", string> = {
  high: "bg-[#DC2626]",
  medium: "bg-[#D97706]",
  low: "bg-lecturer-accent",
  none: "bg-lecturer-text-muted",
};

function PriorityBar({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: "high" | "medium" | "low" | "none";
}) {
  const widthPct = total > 0 ? Math.max(count > 0 ? 4 : 0, (count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-xs font-medium text-lecturer-text-secondary">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-lecturer-border-subtle">
        <div className={`h-full rounded-full ${PRIORITY_BAR_COLORS[tone]}`} style={{ width: `${widthPct}%` }} />
      </div>
      <span className="w-6 shrink-0 text-right text-xs font-medium text-lecturer-text-primary">{count}</span>
    </div>
  );
}
