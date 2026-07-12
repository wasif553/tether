"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type AvailableExam = {
  id: string;
  title: string;
  description: string | null;
  durationMins: number;
  questionCount: number;
  accessCodeRequired: boolean;
  availableFrom: string | null;
  availableUntil: string | null;
  course: { id: string; name: string; code: string } | null;
  availability: "open" | "upcoming" | "closed";
  maxAttempts: number;
  remainingAttempts: number;
  canStartAttempt: boolean;
  submission: {
    id: string;
    status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
    attemptNumber: number;
  } | null;
};

export default function StudentDashboard() {
  const router = useRouter();
  const [exams, setExams] = useState<AvailableExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [accessCodeInputs, setAccessCodeInputs] = useState<Record<string, string>>({});
  const [startErrors, setStartErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/exams/available")
      .then((res) => res.json())
      .then(setExams)
      .finally(() => setLoading(false));
  }, []);

  async function startExam(examId: string, accessCode?: string) {
    setStartingId(examId);
    setStartErrors((prev) => ({ ...prev, [examId]: "" }));
    const res = await fetch(`/api/exams/${examId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(accessCode ? { accessCode } : {}),
    });
    setStartingId(null);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setStartErrors((prev) => ({
        ...prev,
        [examId]: typeof body?.error === "string" ? body.error : "Failed to start exam.",
      }));
      return;
    }
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
            {exam.course && (
              <p className="mt-1 text-xs text-gray-500">
                {exam.course.code} · {exam.course.name}
              </p>
            )}
            {exam.description && (
              <p className="mt-1 text-sm text-gray-600">{exam.description}</p>
            )}
            {exam.submission && (
              <p className="mt-1 text-xs text-gray-500">
                Attempt {exam.submission.attemptNumber} of {exam.maxAttempts}
              </p>
            )}
            {exam.accessCodeRequired && exam.canStartAttempt && (
              <span className="mt-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                Access code required
              </span>
            )}
            {exam.availability === "upcoming" && exam.availableFrom && (
              <p className="mt-2 text-sm text-blue-700">
                Opens at {new Date(exam.availableFrom).toLocaleString()}
              </p>
            )}
            <div className="mt-3">
              {exam.availability === "upcoming" && exam.canStartAttempt && (
                <span className="text-sm text-gray-500">Not yet open</span>
              )}
              {exam.availability === "open" && exam.canStartAttempt && exam.accessCodeRequired && (
                <div className="flex items-end gap-2">
                  <input
                    type="text"
                    placeholder="Enter access code"
                    className="rounded border border-gray-300 px-3 py-1.5 text-sm"
                    value={accessCodeInputs[exam.id] ?? ""}
                    onChange={(e) =>
                      setAccessCodeInputs((prev) => ({ ...prev, [exam.id]: e.target.value }))
                    }
                  />
                  <button
                    onClick={() => startExam(exam.id, accessCodeInputs[exam.id] ?? "")}
                    disabled={startingId === exam.id || !(accessCodeInputs[exam.id] ?? "").trim()}
                    className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    {startingId === exam.id
                      ? "Starting..."
                      : exam.submission
                        ? "Start next attempt"
                        : "Start exam"}
                  </button>
                </div>
              )}
              {exam.availability === "open" && exam.canStartAttempt && !exam.accessCodeRequired && (
                <button
                  onClick={() => startExam(exam.id)}
                  disabled={startingId === exam.id}
                  className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  {startingId === exam.id
                    ? "Starting..."
                    : exam.submission
                      ? "Start next attempt"
                      : "Start exam"}
                </button>
              )}
              {startErrors[exam.id] && (
                <p className="mt-1 text-sm text-red-600">{startErrors[exam.id]}</p>
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
                <div className="space-y-1 text-sm text-gray-500">
                  <p>Submitted, awaiting grading</p>
                  {exam.remainingAttempts > 0 && (
                    <p>You have {exam.remainingAttempts} attempt(s) remaining.</p>
                  )}
                </div>
              )}
              {exam.submission?.status === "GRADED" && (
                <div className="space-y-1 text-sm">
                  <a
                    href={`/student/exams/${exam.submission.id}`}
                    className="underline"
                  >
                    View submission
                  </a>
                  {exam.remainingAttempts > 0 && (
                    <p className="text-gray-500">
                      You have {exam.remainingAttempts} attempt(s) remaining.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
