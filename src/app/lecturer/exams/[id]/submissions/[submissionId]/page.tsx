"use client";

import { useCallback, useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Question = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  points: number;
  correctAnswer?: string | null;
};

type Answer = {
  questionId: string;
  response: string | null;
  score?: number;
  feedback?: string;
  aiDraftScore?: number | null;
  aiReasoning?: string | null;
};

type CanvasPassback = {
  status: "NOT_READY" | "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  scoreGiven: number | null;
  scoreMaximum: number | null;
  sentAt: string | null;
  attemptedAt: string | null;
  errorMessage: string | null;
};

type SubmissionData = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  attemptNumber: number;
  totalScore: number | null;
  exam: { title: string; questions: Question[] };
  answers: Answer[];
  canvasPassback: CanvasPassback | null;
};

const CANVAS_STATUS_LABELS: Record<CanvasPassback["status"], string> = {
  NOT_READY: "Not ready to send",
  PENDING: "Sending...",
  SENT: "Sent",
  FAILED: "Failed — retry",
  SKIPPED: "Not linked to Canvas",
};

type CriterionScore = {
  criterion: string;
  score: number;
  maxMarks: number;
  justification: string;
};

type EssayMarkingResult = {
  criteriaScores: CriterionScore[];
  totalScore: number;
  totalMaxMarks: number;
  overallFeedback: string;
  strengths: string[];
  areasForImprovement: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

function parseAiReasoning(raw: string | null | undefined): EssayMarkingResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EssayMarkingResult;
  } catch {
    return null;
  }
}

const CONFIDENCE_STYLES: Record<EssayMarkingResult["confidence"], string> = {
  HIGH: "bg-green-100 text-green-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW: "bg-red-100 text-red-700",
};

// Oral Verification Workflow v1 — see docs/oral-verification-workflow-v1.md.
// Lecturer-controlled: an OralVerification record is only ever created by
// the explicit "Require oral verification" action below, never
// automatically. Private lecturer notes here are never shown to students.
type OralVerification = {
  id: string;
  status: string;
  reason: string;
  scheduledAt: string | null;
  completedAt: string | null;
  outcome: string | null;
  lecturerNotes: string | null;
  generatedQuestionsJson: string[] | null;
  requestedBy: { name: string } | null;
  completedBy: { name: string } | null;
};

const ORAL_VERIFICATION_STATUS_LABELS: Record<string, string> = {
  NOT_REQUIRED: "Not required",
  REQUIRED: "Oral verification recommended",
  SCHEDULED: "Scheduled",
  COMPLETED_NO_CONCERN: "Reviewed — no concern",
  COMPLETED_CONCERN_REMAINS: "Concern remains",
  CANCELLED: "Cancelled",
};

// AI-Use Answer Review v1 — see docs/ai-use-answer-review-v1.md. THIS IS
// NOT AN AI DETECTOR: every card rendered below is an explainable review
// signal about an observable answer characteristic, never a claim that an
// answer was written by AI, never an automatic misconduct finding. The
// lecturer/institution makes the final decision — analysis never changes
// marks, blocks marks release, creates misconduct cases, requires oral
// verification, or notifies the student on its own.
type AiUseReviewSignalCard = {
  id: string;
  signalType: string;
  headline: string;
  label: string;
  signalLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  explanation: string;
  evidence: string[] | null;
  question: { id: string; order: number; text: string } | null;
  reviewStatus: string;
  reviewStatusLabel: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
};

type AiUseReviewAnalysisData = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED" | "NOT_CONFIGURED";
  overallSignalLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  provider: string;
  modelIdentifier: string | null;
  algorithmVersion: string;
  analysedAt: string | null;
  failureCode: string | null;
  recommendation: string;
  recommendationLabel: string;
  reasonCodes: string[] | null;
  summary: {
    writtenAnswersAnalysed?: number;
    deterministicSignalCount?: number;
    aiAssistedSignalCount?: number;
    aiAssisted?: { status: string; message: string | null };
    recommendationSummary?: string;
    error?: string;
  } | null;
  signals: AiUseReviewSignalCard[];
};

const AI_USE_SIGNAL_LEVEL_STYLES: Record<string, string> = {
  NONE: "bg-gray-100 text-gray-600",
  LOW: "bg-blue-100 text-blue-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
};

