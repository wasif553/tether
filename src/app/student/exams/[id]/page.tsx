"use client";

import { useCallback, useEffect, useRef, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

type Question = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  options: string[] | null;
  points: number;
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
  deadline: string;
  totalScore: number | null;
  exam: { id: string; title: string; questions: Question[] };
  answers: Answer[];
};

export default function TakeExamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const router = useRouter();

  const [data, setData] = useState<SubmissionData | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    fetch(`/api/submissions/${id}`)
      .then((res) => res.json())
      .then((d: SubmissionData) => {
        setData(d);
        const initial: Record<string, string> = {};
        d.answers.forEach((a) => {
          if (a.response != null) initial[a.questionId] = a.response;
        });
        setResponses(initial);
      });
  }, [id]);

  useEffect(() => {
    if (!data || data.status !== "IN_PROGRESS") return;
    const tick = () => {
      const secs = Math.max(
        0,
        Math.floor((new Date(data.deadline).getTime() - Date.now()) / 1000),
      );
      setRemainingSecs(secs);
      if (secs === 0) handleSubmit();
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const saveAnswer = useCallback(
    (questionId: string, response: string) => {
      clearTimeout(saveTimers.current[questionId]);
      saveTimers.current[questionId] = setTimeout(() => {
        fetch(`/api/submissions/${id}/answers`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, response }),
        });
      }, 600);
    },
    [id],
  );

  function handleChange(questionId: string, value: string) {
    setResponses((prev) => ({ ...prev, [questionId]: value }));
    saveAnswer(questionId, value);
  }

  async function handleSubmit() {
    setSubmitting(true);
    const res = await fetch(`/api/submissions/${id}/submit`, { method: "POST" });
    setSubmitting(false);
    if (res.ok) {
      const updated = await res.json();
      setData((prev) => (prev ? { ...prev, status: updated.status, totalScore: updated.totalScore } : prev));
      router.refresh();
    }
  }

  if (!data) return <p className="text-gray-500">Loading...</p>;

  if (data.status !== "IN_PROGRESS") {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        {data.status === "SUBMITTED" && (
          <p className="mt-4 text-gray-600">
            Submitted. Some answers require manual grading — check back later.
          </p>
        )}
        {data.status === "GRADED" && (
          <div className="mt-4">
            <p className="text-lg">
              Score: <span className="font-semibold">{data.totalScore}</span>
            </p>
            <div className="mt-4 space-y-3">
              {data.exam.questions.map((q) => {
                const answer = data.answers.find((a) => a.questionId === q.id);
                return (
                  <div key={q.id} className="rounded border border-gray-200 p-3">
                    <p className="text-sm text-gray-500">{q.points} pt(s)</p>
                    <p>{q.text}</p>
                    <p className="mt-1 text-sm text-gray-600">
                      Your answer: {answer?.response ?? "(no answer)"}
                    </p>
                    {answer?.score != null && (
                      <p className="text-sm text-green-700">Score: {answer.score}</p>
                    )}
                    {answer?.feedback && (
                      <p className="text-sm text-gray-500">Feedback: {answer.feedback}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  const minutes = remainingSecs != null ? Math.floor(remainingSecs / 60) : null;
  const seconds = remainingSecs != null ? remainingSecs % 60 : null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        {remainingSecs != null && (
          <span className="rounded bg-gray-100 px-3 py-1 font-mono text-sm">
            {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
          </span>
        )}
      </div>

      <div className="mt-6 space-y-4">
        {data.exam.questions.map((q, i) => (
          <div key={q.id} className="rounded border border-gray-200 p-4">
            <p className="text-sm text-gray-500">
              Q{i + 1} · {q.points} pt(s)
            </p>
            <p className="mt-1">{q.text}</p>

            {q.type === "MULTIPLE_CHOICE" && q.options && (
              <div className="mt-2 space-y-1">
                {q.options.map((opt) => (
                  <label key={opt} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={q.id}
                      value={opt}
                      checked={responses[q.id] === opt}
                      onChange={(e) => handleChange(q.id, e.target.value)}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            )}

            {q.type === "SHORT_ANSWER" && (
              <input
                className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                value={responses[q.id] ?? ""}
                onChange={(e) => handleChange(q.id, e.target.value)}
              />
            )}

            {q.type === "ESSAY" && (
              <textarea
                rows={5}
                className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                value={responses[q.id] ?? ""}
                onChange={(e) => handleChange(q.id, e.target.value)}
              />
            )}
          </div>
        ))}
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="mt-6 rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {submitting ? "Submitting..." : "Submit exam"}
      </button>
    </div>
  );
}
