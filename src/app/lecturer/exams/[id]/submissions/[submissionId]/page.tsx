"use client";

import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

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

type SubmissionData = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  totalScore: number | null;
  exam: { title: string; questions: Question[] };
  answers: Answer[];
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

export default function GradeSubmissionPage({
  params,
}: {
  params: Promise<{ id: string; submissionId: string }>;
}) {
  const { submissionId } = usePromise(params);
  const router = useRouter();

  const [data, setData] = useState<SubmissionData | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [pushingGrade, setPushingGrade] = useState(false);
  const [pushGradeMessage, setPushGradeMessage] = useState<string | null>(null);
  const [expandedAiDraft, setExpandedAiDraft] = useState<string | null>(null);

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
  }

  function handleAcceptAiDraft(questionId: string, aiDraftScore: number) {
    setScores((prev) => ({ ...prev, [questionId]: Math.round(aiDraftScore) }));
  }

  if (!data) return <p className="text-gray-500">Loading...</p>;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
      <p className="text-sm text-gray-500">Status: {data.status}</p>

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

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={handleFinalize}
          disabled={saving}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {saving ? "Saving..." : "Finalize grade"}
        </button>
        {data.status === "GRADED" && (
          <button
            onClick={handlePushGrade}
            disabled={pushingGrade}
            className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
          >
            {pushingGrade ? "Pushing..." : "Push to Canvas"}
          </button>
        )}
      </div>
      {pushGradeMessage && <p className="mt-2 text-sm text-gray-600">{pushGradeMessage}</p>}
    </div>
  );
}
