"use client";

import { useEffect, useMemo, useState, use as usePromise } from "react";
import Link from "next/link";
import { lecturerAvailabilityStatus, type LecturerAvailabilityStatus } from "@/lib/lecturerDashboardGrouping";

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

const AVAILABILITY_PILL_STYLES: Record<LecturerAvailabilityStatus, string> = {
  Open: "bg-[#ECFDF3] text-[#067647]",
  Scheduled: "bg-[#EFF6FF] text-[#1D4ED8]",
  Draft: "bg-[#F2F4F7] text-[#667085]",
  Closed: "bg-[#F2F4F7] text-[#667085]",
};

// Presentation-only "is this cohort tiny" cutoff for score-distribution
// and insights wording (e.g. "Limited data · based on 1 graded
// submission"). This does NOT change any analytics calculation, bin, or
// threshold in src/lib/analytics.ts — it only decides whether to show an
// extra caveat sentence.
const SMALL_SAMPLE_THRESHOLD = 5;

function AnalyticsMetric({
  label,
  value,
  caption,
  accent = "neutral",
}: {
  label: string;
  value: string;
  caption?: string;
  accent?: "neutral" | "info" | "warning";
}) {
  const dotColor = { neutral: "bg-[#98A2B3]", info: "bg-[#2563EB]", warning: "bg-[#D97706]" }[accent];
  const tintClasses = accent === "warning" ? "border-[#FEDF89] bg-[#FFFAEB]" : "border-[#E4E7EC] bg-white";

  return (
    <div className={`rounded-xl border p-4 ${tintClasses}`}>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
        <span className="text-sm font-medium text-[#667085]">{label}</span>
      </div>
      <div className="mt-1.5 text-2xl font-bold text-[#101828]">{value}</div>
      {caption && <p className="mt-0.5 text-xs text-[#667085]">{caption}</p>}
    </div>
  );
}