const AI_USE_REVIEW_ACTIONS: Array<{ status: string; label: string }> = [
  { status: "REVIEWED_NO_CONCERN", label: "Reviewed — no concern" },
  { status: "REVIEWED_CONCERN_REMAINS", label: "Concern remains" },
  { status: "ESCALATED", label: "Escalate" },
  { status: "RESOLVED", label: "Resolve" },
];

// Exam Session Binding + Time Anomaly Review v1 — see
// docs/exam-session-binding-v1.md and docs/time-anomaly-review-v1.md.
// Session/timing signals are review signals only — never automatic
// misconduct findings. Session data accumulates from the exam page's own
// heartbeats (no "run" button); timing analysis is lecturer-triggered.
type SessionSummary = {
  id: string;
  browserFamily: string | null;
  operatingSystemFamily: string | null;
  deviceCategory: string | null;
  ipVersion: string | null;
  cameraPermissionState: string;
  startedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  status: string;
};

type SessionOrTimingSignal = {
  id: string;
  signalType: string;
  headline?: string;
  signalLevel: "LOW" | "MEDIUM" | "HIGH";
  explanation: string;
  evidence: string[] | null;
  reviewStatus: string;
  reviewStatusLabel: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
};

type TimingAnalysisData = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";
  overallSignalLevel: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  analysedAt: string | null;
  recommendation: string;
  recommendationLabel: string;
  signals: SessionOrTimingSignal[];
};

const SESSION_TIMING_LEVEL_STYLES: Record<string, string> = {
  NONE: "bg-gray-100 text-gray-600",
  LOW: "bg-blue-100 text-blue-700",
  MEDIUM: "bg-yellow-100 text-yellow-700",
  HIGH: "bg-red-100 text-red-700",
};

const SESSION_TIMING_REVIEW_ACTIONS: Array<{ status: string; label: string }> = [
  { status: "REVIEWED_NO_CONCERN", label: "Reviewed — no concern" },
  { status: "REVIEWED_CONCERN_REMAINS", label: "Concern remains" },
  { status: "ESCALATED", label: "Escalate" },
  { status: "RESOLVED", label: "Resolve" },
];

