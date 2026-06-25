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
};

type SubmissionData = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  totalScore: number | null;
  exam: { title: string; questions: Question[] };
  answers: Answer[];
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

  if (!data) return <p className="text-gray-500">Loading...</p>;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
      <p className="text-sm text-gray-500">Status: {data.status}</p>

      <div className="mt-6 space-y-4">
        {data.exam.questions.map((q, i) => {
          const answer = data.answers.find((a) => a.questionId === q.id);
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
