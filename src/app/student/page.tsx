"use client";

import { useEffect, useState } from "react";

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
  const [exams, setExams] = useState<AvailableExam[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/exams/available")
      .then((res) => res.json())
      .then(setExams)
      .finally(() => setLoading(false));
  }, []);

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
              {exam.availability === "open" && exam.canStartAttempt && (
                // Exam Design Policy v1 — see docs/exam-design-policy-v1.md.
                // Routed through the join page rather than starting
                // directly from here, so every attempt (whether started
                // from the dashboard or a shared link) goes through the
                // same "Exam conditions" acknowledgement step before
                // POST /api/exams/[id]/start is ever called.
                <a
                  href={`/student/exams/join/${exam.id}`}
                  className="inline-block rounded bg-black px-3 py-1.5 text-sm text-white"
                >
                  {exam.submission ? "Start next attempt" : "Start exam"}
                </a>
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
