"use client";

/**
 * Fix student completed-submission results flow — see
 * docs/student-released-results-flow-v1.md.
 *
 * The ONE read-only destination for a student's own SUBMITTED/GRADED
 * exam attempt. Deliberately a separate, minimal page from
 * src/app/student/exams/[id]/page.tsx (the exam-taking page) rather than
 * another branch inside it: this page must never call the exam-start
 * API, never touch secure-client/camera/timer/lockdown state, and never
 * risk momentarily rendering exam-taking UI. It only ever reads
 * GET /api/submissions/[id] (already ownership- and release-gated
 * server-side — see canStudentViewMarks in src/lib/assessmentLifecycle.ts)
 * and renders whatever that endpoint says is safe to show.
 */
import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

type SubmissionResult = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  submittedAt: string | null;
  totalScore: number | null;
  marksReleasedAt: string | null;
  marksReleased: boolean;
  exam: {
    title: string;
    questions: Array<{
      id: string;
      type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
      text: string;
      options: string[] | null;
      points?: number;
      order: number;
    }>;
  };
  answers: Array<{
    questionId: string;
    response: string | null;
    score?: number;
    feedback?: string;
  }>;
};

export default function StudentSubmissionResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const router = useRouter();

  const [data, setData] = useState<SubmissionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetch(`/api/submissions/${id}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(
            res.status === 403 || res.status === 404
              ? "This submission is not available."
              : typeof body?.error === "string"
                ? body.error
                : "Could not load this submission.",
          );
          return;
        }
        const body: SubmissionResult = await res.json();
        // Defense in depth — this page is for a FINISHED attempt only.
        // An IN_PROGRESS submission (should never reach this page via any
        // link this app renders) is routed back to the live exam page,
        // never rendered here as if it were a finished result.
        if (body.status === "IN_PROGRESS") {
          router.replace(`/student/exams/${id}`);
          return;
        }
        setData(body);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this submission.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error ?? "Not found."}</div>
        <button onClick={() => router.push("/student")} className="mt-4 text-sm underline">
          Return to student dashboard
        </button>
      </div>
    );
  }

  const totalPoints = data.exam.questions.reduce((sum, q) => sum + (q.points ?? 0), 0);
  const percentage =
    data.marksReleased && data.totalScore != null && totalPoints > 0 ? Math.round((data.totalScore / totalPoints) * 1000) / 10 : null;
  const sortedQuestions = [...data.exam.questions].sort((a, b) => a.order - b.order);

  return (
    <div className="mx-auto max-w-2xl">
      <button onClick={() => router.push("/student")} className="text-sm text-gray-500 underline">
        ← Back to dashboard
      </button>
      <h1 className="mt-2 text-2xl font-semibold">{data.exam.title}</h1>

      {data.status === "SUBMITTED" && (
        <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-4">
          <p className="font-medium">Submitted</p>
          <p className="mt-1 text-sm text-gray-600">Results will be available when released by your lecturer.</p>
        </div>
      )}

      {data.status === "GRADED" && !data.marksReleased && (
        <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-4">
          <p className="font-medium">Graded</p>
          <p className="mt-1 text-sm text-gray-600">Results have not been released yet.</p>
        </div>
      )}

      {data.status === "GRADED" && data.marksReleased && (
        <div className="mt-4 rounded border border-green-200 bg-green-50 p-4">
          <p className="font-medium text-green-800">Results released</p>
          <p className="mt-2 text-lg">
            Score: <span className="font-semibold">{data.totalScore ?? 0}</span>
            {totalPoints > 0 && <span> / {totalPoints}</span>}
          </p>
          {percentage != null && <p className="text-sm text-gray-600">Percentage: {percentage}%</p>}
        </div>
      )}

      <h2 className="mt-6 text-lg font-semibold">Your answers</h2>
      <div className="mt-3 space-y-3">
        {sortedQuestions.map((q, i) => {
          const answer = data.answers.find((a) => a.questionId === q.id);
          return (
            <div key={q.id} className="rounded border border-gray-200 p-3">
              <p className="text-sm text-gray-500">
                Question {i + 1}
                {q.points != null && ` · ${q.points} pt(s)`}
              </p>
              <p className="mt-1">{q.text}</p>

              {q.type === "MULTIPLE_CHOICE" && q.options && (
                <div className="mt-2 space-y-1">
                  {q.options.map((opt) => (
                    <p
                      key={opt}
                      className={
                        opt === answer?.response
                          ? "rounded border border-gray-400 bg-gray-100 px-2 py-1 text-sm font-medium"
                          : "px-2 py-1 text-sm text-gray-500"
                      }
                    >
                      {opt === answer?.response ? "● " : "○ "}
                      {opt}
                    </p>
                  ))}
                </div>
              )}
              {q.type !== "MULTIPLE_CHOICE" && (
                <p className="mt-2 text-sm text-gray-700">Your answer: {answer?.response ?? "(no answer)"}</p>
              )}

              {data.marksReleased && (
                <>
                  {answer?.score != null && <p className="mt-1 text-sm text-green-700">Marks: {answer.score}{q.points != null ? ` / ${q.points}` : ""}</p>}
                  {answer?.feedback && <p className="mt-1 text-sm text-gray-500">Feedback: {answer.feedback}</p>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
