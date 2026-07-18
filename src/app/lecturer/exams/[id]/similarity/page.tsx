"use client";

/**
 * Answer Similarity Review v1 — see docs/answer-similarity-review-v1.md.
 *
 * Lecturer -> Exam -> Similarity review. Every signal shown here is a
 * REVIEW SIGNAL, never an automatic misconduct finding — the lecturer/
 * institution makes the final decision (see the disclaimer rendered
 * below and the neutral wording used throughout this page).
 */

import { useCallback, useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type MatchRow = {
  id: string;
  signalType: string;
  score: number;
  detail: {
    reasonCode?: string;
    summary?: string;
    metrics?: { cosine: number; ngramJaccard: number; longestSharedPhraseTokens: number };
    sharedPhraseExcerpt?: string | null;
    sharedQuestionCount?: number;
    sameWrongAnswerCount?: number;
    ratio?: number;
    risk?: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  } | null;
  question: { id: string; order: number; text: string } | null;
  sourceSubmission: { id: string; attemptNumber: number; student: { name: string; email: string } };
  comparedSubmission: { id: string; attemptNumber: number; student: { name: string; email: string } };
  reviewStatus: string;
  reviewStatusLabel: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
};

type AnalysisData = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";
  overallRisk: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  analysedAt: string | null;
  algorithmVersion: string;
  summary: {
    submissionsAnalysed?: number;
    pairsCompared?: number;
    matchCount?: number;
    pairRecommendations?: Array<{ submissionIds: [string, string]; recommendation: string; summary: string }>;
    error?: string;
  } | null;
  matches: MatchRow[];
};

const RISK_STYLES: Record<string, string> = {
  NONE: "bg-gray-100 text-gray-600",
  LOW: "bg-blue-100 text-blue-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
};

const SIGNAL_LABELS: Record<string, string> = {
  IDENTICAL_SHORT_ANSWER: "Identical short answer",
  HIGH_TEXT_SIMILARITY: "Text similarity",
  SAME_WRONG_MCQ_PATTERN: "Same wrong MCQ pattern",
};

const REVIEW_ACTIONS: Array<{ status: string; label: string }> = [
  { status: "REVIEWED_NO_CONCERN", label: "Reviewed — no concern" },
  { status: "REVIEWED_CONCERN_REMAINS", label: "Concern remains" },
  { status: "ESCALATED", label: "Escalate" },
  { status: "RESOLVED", label: "Resolve" },
];

