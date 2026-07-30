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
import { evaluateFinalExamSystemCheckGate, type OverallState, type SystemCheckMode } from "@/lib/systemCheck/readiness";

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
        // Mandatory Tether Delivery for Final Examinations — see
        // src/lib/assessmentType.ts.
        assessmentType?: "PRACTICE_OR_FORMATIVE" | "QUIZ_OR_TEST" | "MID_SEMESTER_EXAMINATION" | "FINAL_EXAMINATION";
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

  // Tether System Check and Exam Readiness v1 — see
  // docs/tether-system-check-v1.md. Advisory in WARN mode, a real
  // server-enforced gate (POST /api/exams/[id]/start) in REQUIRE mode —
  // this client-side state only drives the UI; the actual block is
  // server-side.
  const [systemCheckConfig, setSystemCheckConfig] = useState<{ mode: SystemCheckMode; validityHours: number } | null>(null);
  const [latestSystemCheck, setLatestSystemCheck] = useState<{ overallStatus: OverallState; checkedAt: string; expiresAt: string; expired: boolean } | null>(null);
  const [warnAcknowledged, setWarnAcknowledged] = useState(false);
  // Captured once, not read live from Date.now() during render (which
  // React's purity rules disallow) — a page reload refreshes it.
  const [nowMs] = useState<number>(() => Date.now());

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
    fetch("/api/tether/system-check/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setSystemCheckConfig(data ? { mode: data.mode, validityHours: data.validityHours } : null))
      .catch(() => setSystemCheckConfig(null));
    fetch("/api/tether/system-check/latest")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setLatestSystemCheck(data?.run ?? null))
      .catch(() => setLatestSystemCheck(null));
  }, [examId, router]);

  const isFinalExamination = Boolean(result && "ok" in result && result.ok && result.exam.assessmentType === "FINAL_EXAMINATION");

  const systemCheckGate =
    isFinalExamination && systemCheckConfig
      ? evaluateFinalExamSystemCheckGate({
          mode: systemCheckConfig.mode,
          isFinalExamination: true,
          latestRun: latestSystemCheck && !latestSystemCheck.expired ? { overallStatus: latestSystemCheck.overallStatus, expiresAtMs: new Date(latestSystemCheck.expiresAt).getTime() } : null,
          nowMs,
        })
      : { allowed: true as const };

  // WARN mode never blocks — the student may continue once they've
  // explicitly acknowledged the missing/stale check. REQUIRE mode blocks
  // outright until a current record exists (also enforced server-side).
  const needsWarnAcknowledgement = isFinalExamination && systemCheckConfig?.mode === "WARN" && !systemCheckGate.allowed && !warnAcknowledged;
  const blockedByRequiredSystemCheck = isFinalExamination && systemCheckConfig?.mode === "REQUIRE" && !systemCheckGate.allowed;

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
    // Tether launch/install flow v1 — see secureClientStartGate.ts. When
    // this exam requires Tether Secure Browser and no verified
    // secure-client session exists yet, the submission is still created
    // (needed to later issue a launch manifest) but the student must not
    // proceed into the exam UI in this ordinary browser — send them to
    // the Tether launch page instead.
    if (submission.secureClientLaunch?.required && submission.secureClientLaunch.kind === "REDIRECT_TO_TETHER_LAUNCH") {
      router.push(submission.secureClientLaunch.redirectTo);
      return;
    }
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

      {/* Tether System Check and Exam Readiness v1 — see
          docs/tether-system-check-v1.md. Shown only for final
          examinations; a stored readiness record never itself authorises
          exam content — the real Tether launch/attestation flow below
          still runs unchanged either way. */}
      {isFinalExamination && (
        <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3">
          <p className="text-sm font-medium">System check</p>
          {latestSystemCheck ? (
            <p className="mt-1 text-xs text-gray-600">
              Last check: {new Date(latestSystemCheck.checkedAt).toLocaleString()} —{" "}
              {latestSystemCheck.overallStatus.replaceAll("_", " ").toLowerCase()}
              {latestSystemCheck.expired ? " (expired)" : ""}. Expires {new Date(latestSystemCheck.expiresAt).toLocaleString()}.
            </p>
          ) : (
            <p className="mt-1 text-xs text-gray-600">You have not run a system check yet.</p>
          )}
          <a href="/student/system-check" className="mt-2 inline-block text-xs underline">
            Run system check
          </a>
          {needsWarnAcknowledgement && (
            <label className="mt-3 flex items-start gap-2 text-xs text-amber-800">
              <input type="checkbox" className="mt-0.5" checked={warnAcknowledged} onChange={(e) => setWarnAcknowledged(e.target.checked)} />
              I understand this computer has not passed a current system check and want to continue anyway.
            </label>
          )}
          {blockedByRequiredSystemCheck && (
            <p className="mt-2 text-xs text-red-700">A current system check is required before this final examination can be started.</p>
          )}
        </div>
      )}

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
            disabled={starting || !accessCode.trim() || !policyAcknowledged || needsWarnAcknowledgement || blockedByRequiredSystemCheck}
            className="mt-3 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {starting ? "Starting..." : "Start exam"}
          </button>
        </div>
      ) : (
        <button
          onClick={handleStart}
          disabled={starting || !policyAcknowledged || needsWarnAcknowledgement || blockedByRequiredSystemCheck}
          className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {starting ? "Starting..." : "Start exam"}
        </button>
      )}
      {startError && <p className="mt-2 text-sm text-red-600">{startError}</p>}
    </div>
  );
}
