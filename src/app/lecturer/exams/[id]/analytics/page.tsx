"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

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

type Analytics = {
  summary: Summary;
  scoreDistribution: ScoreBand[];
  questionAnalytics: QuestionAnalytics[];
  studentResults: StudentResult[];
  insights: Insight[];
};

function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function dateStr(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function ExamAnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);

  const [examTitle, setExamTitle] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
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
      setPublished(exam.published);
    }

    if (!analyticsRes.ok) {
      setError(
        analyticsRes.status === 403
          ? "You don't have access to this exam's analytics."
          : "Failed to load analytics.",
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

  if (loading) return <p className="text-gray-500">Loading analytics...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="text-red-600">No analytics available.</p>;

  const maxBandCount = Math.max(1, ...data.scoreDistribution.map((b) => b.count));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{examTitle ?? "Exam"} — Analytics</h1>
          <span
            className={
              published
                ? "mt-1 inline-block rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                : "mt-1 inline-block rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
            }
          >
            {published ? "Published" : "Draft"}
          </span>
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/lecturer/exams/${id}/analytics/export.csv`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Export CSV
          </a>
          <Link
            href={`/lecturer/exams/${id}`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Back to exam
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryCard label="Average score" value={pct(data.summary.averageScorePct)} />
        <SummaryCard label="Median score" value={pct(data.summary.medianScorePct)} />
        <SummaryCard label="Pass rate" value={pct(data.summary.passRatePct)} />
        <SummaryCard label="Completion rate" value={pct(data.summary.completionRatePct)} />
        <SummaryCard
          label="Submitted"
          value={`${data.summary.totalSubmitted} / ${data.summary.totalStudentsStarted}`}
        />
        <SummaryCard label="Pending grading" value={String(data.summary.pendingGradingCount)} />
      </div>

      <h2 className="mt-8 text-lg font-medium">Score distribution</h2>
      <div className="mt-3 rounded border border-gray-200 p-4">
        {data.scoreDistribution.every((b) => b.count === 0) ? (
          <p className="text-sm text-gray-500">Not enough graded submissions yet.</p>
        ) : (
          <div className="flex items-end gap-1">
            {data.scoreDistribution.map((band) => (
              <div key={band.band} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-black"
                  style={{ height: `${(band.count / maxBandCount) * 120 + (band.count > 0 ? 4 : 0)}px` }}
                  title={`${band.band}%: ${band.count}`}
                />
                <span className="text-[10px] text-gray-500">{band.band}</span>
                <span className="text-[10px] text-gray-400">{band.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <h2 className="mt-8 text-lg font-medium">Question analysis</h2>
      <div className="mt-3 overflow-x-auto rounded border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left">
              <th className="p-2">Question</th>
              <th className="p-2">Type</th>
              <th className="p-2">Attempts</th>
              <th className="p-2">Correct / avg score</th>
              <th className="p-2">Avg time</th>
              <th className="p-2">Review status</th>
              <th className="p-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {data.questionAnalytics.map((q) => (
              <tr key={q.questionId} className="border-b border-gray-100">
                <td className="max-w-xs p-2">{q.questionText}</td>
                <td className="p-2">{q.questionType}</td>
                <td className="p-2">{q.attempts}</td>
                <td className="p-2">
                  {q.correctRatePct != null ? pct(q.correctRatePct) : pct(q.averageScorePct)}
                </td>
                <td className="p-2">
                  {q.averageTimeSpentSeconds != null
                    ? `${Math.round(q.averageTimeSpentSeconds)}s`
                    : "Not enough data yet"}
                </td>
                <td className="p-2">
                  {q.attempts === 0 ? (
                    <span className="text-gray-500">Not enough data yet</span>
                  ) : q.reviewRecommended ? (
                    <span className="text-red-600">Review suggested</span>
                  ) : (
                    <span className="text-green-700">Looks healthy</span>
                  )}
                </td>
                <td className="p-2 text-gray-500">{q.reviewReason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-lg font-medium">Student results</h2>
      <div className="mt-3 overflow-x-auto rounded border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left">
              <th className="p-2">Student</th>
              <th className="p-2">Status</th>
              <th className="p-2">Score</th>
              <th className="p-2">Submitted</th>
              <th className="p-2">Graded</th>
              <th className="p-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {data.studentResults.map((s) => (
              <tr key={s.submissionId} className="border-b border-gray-100">
                <td className="p-2">
                  <div>{s.studentName}</div>
                  <div className="text-xs text-gray-500">{s.studentEmail}</div>
                </td>
                <td className="p-2">{s.status}</td>
                <td className="p-2">
                  {s.totalScore != null ? `${s.totalScore} / ${s.maxScore} (${pct(s.scorePct)})` : "—"}
                </td>
                <td className="p-2">{dateStr(s.submittedAt)}</td>
                <td className="p-2">{dateStr(s.gradedAt)}</td>
                <td className="p-2">
                  {s.status !== "IN_PROGRESS" && (
                    <Link
                      href={`/lecturer/exams/${id}/submissions/${s.submissionId}`}
                      className="underline"
                    >
                      {s.status === "GRADED" ? "Review" : "Grade"}
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-lg font-medium">Insights</h2>
      <div className="mt-3 space-y-2">
        {data.insights.length === 0 && (
          <p className="text-sm text-gray-500">No insights yet.</p>
        )}
        {data.insights.map((insight, i) => (
          <div
            key={i}
            className={
              insight.severity === "HIGH"
                ? "rounded border border-red-200 bg-red-50 p-3"
                : insight.severity === "WARNING"
                  ? "rounded border border-yellow-200 bg-yellow-50 p-3"
                  : "rounded border border-gray-200 bg-gray-50 p-3"
            }
          >
            <p className="font-medium">{insight.title}</p>
            <p className="mt-1 text-sm text-gray-600">{insight.description}</p>
            <p className="mt-1 text-sm text-gray-500">{insight.recommendedAction}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