export default function SimilarityReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: examId } = usePromise(params);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [reviewNoteDrafts, setReviewNoteDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/lecturer/exams/${examId}/similarity-analysis`);
      if (!res.ok) {
        setLoadError(`Could not load similarity review (status ${res.status}).`);
        return;
      }
      const body = await res.json();
      setData(body.analysis);
    } catch {
      setLoadError("Could not load similarity review — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function runAnalysis() {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/lecturer/exams/${examId}/similarity-analysis`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRunError(typeof body?.error === "string" ? body.error : "Similarity analysis failed. Your exam's submissions are unaffected.");
        return;
      }
      await load();
    } catch {
      setRunError("Could not reach the server. Your exam's submissions are unaffected — try again.");
    } finally {
      setRunning(false);
    }
  }

  async function submitReview(matchId: string, reviewStatus: string) {
    const reviewNote = reviewNoteDrafts[matchId];
    const res = await fetch(`/api/lecturer/similarity-matches/${matchId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus, reviewNote: reviewNote || undefined }),
    });
    if (res.ok) await load();
  }

  if (loading) return <p className="text-gray-500">Loading similarity review...</p>;
  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="text-red-600">{loadError}</p>
        <button onClick={() => load()} className="mt-2 rounded border border-gray-300 px-3 py-1.5 text-sm">
          Try again
        </button>
      </div>
    );
  }

  const needsReviewCount = data?.matches.filter((m) => m.reviewStatus === "NEEDS_REVIEW").length ?? 0;
  const highCount = data?.matches.filter((m) => m.detail?.risk === "HIGH").length ?? 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Answer similarity review</h1>
        <Link href={`/lecturer/exams/${examId}`} className="text-sm underline">
          Back to exam
        </Link>
      </div>
      <p className="mt-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
        Explainable, threshold-based similarity signals between students&apos; submitted answers on this exam.
        This is a review signal, not an automatic academic misconduct decision — your lecturer or institution
        makes the final decision.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 rounded border border-gray-200 p-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs uppercase text-gray-500">Analysis status</p>
          <p className="mt-1">{data?.status ?? "Not yet run"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Submissions analysed</p>
          <p className="mt-1">{data?.summary?.submissionsAnalysed ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Requiring review</p>
          <p className="mt-1">{needsReviewCount}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">High similarity pairs</p>
          <p className="mt-1">{highCount}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Last analysed</p>
          <p className="mt-1">{data?.analysedAt ? new Date(data.analysedAt).toLocaleString() : "Never"}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Algorithm version</p>
          <p className="mt-1">{data?.algorithmVersion ?? "—"}</p>
        </div>
      </div>

      <div className="mt-4">
        <button
          onClick={runAnalysis}
          disabled={running}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {running ? "Running..." : "Run similarity analysis"}
        </button>
        {runError && <p className="mt-2 text-sm text-red-600">{runError}</p>}
        {data?.status === "FAILED" && (
          <p className="mt-2 text-sm text-amber-700">
            The last analysis run failed — your submissions were not affected. Try running it again.
          </p>
        )}
      </div>

      <h2 className="mt-8 text-lg font-medium">Flagged items</h2>
      <div className="mt-3 space-y-4">
        {(!data || data.matches.length === 0) && (
          <p className="text-gray-500">No similarity signals found yet. Run the analysis above.</p>
        )}
        {data?.matches.map((m) => {
          const risk = m.detail?.risk ?? "NONE";
          return (
            <div key={m.id} className="rounded border border-gray-200 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  Similarity review recommended
                </span>
                <span className={`rounded px-2 py-0.5 text-xs ${RISK_STYLES[risk]}`}>Risk: {risk}</span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                  {SIGNAL_LABELS[m.signalType] ?? m.signalType}
                </span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{m.reviewStatusLabel}</span>
              </div>

              {m.question && (
                <p className="mt-2 text-xs text-gray-500">Question {m.question.order + 1}: {m.question.text}</p>
              )}
              <p className="mt-1 text-gray-700">
                {m.sourceSubmission.student.name} (attempt {m.sourceSubmission.attemptNumber}) vs.{" "}
                {m.comparedSubmission.student.name} (attempt {m.comparedSubmission.attemptNumber})
              </p>

              {m.detail?.summary && <p className="mt-2 text-gray-700">{m.detail.summary}</p>}

              {m.detail?.metrics && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-gray-600">
                  <li>Text similarity: {(m.detail.metrics.cosine * 100).toFixed(0)}%</li>
                  <li>Shared phrase overlap: {(m.detail.metrics.ngramJaccard * 100).toFixed(0)}%</li>
                  <li>Same question: Yes</li>
                </ul>
              )}
              {m.detail?.sharedQuestionCount != null && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-gray-600">
                  <li>Shared multiple-choice questions: {m.detail.sharedQuestionCount}</li>
                  <li>Same incorrect choice: {m.detail.sameWrongAnswerCount}</li>
                </ul>
              )}
              {m.detail?.sharedPhraseExcerpt && (
                <p className="mt-2 rounded border border-gray-100 bg-gray-50 p-2 text-xs italic text-gray-600">
                  Matched excerpt: &quot;{m.detail.sharedPhraseExcerpt}&quot;
                </p>
              )}

              <p className="mt-2 text-xs text-amber-700">
                This is a review signal and is not an automatic academic misconduct decision.
              </p>

              <div className="mt-3">
                <input
                  type="text"
                  placeholder="Optional review note"
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                  value={reviewNoteDrafts[m.id] ?? m.reviewNote ?? ""}
                  onChange={(e) => setReviewNoteDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {REVIEW_ACTIONS.map((action) => (
                    <button
                      key={action.status}
                      onClick={() => submitReview(m.id, action.status)}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    >
                      {action.label}
                    </button>
                  ))}
                  <Link
                    href={`/lecturer/exams/${examId}/submissions/${m.sourceSubmission.id}`}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    Require oral verification
                  </Link>
                </div>
                {m.reviewedByName && (
                  <p className="mt-1 text-xs text-gray-400">
                    Reviewed by {m.reviewedByName}
                    {m.reviewedAt ? ` on ${new Date(m.reviewedAt).toLocaleString()}` : ""}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
