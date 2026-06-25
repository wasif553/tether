"use client";

import { useEffect, useState, use as usePromise } from "react";
import Link from "next/link";

type Question = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  options: string[] | null;
  correctAnswer: string | null;
  points: number;
  order: number;
};

type Exam = {
  id: string;
  title: string;
  description: string | null;
  durationMins: number;
  published: boolean;
  questions: Question[];
};

export default function LecturerExamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);

  const [exam, setExam] = useState<Exam | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [qType, setQType] = useState<Question["type"]>("MULTIPLE_CHOICE");
  const [qText, setQText] = useState("");
  const [qOptions, setQOptions] = useState("");
  const [qCorrect, setQCorrect] = useState("");
  const [qPoints, setQPoints] = useState(1);
  const [adding, setAdding] = useState(false);

  async function loadExam() {
    setLoading(true);
    const res = await fetch(`/api/exams/${id}`);
    if (res.ok) setExam(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadExam();
  }, [id]);

  async function handleAddQuestion(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);

    const res = await fetch(`/api/exams/${id}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: qType,
        text: qText,
        options:
          qType === "MULTIPLE_CHOICE"
            ? qOptions.split("\n").map((o) => o.trim()).filter(Boolean)
            : undefined,
        correctAnswer: qType === "ESSAY" ? undefined : qCorrect || undefined,
        points: qPoints,
      }),
    });

    setAdding(false);

    if (!res.ok) {
      setError("Failed to add question");
      return;
    }

    setQText("");
    setQOptions("");
    setQCorrect("");
    setQPoints(1);
    await loadExam();
  }

  async function handleDeleteQuestion(questionId: string) {
    await fetch(`/api/exams/${id}/questions/${questionId}`, { method: "DELETE" });
    await loadExam();
  }

  async function togglePublish() {
    if (!exam) return;
    const res = await fetch(`/api/exams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ published: !exam.published }),
    });
    if (res.ok) await loadExam();
  }

  if (loading) return <p className="text-gray-500">Loading...</p>;
  if (!exam) return <p className="text-red-600">Exam not found</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{exam.title}</h1>
        <div className="flex gap-2">
          <Link
            href={`/lecturer/exams/${id}/submissions`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Submissions
          </Link>
          <Link
            href={`/lecturer/exams/${id}/analytics`}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            View analytics
          </Link>
          <button
            onClick={togglePublish}
            className={
              exam.published
                ? "rounded bg-gray-200 px-3 py-1.5 text-sm"
                : "rounded bg-black px-3 py-1.5 text-sm text-white"
            }
          >
            {exam.published ? "Unpublish" : "Publish"}
          </button>
        </div>
      </div>
      <p className="text-sm text-gray-500">{exam.durationMins} minutes</p>

      <h2 className="mt-8 text-lg font-medium">Questions</h2>
      <div className="mt-3 space-y-3">
        {exam.questions.length === 0 && (
          <p className="text-gray-500">No questions yet.</p>
        )}
        {exam.questions.map((q, i) => (
          <div key={q.id} className="rounded border border-gray-200 p-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-gray-500">
                  Q{i + 1} · {q.type} · {q.points} pt(s)
                </p>
                <p className="mt-1">{q.text}</p>
                {q.options && (
                  <ul className="mt-1 list-disc pl-5 text-sm text-gray-600">
                    {q.options.map((o) => (
                      <li key={o}>{o}</li>
                    ))}
                  </ul>
                )}
                {q.correctAnswer && (
                  <p className="mt-1 text-sm text-green-700">
                    Correct: {q.correctAnswer}
                  </p>
                )}
              </div>
              <button
                onClick={() => handleDeleteQuestion(q.id)}
                className="text-sm text-red-600 underline"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-medium">Add question</h2>
      <form onSubmit={handleAddQuestion} className="mt-3 space-y-3 rounded border border-gray-200 p-4">
        <div>
          <label className="block text-sm font-medium">Type</label>
          <select
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={qType}
            onChange={(e) => setQType(e.target.value as Question["type"])}
          >
            <option value="MULTIPLE_CHOICE">Multiple choice</option>
            <option value="SHORT_ANSWER">Short answer</option>
            <option value="ESSAY">Essay</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Question text</label>
          <textarea
            required
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={qText}
            onChange={(e) => setQText(e.target.value)}
          />
        </div>
        {qType === "MULTIPLE_CHOICE" && (
          <div>
            <label className="block text-sm font-medium">Options (one per line)</label>
            <textarea
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qOptions}
              onChange={(e) => setQOptions(e.target.value)}
            />
          </div>
        )}
        {qType !== "ESSAY" && (
          <div>
            <label className="block text-sm font-medium">Correct answer</label>
            <input
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
              value={qCorrect}
              onChange={(e) => setQCorrect(e.target.value)}
            />
          </div>
        )}
        <div className="w-32">
          <label className="block text-sm font-medium">Points</label>
          <input
            type="number"
            min={1}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={qPoints}
            onChange={(e) => setQPoints(Number(e.target.value))}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={adding}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {adding ? "Adding..." : "Add question"}
        </button>
      </form>
    </div>
  );
}