export default function GradeSubmissionPage({
  params,
}: {
  params: Promise<{ id: string; submissionId: string }>;
}) {
  const { id: examId, submissionId } = usePromise(params);
  const router = useRouter();

  const [data, setData] = useState<SubmissionData | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [pushingGrade, setPushingGrade] = useState(false);
  const [pushGradeMessage, setPushGradeMessage] = useState<string | null>(null);
  const [expandedAiDraft, setExpandedAiDraft] = useState<string | null>(null);

  // Oral Verification Workflow v1 state — see
  // docs/oral-verification-workflow-v1.md.
  const [oralVerifications, setOralVerifications] = useState<OralVerification[]>([]);
  const [requestReason, setRequestReason] = useState("");
  const [requestingVerification, setRequestingVerification] = useState(false);
  const [editingQuestions, setEditingQuestions] = useState<Record<string, string[]>>({});
  const [savingVerificationId, setSavingVerificationId] = useState<string | null>(null);

  const loadOralVerifications = useCallback(() => {
    fetch(`/api/lecturer/submissions/${submissionId}/oral-verification`)
      .then((res) => (res.ok ? res.json() : []))
      .then((list: OralVerification[]) => {
        setOralVerifications(list);
        const drafts: Record<string, string[]> = {};
        list.forEach((v) => {
          drafts[v.id] = v.generatedQuestionsJson ?? [];
        });
        setEditingQuestions(drafts);
      })
      .catch(() => {});
  }, [submissionId]);

  useEffect(() => {
    loadOralVerifications();
  }, [loadOralVerifications]);

  // AI-Use Answer Review v1 state — see docs/ai-use-answer-review-v1.md.
  const [aiUseReview, setAiUseReview] = useState<AiUseReviewAnalysisData | null>(null);
  const [aiUseReviewLoading, setAiUseReviewLoading] = useState(false);
  const [aiUseReviewRunning, setAiUseReviewRunning] = useState(false);
  const [aiUseReviewRunError, setAiUseReviewRunError] = useState<string | null>(null);
  const [aiUseReviewNoteDrafts, setAiUseReviewNoteDrafts] = useState<Record<string, string>>({});

  const loadAiUseReview = useCallback(async () => {
    setAiUseReviewLoading(true);
    try {
      const res = await fetch(`/api/lecturer/submissions/${submissionId}/ai-use-review`);
      if (res.ok) {
        const body = await res.json();
        setAiUseReview(body.analysis);
      }
    } catch {
      // Non-fatal — the section shows "Not yet run" and the button remains usable.
    } finally {
      setAiUseReviewLoading(false);
    }
  }, [submissionId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAiUseReview();
  }, [loadAiUseReview]);

  async function runAiUseReview() {
    setAiUseReviewRunning(true);
    setAiUseReviewRunError(null);
    try {
      const res = await fetch(`/api/lecturer/submissions/${submissionId}/ai-use-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setAiUseReviewRunError(
          typeof body?.error === "string" ? body.error : "AI-use review failed. This submission's grade and status are unaffected.",
        );
        return;
      }
      await loadAiUseReview();
    } catch {
      setAiUseReviewRunError("Could not reach the server. This submission's grade and status are unaffected — try again.");
    } finally {
      setAiUseReviewRunning(false);
    }
  }

  async function submitAiUseReviewSignalReview(signalId: string, reviewStatus: string) {
    const reviewNote = aiUseReviewNoteDrafts[signalId];
    const res = await fetch(`/api/lecturer/ai-use-review-signals/${signalId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus, reviewNote: reviewNote || undefined }),
    });
    if (res.ok) await loadAiUseReview();
  }

  // Exam Session Binding + Time Anomaly Review v1 state — see
  // docs/exam-session-binding-v1.md and docs/time-anomaly-review-v1.md.
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionSignals, setSessionSignals] = useState<SessionOrTimingSignal[]>([]);
  const [sessionReviewLoading, setSessionReviewLoading] = useState(false);
  const [timingAnalysis, setTimingAnalysis] = useState<TimingAnalysisData | null>(null);
  const [timingRunning, setTimingRunning] = useState(false);
  const [timingRunError, setTimingRunError] = useState<string | null>(null);
  const [sessionTimingNoteDrafts, setSessionTimingNoteDrafts] = useState<Record<string, string>>({});

  const loadSessionReview = useCallback(async () => {
    setSessionReviewLoading(true);
    try {
      const res = await fetch(`/api/lecturer/submissions/${submissionId}/session-review`);
      if (res.ok) {
        const body = await res.json();
        setSessions(body.sessions ?? []);
        setSessionSignals(body.signals ?? []);
      }
    } catch {
      // Non-fatal — section shows "no data yet".
    } finally {
      setSessionReviewLoading(false);
    }
  }, [submissionId]);

  const loadTimingAnalysis = useCallback(async () => {
    try {
      const res = await fetch(`/api/lecturer/submissions/${submissionId}/timing-analysis`);
      if (res.ok) {
        const body = await res.json();
        setTimingAnalysis(body.analysis);
      }
    } catch {
      // Non-fatal.
    }
  }, [submissionId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSessionReview();
    loadTimingAnalysis();
  }, [loadSessionReview, loadTimingAnalysis]);

  async function runTimingAnalysis() {
    setTimingRunning(true);
    setTimingRunError(null);
    try {
      const res = await fetch(`/api/lecturer/submissions/${submissionId}/timing-analysis`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setTimingRunError(
          typeof body?.error === "string" ? body.error : "Timing analysis failed. This submission's grade and status are unaffected.",
        );
        return;
      }
      await Promise.all([loadTimingAnalysis(), loadSessionReview()]);
    } catch {
      setTimingRunError("Could not reach the server. This submission's grade and status are unaffected — try again.");
    } finally {
      setTimingRunning(false);
    }
  }

  async function submitSessionSignalReview(signalId: string, reviewStatus: string) {
    const reviewNote = sessionTimingNoteDrafts[signalId];
    const res = await fetch(`/api/lecturer/session-signals/${signalId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus, reviewNote: reviewNote || undefined }),
    });
    if (res.ok) await loadSessionReview();
  }

  async function submitTimingSignalReview(signalId: string, reviewStatus: string) {
    const reviewNote = sessionTimingNoteDrafts[signalId];
    const res = await fetch(`/api/lecturer/timing-signals/${signalId}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus, reviewNote: reviewNote || undefined }),
    });
    if (res.ok) await loadTimingAnalysis();
  }

  async function requireOralVerification() {
    if (!requestReason.trim()) return;
    setRequestingVerification(true);
    try {
      const res = await fetch(`/api/lecturer/submissions/${submissionId}/oral-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: requestReason.trim() }),
      });
      if (res.ok) {
        setRequestReason("");
        loadOralVerifications();
      }
    } finally {
      setRequestingVerification(false);
    }
  }

  async function updateOralVerification(
    verificationId: string,
    patch: { status?: string; outcome?: string; lecturerNotes?: string; questions?: string[] },
  ) {
    setSavingVerificationId(verificationId);
    try {
      const res = await fetch(`/api/lecturer/oral-verifications/${verificationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) loadOralVerifications();
    } finally {
      setSavingVerificationId(null);
    }
  }

  useEffect(() => {
    fetch(`/api/submissions/${submissionId}`)
      .then((res) => res.json())
      .then((d: SubmissionData) => {
        setData(d);
        const initialScores: Record<string, number> = {};
        const initialFeedback: Record<string, string> = {};
        d.answers.forEach((a) => {
          initialScores[a.questionId] = a.score ?? 0;
          initialFeedback[a.questionId] = a.feedback ?? "";
        });
        setScores(initialScores);
        setFeedback(initialFeedback);
      });
  }, [submissionId]);

  async function handleFinalize() {
    if (!data) return;
    setSaving(true);

    await fetch(`/api/submissions/${submissionId}/grade`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        finalize: true,
        answers: data.exam.questions.map((q) => ({
          questionId: q.id,
          score: scores[q.id] ?? 0,
          feedback: feedback[q.id] || undefined,
        })),
      }),
    });

    setSaving(false);
    router.push(`/lecturer/exams`);
  }

  async function handlePushGrade() {
    setPushingGrade(true);
    setPushGradeMessage(null);

    const res = await fetch(`/api/lecturer/submissions/${submissionId}/push-grade`, {
      method: "POST",
    });
    const result = await res.json();

    setPushingGrade(false);
    setPushGradeMessage(result.message ?? (result.success ? "Done." : "Failed to push grade."));
    if (result.status) {
      setData((prev) => (prev ? { ...prev, canvasPassback: result.status } : prev));
    }
  }

  function handleAcceptAiDraft(questionId: string, aiDraftScore: number) {
    setScores((prev) => ({ ...prev, [questionId]: Math.round(aiDraftScore) }));
  }

  if (!data) return <p className="text-gray-500">Loading...</p>;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        <Link
          href={`/lecturer/submissions/${submissionId}/evidence`}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm"
        >
          Evidence report
        </Link>
      </div>
      <p className="text-sm text-gray-500">
        Status: {data.status} · Attempt {data.attemptNumber}
      </p>

      <div className="mt-6 space-y-4">
        {data.exam.questions.map((q, i) => {
          const answer = data.answers.find((a) => a.questionId === q.id);
          const aiResult = parseAiReasoning(answer?.aiReasoning);
          const hasAiDraft = q.type === "ESSAY" && answer?.aiDraftScore != null;

          return (
            <div key={q.id} className="rounded border border-gray-200 p-4">
              <p className="text-sm text-gray-500">
                Q{i + 1} · {q.points} pt(s) · {q.type}
              </p>
              <p className="mt-1">{q.text}</p>
              {q.correctAnswer && (
                <p className="mt-1 text-sm text-green-700">
                  Correct answer: {q.correctAnswer}
                </p>
              )}
              <p className="mt-2 rounded bg-gray-50 p-2 text-sm">
                {answer?.response || "(no answer)"}
              </p>

              {hasAiDraft && (
                <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      AI draft: {answer?.aiDraftScore} / {q.points}
                    </p>
                    {aiResult && (
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${CONFIDENCE_STYLES[aiResult.confidence]}`}
                      >
                        {aiResult.confidence}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => handleAcceptAiDraft(q.id, answer!.aiDraftScore!)}
                      className="rounded bg-black px-3 py-1 text-xs text-white"
                    >
                      Accept AI draft
                    </button>
                    <button
                      onClick={() => setExpandedAiDraft(expandedAiDraft === q.id ? null : q.id)}
                      className="rounded border border-gray-300 px-3 py-1 text-xs"
                    >
                      {expandedAiDraft === q.id ? "Hide details" : "Show details"}
                    </button>
                  </div>

                  {expandedAiDraft === q.id && aiResult && (
                    <div className="mt-3 space-y-3 border-t border-blue-200 pt-3 text-sm">
                      <div>
                        <p className="font-medium">Per-criterion breakdown</p>
                        <ul className="mt-1 space-y-1">
                          {aiResult.criteriaScores.map((c) => (
                            <li key={c.criterion} className="text-gray-700">
                              <span className="font-medium">
                                {c.criterion}: {c.score} / {c.maxMarks}
                              </span>
                              <p className="text-xs text-gray-500">{c.justification}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                      {aiResult.strengths.length > 0 && (
                        <div>
                          <p className="font-medium">Strengths</p>
                          <ul className="mt-1 list-disc pl-5 text-gray-700">
                            {aiResult.strengths.map((s, idx) => (
                              <li key={idx}>{s}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {aiResult.areasForImprovement.length > 0 && (
                        <div>
                          <p className="font-medium">Areas for improvement</p>
                          <ul className="mt-1 list-disc pl-5 text-gray-700">
                            {aiResult.areasForImprovement.map((s, idx) => (
                              <li key={idx}>{s}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div>
                        <p className="font-medium">Overall feedback</p>
                        <p className="text-gray-700">{aiResult.overallFeedback}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-2 flex items-center gap-3">
                <label className="text-sm">Score</label>
                <input
                  type="number"
                  min={0}
                  max={q.points}
                  className="w-20 rounded border border-gray-300 px-2 py-1"
                  value={scores[q.id] ?? 0}
                  onChange={(e) =>
                    setScores({ ...scores, [q.id]: Number(e.target.value) })
                  }
                />
                <span className="text-sm text-gray-500">/ {q.points}</span>
              </div>
              <input
                placeholder="Feedback (optional)"
                className="mt-2 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                value={feedback[q.id] ?? ""}
                onChange={(e) => setFeedback({ ...feedback, [q.id]: e.target.value })}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <button
          onClick={handleFinalize}
          disabled={saving}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {saving ? "Saving..." : "Finalize grade"}
        </button>
      </div>

      {data.status === "GRADED" && (
        <div className="mt-4 rounded border border-gray-200 p-4">
          <p className="text-sm font-medium">
            Canvas passback:{" "}
            {data.canvasPassback ? CANVAS_STATUS_LABELS[data.canvasPassback.status] : "Not checked yet"}
          </p>
          {data.canvasPassback?.scoreGiven != null && (
            <p className="mt-1 text-sm text-gray-600">
              Score sent: {data.canvasPassback.scoreGiven} / {data.canvasPassback.scoreMaximum}
            </p>
          )}
          {data.canvasPassback?.sentAt && (
            <p className="text-sm text-gray-500">
              Sent at: {new Date(data.canvasPassback.sentAt).toLocaleString()}
            </p>
          )}
          {data.canvasPassback?.attemptedAt && (
            <p className="text-sm text-gray-500">
              Last attempted: {new Date(data.canvasPassback.attemptedAt).toLocaleString()}
            </p>
          )}
          {data.canvasPassback?.status === "FAILED" && data.canvasPassback.errorMessage && (
            <p className="mt-1 text-sm text-red-600">{data.canvasPassback.errorMessage}</p>
          )}
          {data.canvasPassback?.status !== "SKIPPED" && (
            <button
              onClick={handlePushGrade}
              disabled={pushingGrade}
              className="mt-3 rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
            >
              {pushingGrade
                ? "Sending..."
                : data.canvasPassback?.status === "SENT"
                  ? "Resend grade to Canvas"
                  : data.canvasPassback?.status === "FAILED"
                    ? "Retry Canvas passback"
                    : "Send grade to Canvas"}
            </button>
          )}
          {pushGradeMessage && <p className="mt-2 text-sm text-gray-600">{pushGradeMessage}</p>}
        </div>
      )}

      {/* AI-Use Answer Review v1 — see docs/ai-use-answer-review-v1.md.
          THIS IS NOT AN AI DETECTOR. Every card here is an explainable
          review signal about an observable answer characteristic — never
          a claim that the answer was written by AI, never an automatic
          misconduct finding. Analysis never changes marks, blocks marks
          release, creates misconduct cases, or notifies the student. */}
      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="text-lg font-medium">AI-use answer review</h2>
        <p className="mt-1 text-xs text-gray-500">
          Review answer characteristics that may warrant closer academic review. These signals do not determine
          whether AI was used — your lecturer or institution makes the final decision.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-3 rounded border border-gray-100 bg-gray-50 p-3 text-xs sm:grid-cols-3">
          <div>
            <p className="uppercase text-gray-500">Analysis status</p>
            <p className="mt-1 text-gray-800">{aiUseReviewLoading ? "Loading..." : (aiUseReview?.status ?? "Not yet run")}</p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Deterministic checks</p>
            <p className="mt-1 text-gray-800">
              {aiUseReview ? `${aiUseReview.summary?.deterministicSignalCount ?? 0} signal(s)` : "—"}
            </p>
          </div>
          <div>
            <p className="uppercase text-gray-500">AI-assisted checks</p>
            <p className="mt-1 text-gray-800">
              {aiUseReview?.summary?.aiAssisted?.status === "NOT_CONFIGURED"
                ? "AI-assisted review is not configured."
                : aiUseReview?.summary?.aiAssisted?.status === "FAILED"
                  ? "Failed — deterministic results preserved. You may retry."
                  : aiUseReview?.summary?.aiAssisted?.status === "COMPLETE"
                    ? `${aiUseReview.summary?.aiAssistedSignalCount ?? 0} signal(s)`
                    : "—"}
            </p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Overall signal level</p>
            <p className="mt-1 text-gray-800">{aiUseReview?.overallSignalLevel ?? "—"}</p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Last analysed</p>
            <p className="mt-1 text-gray-800">
              {aiUseReview?.analysedAt ? new Date(aiUseReview.analysedAt).toLocaleString() : "Never"}
            </p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Recommended action</p>
            <p className="mt-1 text-gray-800">{aiUseReview?.recommendationLabel ?? "—"}</p>
          </div>
        </div>

        <div className="mt-3 rounded border border-gray-100 bg-gray-50 p-3 text-xs text-gray-600">
          <p className="font-medium text-gray-700">Related evidence categories</p>
          <p className="mt-1">
            Answer similarity:{" "}
            <Link href={`/lecturer/exams/${examId}/similarity`} className="underline">
              View similarity review
            </Link>
          </p>
          <p className="mt-1">Oral verification: see the section below.</p>
        </div>

        <div className="mt-3">
          <button
            onClick={runAiUseReview}
            disabled={aiUseReviewRunning}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {aiUseReviewRunning ? "Running..." : "Run AI-use review"}
          </button>
          {aiUseReviewRunError && <p className="mt-2 text-sm text-red-600">{aiUseReviewRunError}</p>}
          {aiUseReview?.status === "FAILED" && (
            <p className="mt-2 text-sm text-amber-700">
              The last analysis run failed — this submission&apos;s grade and status are unaffected. Try running it again.
            </p>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {(!aiUseReview || aiUseReview.signals.length === 0) && (
            <p className="text-xs text-gray-500">No AI-use review signals found yet. Run the analysis above.</p>
          )}
          {aiUseReview?.signals.map((s) => (
            <div key={s.id} className="rounded border border-gray-100 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{s.headline}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${AI_USE_SIGNAL_LEVEL_STYLES[s.signalLevel]}`}>
                  {s.signalLevel}
                </span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{s.label}</span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{s.reviewStatusLabel}</span>
              </div>

              {s.question && (
                <p className="mt-2 text-xs text-gray-500">
                  Question {s.question.order + 1}: {s.question.text}
                </p>
              )}
              <p className="mt-2 text-gray-700">{s.explanation}</p>

              {s.evidence && s.evidence.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-gray-600">Evidence</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-gray-600">
                    {s.evidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="mt-2 text-xs text-amber-700">
                This is a review signal and is not an automatic academic misconduct decision.
              </p>

              <div className="mt-3">
                <input
                  type="text"
                  placeholder="Optional review note"
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                  value={aiUseReviewNoteDrafts[s.id] ?? s.reviewNote ?? ""}
                  onChange={(e) => setAiUseReviewNoteDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {AI_USE_REVIEW_ACTIONS.map((action) => (
                    <button
                      key={action.status}
                      onClick={() => submitAiUseReviewSignalReview(s.id, action.status)}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                {s.reviewedByName && (
                  <p className="mt-1 text-xs text-gray-400">
                    Reviewed by {s.reviewedByName}
                    {s.reviewedAt ? ` on ${new Date(s.reviewedAt).toLocaleString()}` : ""}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Exam Session Binding + Time Anomaly Review v1 — see
          docs/exam-session-binding-v1.md and docs/time-anomaly-review-v1.md.
          Session data accumulates from the exam page's own periodic
          heartbeats — there is no "run" button for it. Timing analysis
          (including the cross-submission timing-similarity comparison
          and the combined recommendation) is lecturer-triggered below.
          Every card here is a REVIEW SIGNAL only. */}
      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="text-lg font-medium">Session and timing review</h2>
        <p className="mt-1 text-xs text-gray-500">
          Review device/session continuity and answer-timing characteristics that may warrant closer academic
          review. These signals do not determine misconduct — your lecturer or institution makes the final decision.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-3 rounded border border-gray-100 bg-gray-50 p-3 text-xs sm:grid-cols-3">
          <div>
            <p className="uppercase text-gray-500">Active sessions observed</p>
            <p className="mt-1 text-gray-800">{sessionReviewLoading ? "Loading..." : sessions.length}</p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Device/browser changes</p>
            <p className="mt-1 text-gray-800">
              {sessionSignals.filter((s) => s.signalType === "DEVICE_TOKEN_CHANGED" || s.signalType === "COARSE_DEVICE_PROFILE_CHANGED" || s.signalType === "USER_AGENT_CHANGED").length}
            </p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Network changes</p>
            <p className="mt-1 text-gray-800">
              {sessionSignals.filter((s) => s.signalType === "NETWORK_PREFIX_CHANGED" || s.signalType === "REPEATED_NETWORK_CHANGES").length}
            </p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Timing signals</p>
            <p className="mt-1 text-gray-800">{timingAnalysis?.signals.filter((s) => s.signalType !== "INSUFFICIENT_TIMING_DATA").length ?? "—"}</p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Overall recommendation</p>
            <p className="mt-1 text-gray-800">{timingAnalysis?.recommendationLabel ?? "—"}</p>
          </div>
          <div>
            <p className="uppercase text-gray-500">Last analysed</p>
            <p className="mt-1 text-gray-800">{timingAnalysis?.analysedAt ? new Date(timingAnalysis.analysedAt).toLocaleString() : "Never"}</p>
          </div>
        </div>

        <div className="mt-3">
          <button
            onClick={runTimingAnalysis}
            disabled={timingRunning}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {timingRunning ? "Running..." : "Run timing analysis"}
          </button>
          {timingRunError && <p className="mt-2 text-sm text-red-600">{timingRunError}</p>}
          {timingAnalysis?.status === "FAILED" && (
            <p className="mt-2 text-sm text-amber-700">
              The last timing analysis run failed — this submission&apos;s grade and status are unaffected. Try again.
            </p>
          )}
        </div>

        <h3 className="mt-5 text-sm font-medium">Session signals</h3>
        <div className="mt-2 space-y-3">
          {sessionSignals.length === 0 && <p className="text-xs text-gray-500">No session-binding signals recorded yet.</p>}
          {sessionSignals.map((s) => (
            <div key={s.id} className="rounded border border-gray-100 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{s.headline ?? "Session review recommended"}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${SESSION_TIMING_LEVEL_STYLES[s.signalLevel]}`}>{s.signalLevel}</span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{s.reviewStatusLabel}</span>
              </div>
              <p className="mt-2 text-gray-700">{s.explanation}</p>
              {s.evidence && s.evidence.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-gray-600">
                  {s.evidence.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-amber-700">This is a review signal and is not an automatic academic misconduct decision.</p>
              <div className="mt-3">
                <input
                  type="text"
                  placeholder="Optional review note"
                  className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                  value={sessionTimingNoteDrafts[s.id] ?? s.reviewNote ?? ""}
                  onChange={(e) => setSessionTimingNoteDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {SESSION_TIMING_REVIEW_ACTIONS.map((action) => (
                    <button
                      key={action.status}
                      onClick={() => submitSessionSignalReview(s.id, action.status)}
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                {s.reviewedByName && (
                  <p className="mt-1 text-xs text-gray-400">
                    Reviewed by {s.reviewedByName}
                    {s.reviewedAt ? ` on ${new Date(s.reviewedAt).toLocaleString()}` : ""}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        <h3 className="mt-5 text-sm font-medium">Timing signals</h3>
        <div className="mt-2 space-y-3">
          {(!timingAnalysis || timingAnalysis.signals.filter((s) => s.signalType !== "INSUFFICIENT_TIMING_DATA").length === 0) && (
            <p className="text-xs text-gray-500">No timing signals found yet. Run the analysis above.</p>
          )}
          {timingAnalysis?.signals
            .filter((s) => s.signalType !== "INSUFFICIENT_TIMING_DATA")
            .map((s) => (
              <div key={s.id} className="rounded border border-gray-100 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">Timing review recommended</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${SESSION_TIMING_LEVEL_STYLES[s.signalLevel]}`}>{s.signalLevel}</span>
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{s.reviewStatusLabel}</span>
                </div>
                <p className="mt-2 text-gray-700">{s.explanation}</p>
                {s.evidence && s.evidence.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-gray-600">
                    {s.evidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-amber-700">This is a review signal and is not an automatic academic misconduct decision.</p>
                <div className="mt-3">
                  <input
                    type="text"
                    placeholder="Optional review note"
                    className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                    value={sessionTimingNoteDrafts[s.id] ?? s.reviewNote ?? ""}
                    onChange={(e) => setSessionTimingNoteDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    {SESSION_TIMING_REVIEW_ACTIONS.map((action) => (
                      <button
                        key={action.status}
                        onClick={() => submitTimingSignalReview(s.id, action.status)}
                        className="rounded border border-gray-300 px-2 py-1 text-xs"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                  {s.reviewedByName && (
                    <p className="mt-1 text-xs text-gray-400">
                      Reviewed by {s.reviewedByName}
                      {s.reviewedAt ? ` on ${new Date(s.reviewedAt).toLocaleString()}` : ""}
                    </p>
                  )}
                </div>
              </div>
            ))}
        </div>

        <p className="mt-4 text-xs text-gray-500">
          Requiring oral verification for a session or timing concern uses the same Oral verification section below —
          this feature never creates an oral-verification request automatically.
        </p>
      </div>

      {/* Oral Verification Workflow v1 — see
          docs/oral-verification-workflow-v1.md. Lecturer-controlled only:
          an OralVerification record is created ONLY when the lecturer
          clicks "Require oral verification" below — never automatically.
          Internal risk scores/comparison details are never shown here to
          students, and lecturerNotes are private to staff. */}
      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="text-lg font-medium">Oral verification</h2>
        <p className="mt-1 text-xs text-gray-500">
          A lecturer-controlled follow-up discussion, if you want one for this attempt. This is a review
          workflow, not an accusation — the student sees only a neutral notice, never an internal risk
          score or comparison detail.
        </p>

        {oralVerifications.map((v) => (
          <div key={v.id} className="mt-3 rounded border border-gray-100 bg-gray-50 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                {ORAL_VERIFICATION_STATUS_LABELS[v.status] ?? v.status}
              </span>
              {v.requestedBy && <span className="text-xs text-gray-500">Requested by {v.requestedBy.name}</span>}
            </div>
            <p className="mt-2 text-gray-700">Reason: {v.reason}</p>

            {(v.generatedQuestionsJson ?? []).length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-gray-600">Follow-up questions (editable):</p>
                <div className="mt-1 space-y-1">
                  {(editingQuestions[v.id] ?? []).map((q, i) => (
                    <input
                      key={i}
                      value={q}
                      onChange={(e) => {
                        const next = [...(editingQuestions[v.id] ?? [])];
                        next[i] = e.target.value;
                        setEditingQuestions((prev) => ({ ...prev, [v.id]: next }));
                      }}
                      className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                    />
                  ))}
                </div>
                <button
                  onClick={() => updateOralVerification(v.id, { questions: editingQuestions[v.id] })}
                  disabled={savingVerificationId === v.id}
                  className="mt-1 rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
                >
                  Save question edits
                </button>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {v.status !== "SCHEDULED" && v.status !== "CANCELLED" && !v.completedAt && (
                <button
                  onClick={() => updateOralVerification(v.id, { status: "SCHEDULED" })}
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
                >
                  Mark scheduled
                </button>
              )}
              {!v.completedAt && v.status !== "CANCELLED" && (
                <>
                  <button
                    onClick={() => updateOralVerification(v.id, { status: "COMPLETED_NO_CONCERN" })}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    Complete — no concern
                  </button>
                  <button
                    onClick={() => updateOralVerification(v.id, { status: "COMPLETED_CONCERN_REMAINS" })}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    Complete — concern remains
                  </button>
                  <button
                    onClick={() => updateOralVerification(v.id, { status: "CANCELLED" })}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
            {v.completedAt && (
              <p className="mt-2 text-xs text-gray-500">
                Completed {new Date(v.completedAt).toLocaleString()}
                {v.completedBy ? ` by ${v.completedBy.name}` : ""}
              </p>
            )}
          </div>
        ))}

        <div className="mt-3 border-t border-gray-200 pt-3">
          <label className="block text-xs font-medium text-gray-600">Require oral verification — reason</label>
          <textarea
            rows={2}
            className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
            value={requestReason}
            onChange={(e) => setRequestReason(e.target.value)}
            placeholder="Why is a follow-up discussion recommended for this attempt?"
          />
          <button
            onClick={requireOralVerification}
            disabled={requestingVerification || !requestReason.trim()}
            className="mt-2 rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {requestingVerification ? "Requesting..." : "Require oral verification"}
          </button>
        </div>
      </div>
    </div>
  );
}
