"use client";

/**
 * Safe Exam Deep Link v1 — see docs/course-enrolment-and-exam-assignment.md.
 *
 * This is a CONVENIENCE LAUNCH LINK ONLY. It is not an authorization
 * token and grants no access beyond what the student's existing
 * institution/course/assignment status already permits — anyone
 * forwarding this URL gains nothing unless they are already a
 * legitimately authorized student who can log in.
 *
 * Route protection: `/student/*` (including this route) requires an
 * authenticated STUDENT session via src/proxy.ts before this component
 * ever renders — an unauthenticated visitor is redirected to
 * `/login?callbackUrl=/student/exams/join/[examId]` and returned here
 * after login (see src/lib/safeCallbackUrl.ts for the open-redirect
 * guard on that callback value).
 *
 * Once rendered, this page runs the exact same authorization chain as
 * the dashboard's "Start exam" button — institution, course/assignment,
 * published, availability window (via GET .../access-check) — then, if
 * an access code is required, collects it and calls the same
 * POST /api/exams/[id]/start the dashboard calls. No new authorization
 * path is introduced; this is a different entry point into the same one.
 */

import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

// Exam Design Policy v1 — see docs/exam-design-policy-v1.md.
type ExamPolicySummary = {
  examModeLabel: string;
  introStatement: string;
  allowed: string[];
  notAllowed: string[];
  secureControlStatements: string[];
};

type AccessCheckResult =
  | {
      ok: true;
      exam: {
        id: string;
        title: string;
        description: string | null;
        durationMins: number;
        accessCodeRequired: boolean;
        course: { id: string; name: string; code: string } | null;
      };
      existingSubmission: { id: string; status: "IN_PROGRESS" | "SUBMITTED" | "GRADED" } | null;
      examPolicySummary: ExamPolicySummary;
    }
  | { ok: false; reason: "no_access" }
  | { ok: false; reason: "not_open"; opensAt: string }
  | { ok: false; reason: "closed" };

export default function JoinExamPage({
  params,
}: {
  params: Promise<{ examId: string }>;
}) {
  const { examId } = usePromise(params);
  const router = useRouter();

  const [result, setResult] = useState<AccessCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessCode, setAccessCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Exam Design Policy v1 — see docs/exam-design-policy-v1.md. The
  // student must not start a new attempt until this is checked; POST
  // /api/exams/[id]/start rejects the request server-side if
  // policyAcknowledged isn't true, so this client-side gate is a UX
  // convenience, not the actual enforcement.
  const [policyAcknowledged, setPolicyAcknowledged] = useState(false);

  useEffect(() => {
    fetch(`/api/exams/${examId}/access-check`)
      .then((res) => res.json())
      .then((data: AccessCheckResult) => {
        setResult(data);
        // Already has a submission — skip the join screen and go straight
        // to it, exactly like clicking "Continue"/"View result" would.
        if (data.ok && data.existingSubmission) {
          router.replace(`/student/exams/${data.existingSubmission.id}`);
        }
      })
      .finally(() => setLoading(false));
  }, [examId, router]);

  async function handleStart() {
    setStarting(true);
    setStartError(null);
    const res = await fetch(`/api/exams/${examId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(accessCode ? { accessCode } : {}), policyAcknowledged: true }),
    });
    setStarting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setStartError(typeof body?.error === "string" ? body.error : "Failed to start exam.");
      return;
    }
    const submission = await res.json();
    router.push(`/student/exams/${submission.id}`);
  }

  if (loading || !result) {
    return <p className="mx-auto mt-16 max-w-md text-center text-gray-500">Loading...</p>;
  }

  if (!result.ok) {
    const message =
      result.reason === "no_access"
        ? "You do not have access to this exam."
        : result.reason === "not_open"
          ? `This exam is not yet open.${
              "opensAt" in result ? ` It opens at ${new Date(result.opensAt).toLocaleString()}.` : ""
            }`
          : "This exam has closed.";
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-lg font-medium">Exam link</h1>
        <p className="mt-3 text-gray-700">{message}</p>
        <button
          onClick={() => router.push("/student")}
          className="mt-4 rounded border border-gray-300 px-3 py-1.5 text-sm"
        >
          Go to my dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6">
      <h1 className="text-lg font-medium">{result.exam.title}</h1>
      {result.exam.course && (
        <p className="mt-1 text-xs text-gray-500">
          {result.exam.course.code} · {result.exam.course.name}
        </p>
      )}
      {result.exam.description && (
        <p className="mt-2 text-sm text-gray-600">{result.exam.description}</p>
      )}
      <p className="mt-2 text-sm text-gray-500">{result.exam.durationMins} minutes</p>

      {/* Exam Design Policy v1 — see docs/exam-design-policy-v1.md. Shown
          before every attempt start, not just secure-mode exams. Neutral,
          non-accusatory wording only. */}
      <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3">
        <p className="text-sm font-medium">Exam conditions</p>
        <p className="mt-1 text-sm text-gray-700">{result.examPolicySummary.introStatement}</p>
        {result.examPolicySummary.allowed.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium text-gray-600">Allowed:</p>
            <ul className="mt-0.5 list-disc pl-5 text-xs text-gray-700">
              {result.examPolicySummary.allowed.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {result.examPolicySummary.notAllowed.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium text-gray-600">Not allowed:</p>
            <ul className="mt-0.5 list-disc pl-5 text-xs text-gray-700">
              {result.examPolicySummary.notAllowed.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {result.examPolicySummary.secureControlStatements.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium text-gray-600">Secure controls:</p>
            <ul className="mt-0.5 list-disc pl-5 text-xs text-gray-700">
              {result.examPolicySummary.secureControlStatements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        <label className="mt-3 flex items-start gap-2 text-xs text-gray-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={policyAcknowledged}
            onChange={(e) => setPolicyAcknowledged(e.target.checked)}
          />
          I understand the permitted resources and exam conditions.
        </label>
      </div>

      {result.exam.accessCodeRequired ? (
        <div className="mt-4">
          <label className="block text-sm font-medium">Access code</label>
          <input
            type="text"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            placeholder="Enter the code your lecturer shared"
          />
          <button
            onClick={handleStart}
            disabled={starting || !accessCode.trim() || !policyAcknowledged}
            className="mt-3 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {starting ? "Starting..." : "Start exam"}
          </button>
        </div>
      ) : (
        <button
          onClick={handleStart}
          disabled={starting || !policyAcknowledged}
          className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {starting ? "Starting..." : "Start exam"}
        </button>
      )}
      {startError && <p className="mt-2 text-sm text-red-600">{startError}</p>}
    </div>
  );
}
