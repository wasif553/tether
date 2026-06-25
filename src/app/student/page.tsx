"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AvailableExam = {
  id: string;
  title: string;
  description: string | null;
  durationMins: number;
  questionCount: number;
  submission: { id: string; status: "IN_PROGRESS" | "SUBMITTED" | "GRADED" } | null;
};

export default function StudentDashboard() {
  const router = useRouter();
  const [exams, setExams] = useState<AvailableExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/exams/available")
      .then((res) => res.json())
      .then(setExams)
      .finally(() => setLoading(false));
  }, []);

  async function startExam(examId: string) {
    setStartingId(examId);
    const res = await fetch(`/api/exams/${examId}/start`, { method: "POST" });
    setStartingId(null);
    if (!res.ok) return;
    const submission = await res.json();
    router.push(`/student/exams/${submission.id}`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">My Exams</h1>

      <div className="mt-6 space-y-3">
        {loading && <p className="text-gray-500">Loading...</p>}
        {!loading && exams.length === 0 && (
          <p className="text-gray-500">No exams available right now.</p>
        )}
        {exams.map((exam) => (
          <div key={exam.id} className="rounded border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium">{exam.title}</span>
              <span className="text-sm text-gray-500">
                {exam.questionCount} questions · {exam.durationMins} min
              </span>
            </div>
            {exam.description && (
              <p className="mt-1 text-sm text-gray-600">{exam.description}</p>
            )}
            <div className="mt-3">
              {!exam.submission && (
                <button
                  onClick={() => startExam(exam.id)}
                  disabled={startingId === exam.id}
                  className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  {startingId === exam.id ? "Starting..." : "Start exam"}
                </button>
              )}
              {exam.submission?.status === "IN_PROGRESS" && (
                <a
                  href={`/student/exams/${exam.submission.id}`}
                  className="rounded bg-black px-3 py-1.5 text-sm text-white"
                >
                  Continue
                </a>
              )}
              {exam.submission?.status === "SUBMITTED" && (
                <span className="text-sm text-gray-500">Submitted, awaiting grading</span>
              )}
              {exam.submission?.status === "GRADED" && (
                <a
                  href={`/student/exams/${exam.submission.id}`}
                  className="text-sm underline"
                >
                  View result
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