function SectionHeader({ title, badge, subtitle }: { title: string; badge?: string; subtitle?: string }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold text-[#101828]">{title}</h2>
        {badge && <span className="text-sm font-medium text-[#667085]">{badge}</span>}
      </div>
      {subtitle && <p className="mt-0.5 max-w-2xl text-sm text-[#667085]">{subtitle}</p>}
    </div>
  );
}

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
    <li className={`border-b border-[#E4E7EC] px-4 py-3 last:border-b-0 ${QUESTION_ROW_COLUMNS}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-[#101828]" title={q.questionText}>
          {q.questionText}
        </p>
        <p className="text-xs text-[#667085]">{q.maxScore} pt(s)</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Type</p>
        <p className="text-sm text-[#101828]">{QUESTION_TYPE_LABELS[q.questionType] ?? q.questionType}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Attempts</p>
        <p className="text-sm text-[#101828]">{q.attempts}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Average score / Correct</p>
        <p className="text-sm text-[#101828]">{scoreLabel}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Average time</p>
        <p className="text-sm text-[#101828]">{timeLabel}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Review status</p>
        {!hasData ? (
          <span className="text-sm text-[#667085]">Not enough data</span>
        ) : q.reviewRecommended ? (
          <span className="inline-flex items-center rounded-full bg-[#FFFAEB] px-2 py-0.5 text-xs font-medium text-[#92400E]">
            Review suggested
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-[#ECFDF3] px-2 py-0.5 text-xs font-medium text-[#067647]">
            Looks healthy
          </span>
        )}
        {q.reviewReason && <p className="mt-0.5 text-xs text-[#667085]">{q.reviewReason}</p>}
      </div>
    </li>
  );
}

const STUDENT_ROW_COLUMNS = "md:grid md:grid-cols-[1fr_110px_110px_130px_170px_170px_100px] md:items-center md:gap-4";

function StudentResultRow({ examId, s }: { examId: string; s: StudentResult }) {
  const scoreLabel = s.totalScore != null ? `${s.totalScore} / ${s.maxScore} (${pct(s.scorePct)})` : "—";

  return (
    <li className={`border-b border-[#E4E7EC] px-4 py-3 last:border-b-0 ${STUDENT_ROW_COLUMNS}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-[#101828]">{s.studentName}</p>
        <p className="truncate text-xs text-[#667085]">
          {s.studentEmail} · Attempt {s.attemptNumber}
        </p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Marking</p>
        <p className="text-sm text-[#101828]">{MARKING_LABELS[s.status] ?? s.status}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Score</p>
        <p className="text-sm text-[#101828]">{scoreLabel}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Submitted</p>
        <p className="text-sm text-[#101828]">{dateStr(s.submittedAt)}</p>
      </div>
      <div className="mt-2 md:mt-0">
        <p className="text-xs font-medium text-[#667085] md:sr-only">Graded</p>
        <p className="text-sm text-[#101828]">{dateStr(s.gradedAt)}</p>
      </div>
      <div className="mt-3 md:mt-0 md:text-right">
        {s.status !== "IN_PROGRESS" && (
          <Link
            href={`/lecturer/exams/${examId}/submissions/${s.submissionId}`}
            className="rounded text-sm font-semibold text-[#2563EB] hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
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
  INFO: "border-[#E4E7EC] bg-white",
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

  if (loading) return <p className="mx-auto max-w-7xl text-sm text-[#667085]">Loading analytics…</p>;

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

  if (!data) return <p className="mx-auto max-w-7xl text-sm text-[#DC2626]">No analytics available.</p>;

  const { summary, integritySummary, integrityRiskSummary } = data;
  const isSmallSample = summary.totalGraded > 0 && summary.totalGraded < SMALL_SAMPLE_THRESHOLD;

  return (
    <div className="mx-auto max-w-7xl">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-[#667085]">Analytics</p>
          <a
            href={`/api/lecturer/exams/${id}/analytics/export.csv`}
            className="rounded-lg border border-[#E4E7EC] bg-white px-3 py-1.5 text-sm font-medium text-[#101828] hover:bg-[#F9FAFB] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2"
          >
            Export CSV
          </a>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-bold text-[#101828]">{examTitle ?? "Exam"}</h1>
          {availabilityStatus && (
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${AVAILABILITY_PILL_STYLES[availabilityStatus]}`}>
              {availabilityStatus}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-[#667085]">Performance, question outcomes, and integrity review signals.</p>
        <Link
          href={`/lecturer/exams/${id}`}
          className="mt-2 inline-block rounded text-sm font-medium text-[#667085] hover:text-[#101828] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
        >
          ← Back to exam
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <AnalyticsMetric
          label="Average score"
          value={pct(summary.averageScorePct)}
          caption={summary.totalGraded > 0 ? countLabel(summary.totalGraded, "graded submission") : undefined}
        />
        <AnalyticsMetric
          label="Median score"
          value={pct(summary.medianScorePct)}
          caption={summary.totalGraded > 0 ? countLabel(summary.totalGraded, "graded submission") : undefined}
        />
        <AnalyticsMetric
          label="Pass rate"
          value={pct(summary.passRatePct)}
          caption={passedCount != null ? `${passedCount} of ${summary.totalGraded} passed` : undefined}
        />
        <AnalyticsMetric label="Completion" value={pct(summary.completionRatePct)} />
        <AnalyticsMetric label="Submitted" value={`${summary.totalSubmitted} / ${summary.totalStudentsStarted}`} />
        <AnalyticsMetric
          label="Awaiting marking"
          value={String(summary.pendingGradingCount)}
          accent={summary.pendingGradingCount > 0 ? "warning" : "neutral"}
        />
      </div>

      <div className="mt-8 space-y-8">
        <section>
          <SectionHeader
            title="Score distribution"
            subtitle={
              summary.totalGraded > 0
                ? isSmallSample
                  ? `Limited data · based on ${countLabel(summary.totalGraded, "graded submission")}`
                  : countLabel(summary.totalGraded, "graded submission")
                : undefined
            }
          />
          <div className="mt-3 rounded-xl border border-[#E4E7EC] bg-white p-4">
            {data.scoreDistribution.every((b) => b.count === 0) ? (
              <p className="text-sm text-[#667085]">Not enough graded submissions yet.</p>
            ) : (
              <div className="flex items-end gap-1">
                {data.scoreDistribution.map((band) => (
                  <div key={band.band} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t bg-[#2563EB]"
                      style={{ height: `${(band.count / maxBandCount) * 120 + (band.count > 0 ? 4 : 0)}px` }}
                      title={`${band.band}%: ${band.count}`}
                    />
                    <span className="text-[10px] text-[#667085]">{band.band}</span>
                    <span className="text-[10px] text-[#98A2B3]">{band.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section>
          <SectionHeader title="Question analysis" subtitle="Per-question performance across all finalized submissions." />
          <div className="mt-3 overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
            <div
              className={`hidden border-b border-[#E4E7EC] px-4 py-2 text-xs font-medium text-[#667085] md:grid ${QUESTION_ROW_COLUMNS}`}
              aria-hidden="true"
            >
              <span>Question</span>
              <span>Type</span>
              <span>Attempts</span>
              <span>Average score / Correct</span>
              <span>Average time</span>
              <span>Review status</span>
            </div>
            {data.questionAnalytics.length === 0 && (
              <p className="p-6 text-center text-sm text-[#667085]">No questions in this exam yet.</p>
            )}
            <ul>
              {data.questionAnalytics.map((q) => (
                <QuestionAnalyticsRow key={q.questionId} q={q} />
              ))}
            </ul>
          </div>
        </section>

        <section>
          <SectionHeader title="Student results" subtitle="Every attempt on this exam, most recently started first." />
          <div className="mt-3 overflow-hidden rounded-xl border border-[#E4E7EC] bg-white">
            <div
              className={`hidden border-b border-[#E4E7EC] px-4 py-2 text-xs font-medium text-[#667085] md:grid ${STUDENT_ROW_COLUMNS}`}
              aria-hidden="true"
            >
              <span>Student</span>
              <span>Marking</span>
              <span>Score</span>
              <span>Submitted</span>
              <span>Graded</span>
              <span className="text-right">Action</span>
            </div>
            {data.studentResults.length === 0 && (
              <p className="p-6 text-center text-sm text-[#667085]">No students have started this exam yet.</p>
            )}
            <ul>
              {data.studentResults.map((s) => (
                <StudentResultRow key={s.submissionId} examId={id} s={s} />
              ))}
            </ul>
          </div>
        </section>

        <section>
          <SectionHeader title="Integrity review" />
          <div className="mt-3 rounded-xl border border-[#E4E7EC] bg-white p-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <AnalyticsMetric label={pluralWord(integritySummary.totalEvents, "event")} value={String(integritySummary.totalEvents)} />
              <AnalyticsMetric label={pluralWord(integritySummary.studentsWithEvents, "student")} value={String(integritySummary.studentsWithEvents)} />
              <AnalyticsMetric
                label="Awaiting review"
                value={String(integritySummary.unresolvedEvents)}
                accent={integritySummary.unresolvedEvents > 0 ? "warning" : "neutral"}
              />
              <AnalyticsMetric label="High severity" value={String(integritySummary.highSeverityEvents)} accent={integritySummary.highSeverityEvents > 0 ? "warning" : "neutral"} />
            </div>

            <h3 className="mt-5 text-sm font-semibold text-[#101828]">Review priority by session</h3>
            <p className="mt-0.5 text-xs text-[#667085]">
              These scores help prioritise evidence for human review; they are not misconduct determinations.
            </p>
            <div className="mt-3 space-y-1.5">
              <PriorityBar label="High priority" count={integrityRiskSummary.highRiskSessions} total={totalRiskSessions(integrityRiskSummary)} tone="high" />
              <PriorityBar label="Medium priority" count={integrityRiskSummary.mediumRiskSessions} total={totalRiskSessions(integrityRiskSummary)} tone="medium" />
              <PriorityBar label="Low priority" count={integrityRiskSummary.lowRiskSessions} total={totalRiskSessions(integrityRiskSummary)} tone="low" />
              <PriorityBar label="No priority" count={integrityRiskSummary.cleanSessions} total={totalRiskSessions(integrityRiskSummary)} tone="none" />
            </div>

            {integrityRiskSummary.highRiskStudentCount > 0 && (
              <p className="mt-3 text-xs text-[#667085]">
                {countLabel(integrityRiskSummary.highRiskStudentCount, "student")}{" "}
                {integrityRiskSummary.highRiskStudentCount === 1 ? "has" : "have"} at least one high-priority session for review.
              </p>
            )}

            <Link
              href={`/lecturer/exams/${id}/integrity`}
              className="mt-4 inline-block rounded text-sm font-semibold text-[#2563EB] hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
            >
              Open integrity review →
            </Link>
          </div>
        </section>

        <section>
          <SectionHeader title="Insights" />
          <div className="mt-3 space-y-2">
            {isSmallSample && (
              <div className="rounded-xl border border-[#E4E7EC] bg-white p-3">
                <p className="text-sm font-medium text-[#101828]">Limited performance data</p>
                <p className="mt-1 text-sm text-[#667085]">
                  Analytics currently include {countLabel(summary.totalGraded, "graded submission")}.
                </p>
              </div>
            )}
            {data.insights.length === 0 && <p className="text-sm text-[#667085]">No insights yet.</p>}
            {data.insights.map((insight, i) => {
              const isIntegrityInsight = /integrity/i.test(insight.title) || /integrity/i.test(insight.description);
              return (
                <div key={i} className={`rounded-xl border p-4 ${INSIGHT_STYLES[insight.severity]}`}>
                  <p className="text-sm font-semibold text-[#101828]">{insight.title}</p>
                  <p className="mt-1 text-sm text-[#667085]">{insight.description}</p>
                  <p className="mt-1 text-sm text-[#667085]">{insight.recommendedAction}</p>
                  {isIntegrityInsight && (
                    <Link
                      href={`/lecturer/exams/${id}/integrity`}
                      className="mt-2 inline-block rounded text-sm font-semibold text-[#2563EB] hover:text-[#1D4ED8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
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
  low: "bg-[#2563EB]",
  none: "bg-[#98A2B3]",
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
      <span className="w-28 shrink-0 text-xs font-medium text-[#667085]">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#F2F4F7]">
        <div className={`h-full rounded-full ${PRIORITY_BAR_COLORS[tone]}`} style={{ width: `${widthPct}%` }} />
      </div>
      <span className="w-6 shrink-0 text-right text-xs font-medium text-[#101828]">{count}</span>
    </div>
  );
}
