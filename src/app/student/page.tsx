"use client";

import { useEffect, useMemo, useState } from "react";
import { isRunningInLockdownBrowser } from "@/lib/lockdownDetection";
import { logClientTetherDiagnostic } from "@/lib/tetherDiagnosticLog";
import { buildTetherLaunchPagePath } from "@/lib/secureClientStartGate";
import { studentDashboardGroup, type StudentDashboardGroup } from "@/lib/studentDashboardGrouping";

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
    submittedAt: string | null;
  } | null;
};

// Pilot UI release readiness v1 — see
// docs/tether-v1.7.2-pilot-release-readiness.md. Grouping is derived
// entirely from fields the API already returns, via the shared
// studentDashboardGroup (src/lib/studentDashboardGrouping.ts) — the SAME
// function src/app/api/exams/available/route.ts uses for server-side
// history capping, so an exam can never be shown as actionable here when
// its own card wouldn't actually offer a start/continue button. The
// "completed" group it returns is split further below, by recency only,
// into the small headline slice and the collapsed history tail.
const RECENTLY_COMPLETED_LIMIT = 5;

function completedTimeMs(exam: AvailableExam): number {
  return exam.submission?.submittedAt ? new Date(exam.submission.submittedAt).getTime() : 0;
}

function upcomingTimeMs(exam: AvailableExam): number {
  return exam.availableFrom ? new Date(exam.availableFrom).getTime() : Number.MAX_SAFE_INTEGER;
}

