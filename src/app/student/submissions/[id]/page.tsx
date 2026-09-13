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
 *
 * Post-submission question protection — see
 * docs/post-submission-question-protection-v1.md. This is a SUBMISSION
 * SUMMARY, not an exam-review page: GET /api/submissions/[id] no longer
 * sends question text/options/correct answers, or the student's own
 * per-question answers/scores/feedback, for a finished attempt at all —
 * enforced server-side, not by this component choosing not to render
 * fields it still received. There is nothing question-shaped in the
 * response for this page to show even if it tried.
 */
import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

type SubmissionResult = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED" | "VOIDED";
  startedAt: string;
  submittedAt: string | null;
  totalScore: number | null;
  marksReleasedAt: string | null;
  marksReleased: boolean;
  exam: { title: string };
};

function formatDuration(startedAt: string, submittedAt: string | null): string | null {
  if (!submittedAt) return null;
  const ms = new Date(submittedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "Less than a minute" : `${minutes} min`;
}

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

  // VOIDED-attempt recovery v1 — see docs/voided-submission-recovery-v1.md.
  // This page's whole framing ("Submission complete") and status label
  // (Submitted/Graded) assume a genuine finished result — never render
  // either for a voided attempt, which was never really completed and
  // never received a score. A student can only reach a VOIDED submission
  // here via a stale link/bookmark (the dashboard itself never links to
  // one — see studentSubmissionState.ts's hasReadOnlySubmissionView),
  // so this stays a plain, honest, dedicated view rather than a redirect.
  if (data.status === "VOIDED") {
    return (
      <div className="mx-auto max-w-2xl">
        <button onClick={() => router.push("/student")} className="text-sm text-gray-500 underline">
          ← Back to dashboard
        </button>
        <h1 className="mt-2 text-2xl font-semibold">Attempt voided</h1>
        <p className="mt-1 text-lg text-gray-700">{data.exam.title}</p>
        <div className="mt-6 rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
          This attempt was voided by your institution due to a technical issue. It does not count toward your
          attempt limit and has no score. Your prior activity has been preserved for record-keeping. Return to your
          dashboard to start a new attempt if one is available.
        </div>
      </div>
    );
  }

  const duration = formatDuration(data.startedAt, data.submittedAt);
  const gradingLabel =
    data.status === "SUBMITTED" ? "Pending" : data.marksReleased ? "Released" : "Graded — not yet released";

  return (
    <div className="mx-auto max-w-2xl">
      <button onClick={() => router.push("/student")} className="text-sm text-gray-500 underline">
        ← Back to dashboard
      </button>
      <h1 className="mt-2 text-2xl font-semibold">Submission complete</h1>
      <p className="mt-1 text-lg text-gray-700">{data.exam.title}</p>

      <dl className="mt-6 divide-y divide-gray-100 rounded border border-gray-200 text-sm">
        <div className="flex items-center justify-between px-4 py-2.5">
          <dt className="text-gray-500">Status</dt>
          <dd className="font-medium">{data.status === "SUBMITTED" ? "Submitted" : "Graded"}</dd>
        </div>
        {data.submittedAt && (
          <div className="flex items-center justify-between px-4 py-2.5">
            <dt className="text-gray-500">Submitted</dt>
            <dd className="font-medium">{new Date(data.submittedAt).toLocaleString()}</dd>
          </div>
        )}
        {duration && (
          <div className="flex items-center justify-between px-4 py-2.5">
            <dt className="text-gray-500">Duration</dt>
            <dd className="font-medium">{duration}</dd>
          </div>
        )}
        <div className="flex items-center justify-between px-4 py-2.5">
          <dt className="text-gray-500">Grading</dt>
          <dd className="font-medium">{gradingLabel}</dd>
        </div>
        {data.marksReleased && data.totalScore != null && (
          <div className="flex items-center justify-between px-4 py-2.5">
            <dt className="text-gray-500">Score</dt>
            <dd className="font-medium">{data.totalScore}</dd>
          </div>
        )}
      </dl>

      <p className="mt-6 text-gray-700">Your exam has been submitted successfully.</p>
      <p className="mt-2 text-sm text-gray-500">Exam questions are not available after submission.</p>

      <button
        onClick={() => router.push("/student")}
        className="mt-6 rounded border border-gray-300 px-3 py-1.5 text-sm"
      >
        Back to dashboard
      </button>
    </div>
  );
}
