"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ExamSummary = {
  id: string;
  title: string;
  published: boolean;
  durationMins: number;
  _count: { questions: number; submissions: number };
};

export default function LecturerDashboard() {
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [durationMins, setDurationMins] = useState(60);
  const [error, setError] = useState<string | null>(null);

  async function loadExams() {
    setLoading(true);
    const res = await fetch("/api/exams");
    if (res.ok) setExams(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadExams();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);

    const res = await fetch("/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, durationMins }),
    });

    setCreating(false);

    if (!res.ok) {
      setError("Failed to create exam");
      return;
    }

    setTitle("");
    setDurationMins(60);
    await loadExams();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Lecturer Dashboard</h1>

      <form onSubmit={handleCreate} className="mt-6 flex items-end gap-3 rounded border border-gray-200 p-4">
        <div className="flex-1">
          <label className="block text-sm font-medium">Exam title</label>
          <input
            required
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="w-32">
          <label className="block text-sm font-medium">Duration (min)</label>
          <input
            required
            type="number"
            min={1}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2"
            value={durationMins}
            onChange={(e) => setDurationMins(Number(e.target.value))}
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {creating ? "Creating..." : "New exam"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-3">
        {loading && <p className="text-gray-500">Loading exams...</p>}
        {!loading && exams.length === 0 && (
          <p className="text-gray-500">No exams yet. Create one above.</p>
        )}
        {exams.map((exam) => (
          <Link
            key={exam.id}
            href={`/lecturer/exams/${exam.id}`}
            className="block rounded border border-gray-200 p-4 hover:border-gray-400"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{exam.title}</span>
              <span
                className={
                  exam.published
                    ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                    : "rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                }
              >
                {exam.published ? "Published" : "Draft"}
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              {exam._count.questions} questions · {exam.durationMins} min ·{" "}
              {exam._count.submissions} submissions
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