export default function StudentDashboard() {
  const [exams, setExams] = useState<AvailableExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
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

  function loadFullHistory() {
    setLoadingHistory(true);
    fetch("/api/exams/available?all=true")
      .then((res) => res.json())
      .then((all) => {
        setExams(all);
        setShowAllHistory(true);
      })
      .finally(() => setLoadingHistory(false));
  }

  function examEntryHref(examId: string): string {
    return inTether ? buildTetherLaunchPagePath(examId) : `/student/exams/join/${examId}`;
  }

  function continueEntryHref(examId: string, submissionId: string): string {
    return inTether ? buildTetherLaunchPagePath(examId) : `/student/exams/${submissionId}`;
  }

  function logExamSelected(examId: string, mode: "start" | "continue") {
    logClientTetherDiagnostic("dashboard_examination_selected", { examId, mode, tetherDetected: inTether });
  }

  const { actionRequired, availableNow, upcoming, recentlyCompleted, history } = useMemo(() => {
    const grouped: Record<StudentDashboardGroup, AvailableExam[]> = {
      actionRequired: [],
      availableNow: [],
      upcoming: [],
      completed: [],
    };
    for (const exam of exams) grouped[studentDashboardGroup(exam)].push(exam);

    grouped.upcoming.sort((a, b) => upcomingTimeMs(a) - upcomingTimeMs(b));
    grouped.completed.sort((a, b) => completedTimeMs(b) - completedTimeMs(a));

    // "completed" holds every completed/closed exam — split it here into
    // the small headline slice and the collapsed history tail, purely a
    // display-layer split (no separate fetch needed unless the student
    // asks to see beyond what's already loaded).
    const completedAll = grouped.completed;
    const recentSlice = completedAll.slice(0, RECENTLY_COMPLETED_LIMIT);
    const historySlice = completedAll.slice(RECENTLY_COMPLETED_LIMIT);

    return {
      actionRequired: grouped.actionRequired,
      availableNow: grouped.availableNow,
      upcoming: grouped.upcoming,
      recentlyCompleted: recentSlice,
      history: historySlice,
    };
  }, [exams]);

  function completedStatusLine(exam: AvailableExam): string {
    const label = exam.submission?.status === "GRADED" ? "Graded" : exam.submission?.status === "SUBMITTED" ? "Submitted" : "Closed";
    const when = exam.submission?.submittedAt ? new Date(exam.submission.submittedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
    return when ? `${label} · ${when}` : label;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My Exams</h1>
        {/* Tether System Check and Exam Readiness v1 — see
            docs/tether-system-check-v1.md. Registered Tether Devices and
            Revocation UI v1 adds the second link alongside it — kept to
            these two small links so the dashboard itself stays
            uncrowded. */}
        <div className="flex items-center gap-2">
          <a href="/student/system-check" className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800">
            Check this computer
          </a>
          <a href="/student/tether-devices" className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800">
            Registered computers
          </a>
        </div>
      </div>

      {loading && <p className="mt-6 text-gray-500">Loading...</p>}
      {!loading && exams.length === 0 && <p className="mt-6 text-gray-500">No exams available right now.</p>}

      {!loading && exams.length > 0 && (
        <div className="mt-6 space-y-8">
          {actionRequired.length > 0 && (
            <ExamSection title="Action required" exams={actionRequired}>
              {(exam) => (
                <ExamCard exam={exam} emphasize>
                  <a
                    href={continueEntryHref(exam.id, exam.submission!.id)}
                    onClick={() => logExamSelected(exam.id, "continue")}
                    className="inline-block rounded bg-black px-3 py-1.5 text-sm text-white"
                  >
                    Continue
                  </a>
                </ExamCard>
              )}
            </ExamSection>
          )}

          {availableNow.length > 0 && (
            <ExamSection title="Available now" exams={availableNow}>
              {(exam) => (
                <ExamCard exam={exam} emphasize>
                  {/* Exam Design Policy v1 — see docs/exam-design-policy-v1.md.
                      Routed through the join page rather than starting
                      directly from here, so every attempt (whether started
                      from the dashboard or a shared link) goes through the
                      same "Exam conditions" acknowledgement step before
                      POST /api/exams/[id]/start is ever called. */}
                  <a
                    href={examEntryHref(exam.id)}
                    onClick={() => logExamSelected(exam.id, "start")}
                    className="inline-block rounded bg-black px-3 py-1.5 text-sm text-white"
                  >
                    {exam.submission ? "Start next attempt" : "Start exam"}
                  </a>
                  {exam.accessCodeRequired && (
                    <span className="ml-2 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Access code required</span>
                  )}
                </ExamCard>
              )}
            </ExamSection>
          )}

          {upcoming.length > 0 && (
            <ExamSection title="Upcoming" exams={upcoming}>
              {(exam) => (
                <ExamCard exam={exam}>
                  {exam.availableFrom && <span className="text-sm text-blue-700">Opens {new Date(exam.availableFrom).toLocaleString()}</span>}
                </ExamCard>
              )}
            </ExamSection>
          )}

          {recentlyCompleted.length > 0 && (
            <ExamSection title="Recently completed" exams={recentlyCompleted} secondary>
              {(exam) => (
                <ExamCard exam={exam} secondary>
                  <div className="space-y-1 text-sm text-gray-500">
                    <p>{completedStatusLine(exam)}</p>
                    {exam.submission?.status === "GRADED" && (
                      <a href={`/student/exams/${exam.submission.id}`} className="underline">
                        View submission
                      </a>
                    )}
                    {exam.remainingAttempts > 0 && <p>You have {exam.remainingAttempts} attempt(s) remaining.</p>}
                  </div>
                </ExamCard>
              )}
            </ExamSection>
          )}

          {(history.length > 0 || (!showAllHistory && recentlyCompleted.length >= RECENTLY_COMPLETED_LIMIT)) && (
            <div>
              {!showAllHistory ? (
                <button
                  type="button"
                  onClick={loadFullHistory}
                  disabled={loadingHistory}
                  className="text-sm text-gray-600 underline disabled:opacity-50"
                >
                  {loadingHistory ? "Loading…" : "Show all completed examinations"}
                </button>
              ) : (
                history.length > 0 && (
                  <ExamSection title="Exam history" exams={history} secondary>
                    {(exam) => (
                      <ExamCard exam={exam} secondary>
                        <p className="text-sm text-gray-500">{completedStatusLine(exam)}</p>
                      </ExamCard>
                    )}
                  </ExamSection>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExamSection({
  title,
  exams,
  secondary,
  children,
}: {
  title: string;
  exams: AvailableExam[];
  secondary?: boolean;
  children: (exam: AvailableExam) => React.ReactNode;
}) {
  return (
    <section>
      <h2 className={secondary ? "text-sm font-medium text-gray-500" : "text-sm font-semibold uppercase tracking-wide text-gray-700"}>{title}</h2>
      <div className="mt-2 space-y-2">
        {exams.map((exam) => (
          <div key={exam.id}>{children(exam)}</div>
        ))}
      </div>
    </section>
  );
}

// Essential fields only (title, course, one status/date line, one
// primary action) — no repeated technical policy descriptions, no raw
// ids. `secondary` visually de-emphasizes completed/history exams
// (Part B: "Completed exams should look visually secondary") rather than
// giving them the same call-to-action prominence as an actionable exam.
function ExamCard({
  exam,
  emphasize,
  secondary,
  children,
}: {
  exam: AvailableExam;
  emphasize?: boolean;
  secondary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={secondary ? "rounded border border-gray-100 bg-gray-50 p-3" : `rounded border p-4 ${emphasize ? "border-gray-300" : "border-gray-200"}`}>
      <div className="flex items-center justify-between gap-4">
        <span className={secondary ? "text-sm font-medium text-gray-700" : "font-medium"}>{exam.title}</span>
        {!secondary && (
          <span className="shrink-0 text-sm text-gray-500">
            {exam.questionCount} questions · {exam.durationMins} min
          </span>
        )}
      </div>
      {exam.course && <p className="mt-1 text-xs text-gray-500">{exam.course.code} · {exam.course.name}</p>}
      {!secondary && exam.description && <p className="mt-1 text-sm text-gray-600">{exam.description}</p>}
      {!secondary && exam.submission && exam.submission.status === "IN_PROGRESS" && (
        <p className="mt-1 text-xs text-gray-500">Attempt {exam.submission.attemptNumber} of {exam.maxAttempts}</p>
      )}
      <div className="mt-2">{children}</div>
    </div>
  );
}
