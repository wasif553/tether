"use client";

import { useEffect, useState } from "react";
import { isRunningInLockdownBrowser } from "@/lib/lockdownDetection";
import { logClientTetherDiagnostic } from "@/lib/tetherDiagnosticLog";
import { buildTetherLaunchPagePath } from "@/lib/secureClientStartGate";

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
  // Corrective pass v1.2.2, Tasks 1/2/5 — physical testing traced the
  // real defect to routing, not enforcement: outside Tether the dashboard
  // correctly routes through the join page (fresh attempt) or the plain
  // submission link (continue), and each of those already funnels
  // TETHER_CLIENT_REQUIRED exams to /tether-launch via the server-computed
  // secureClientLaunch gate. But INSIDE Tether, sending a student straight
  // to the join page or the raw submission link left an unnecessary extra
  // hop with its own (subtly different) launch-sequencing logic. Routing
  // every exam entry inside Tether through the exact same
  // /tether-launch page used by protocol launches — which already
  // handles both "fresh start" and "resume existing IN_PROGRESS"
  // uniformly (see tether-launch/page.tsx's InsideTetherLaunchFlow) —
  // is what makes "protocol launch and direct dashboard launch converge
  // on the same verified server-side workflow" (Task 2) literally true:
  // one page, one code path, regardless of entry point.
  const [inTether, setInTether] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInTether(isRunningInLockdownBrowser());
  }, []);

  useEffect(() => {
    fetch("/api/exams/available")
      .then((res) => res.json())
      .then(setExams)
      .finally(() => setLoading(false));
  }, []);

  function examEntryHref(examId: string): string {
    return inTether ? buildTetherLaunchPagePath(examId) : `/student/exams/join/${examId}`;
  }

  function continueEntryHref(examId: string, submissionId: string): string {
    return inTether ? buildTetherLaunchPagePath(examId) : `/student/exams/${submissionId}`;
  }

  function logExamSelected(examId: string, mode: "start" | "continue") {
    logClientTetherDiagnostic("dashboard_examination_selected", { examId, mode, tetherDetected: inTether });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My Exams</h1>
        {/* Tether System Check and Exam Readiness v1 — see
            docs/tether-system-check-v1.md. */}
        <a href="/student/system-check" className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800">
          Check this computer
        </a>
      </div>

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
                  href={examEntryHref(exam.id)}
                  onClick={() => logExamSelected(exam.id, "start")}
                  className="inline-block rounded bg-black px-3 py-1.5 text-sm text-white"
                >
                  {exam.submission ? "Start next attempt" : "Start exam"}
                </a>
              )}
              {exam.submission?.status === "IN_PROGRESS" && (
                <a
                  href={continueEntryHref(exam.id, exam.submission.id)}
                  onClick={() => logExamSelected(exam.id, "continue")}
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
