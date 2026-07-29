"use client";

/**
 * Tether launch/install flow v1 — see docs/secure-client-foundation-seb-v1.md
 * and the Tether Secure Browser launch architecture.
 *
 * Route protection: `/student/*` (including this route) requires an
 * authenticated STUDENT session via src/proxy.ts before this component
 * ever renders — an unauthenticated visitor is redirected to
 * `/login?callbackUrl=/student/exams/[id]/tether-launch` and returned
 * here after login (src/lib/safeCallbackUrl.ts allow-lists this exact
 * path — this is what makes "pending launch survives login" work with
 * no Electron-side persistence needed).
 *
 * This page renders two entirely different things depending on where
 * it's loaded:
 *
 *  - OUTSIDE Tether Secure Browser (an ordinary browser landed here
 *    because POST /api/exams/[id]/start or GET /api/submissions/[id]
 *    reported this exam requires Tether — see secureClientStartGate.ts):
 *    explains that Tether Secure Browser is required, offers "Open
 *    Tether Secure Browser" (a tether:// deep link), and — since a
 *    webpage can never know with certainty whether the protocol handler
 *    actually opened an installed app — reveals an installer download
 *    and a manual "I have installed it — open examination" retry after
 *    a short timeout.
 *
 *  - INSIDE Tether Secure Browser (isRunningInLockdownBrowser() ===
 *    true): runs the same access-check -> policy-acknowledgement ->
 *    start sequence as the join-by-link page
 *    (src/app/student/exams/join/[examId]/page.tsx), then — because the
 *    exam requires a verified secure-client session — additionally
 *    issues and consumes a signed launch manifest
 *    (POST .../secure-client/launch -> POST
 *    /api/secure-client/launch/[manifestId]/consume, reusing the exact
 *    sequence already proven by src/app/dev/mock-secure-client/[id]/page.tsx)
 *    before redirecting straight into the exam — the student never
 *    returns to the dashboard to find it themselves.
 */

import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import { isRunningInLockdownBrowser } from "@/lib/lockdownDetection";
import { buildTetherDeepLink, shouldShowInstallerFallback, resolveTetherLaunchFailureMessage } from "@/lib/tetherLaunch";
import { logClientTetherDiagnostic } from "@/lib/tetherDiagnosticLog";

// Exam Design Policy v1 — see docs/exam-design-policy-v1.md. Mirrors the
// join page's own local type — this codebase does not share a central
// type module between these two pages (see join/[examId]/page.tsx).
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

type SecureClientLaunchField = { required: false } | { required: true; kind: "ALLOW" | "REDIRECT_TO_TETHER_LAUNCH"; redirectTo: string | null };
type StartResponse = { id: string; secureClientLaunch?: SecureClientLaunchField };

const INSTALLER_DOWNLOAD_URL = "/downloads/tether-secure-browser/latest/Tether-Secure-Browser-win-x64.exe";

export default function TetherLaunchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: examId } = usePromise(params);
  // null until the client-side detection has actually run once, so this
  // never guesses (and never flashes the wrong UI) before mount.
  const [inTether, setInTether] = useState<boolean | null>(null);

  useEffect(() => {
    const detected = isRunningInLockdownBrowser();
    logClientTetherDiagnostic("tether_browser_detected", { detected });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInTether(detected);
  }, []);

  if (inTether === null) {
    return <p className="mx-auto mt-16 max-w-md text-center text-gray-500">Loading...</p>;
  }

  return inTether ? <InsideTetherLaunchFlow examId={examId} /> : <OutsideTetherPrompt examId={examId} />;
}

// ---------------------------------------------------------------------------
// Outside Tether — explanatory + protocol-launch-attempt + installer
// fallback UI. Never claims certainty the app opened.
// ---------------------------------------------------------------------------

function OutsideTetherPrompt({ examId }: { examId: string }) {
  const [attemptedAt, setAttemptedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (attemptedAt == null) return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [attemptedAt]);

  function attemptLaunch() {
    // Never logged: this is a plain navigation, not a console.log/telemetry
    // call, and the link itself carries only examId — no token to leak.
    window.location.href = buildTetherDeepLink(examId);
    setAttemptedAt(Date.now());
  }

  const showFallback = attemptedAt != null && shouldShowInstallerFallback(now - attemptedAt);

  return (
    <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6">
      <h1 className="text-lg font-medium">Tether Secure Browser required</h1>
      <p className="mt-3 text-sm text-gray-700">
        This exam must be taken in Tether Secure Browser, our first-party secure exam client. It does not use Safe
        Exam Browser, and no Browser Exam Key or Config Key is needed.
      </p>
      <button onClick={attemptLaunch} className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white">
        Open Tether Secure Browser
      </button>
      {attemptedAt != null && !showFallback && <p className="mt-3 text-center text-xs text-gray-500">Opening Tether Secure Browser…</p>}
      {showFallback && (
        <div className="mt-5 border-t border-gray-200 pt-4">
          <p className="text-sm text-gray-700">
            If nothing opened, Tether Secure Browser may not be installed on this device yet — a webpage can never
            be completely certain either way.
          </p>
          <a
            href={INSTALLER_DOWNLOAD_URL}
            className="mt-3 block w-full rounded border border-gray-300 px-4 py-2 text-center text-sm text-gray-800"
          >
            Download Tether Secure Browser (Windows)
          </a>
          <button onClick={attemptLaunch} className="mt-2 w-full rounded bg-black px-4 py-2 text-sm text-white">
            I have installed it — open examination
          </button>
          <div className="mt-4 text-xs text-gray-500">
            <p className="font-medium text-gray-600">Installing Tether Secure Browser</p>
            <ol className="mt-1 list-decimal space-y-1 pl-4">
              <li>Download the installer above.</li>
              <li>Run the downloaded file and follow the on-screen prompts.</li>
              <li>Once installed, return to this page and select &quot;I have installed it — open examination&quot;.</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inside Tether — automatic access-check -> acknowledgement -> start ->
// launch -> consume -> redirect. The student never returns to the
// dashboard to find the exam themselves.
// ---------------------------------------------------------------------------

function InsideTetherLaunchFlow({ examId }: { examId: string }) {
  const router = useRouter();
  const [result, setResult] = useState<AccessCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessCode, setAccessCode] = useState("");
  const [policyAcknowledged, setPolicyAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/exams/${examId}/access-check`)
      .then((res) => res.json())
      .then((data: AccessCheckResult) => {
        setResult(data);
        // Already has a submission — no need to show the acknowledgement
        // screen again; go straight into the start/launch sequence.
        if (data.ok && data.existingSubmission?.status === "IN_PROGRESS") {
          void runLaunchSequence(null);
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  /**
   * Runs POST /start (idempotent — resumes an existing IN_PROGRESS
   * submission or creates a fresh one), then, only if the exam actually
   * requires it, issues and consumes a signed launch manifest — reusing
   * the exact same endpoints and sequence as
   * src/app/dev/mock-secure-client/[id]/page.tsx.
   */
  async function runLaunchSequence(code: string | null) {
    setBusy(true);
    setError(null);
    try {
      const startRes = await fetch(`/api/exams/${examId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(code ? { accessCode: code } : {}), policyAcknowledged: true }),
      });
      if (!startRes.ok) {
        const body = await startRes.json().catch(() => null);
        setError(typeof body?.error === "string" ? body.error : "Failed to start exam.");
        return;
      }
      const submission: StartResponse = await startRes.json();
      // A successful /start response implies an authenticated STUDENT
      // session (the route 401s otherwise) — logged together since
      // there is no separate client-side session check on this page.
      logClientTetherDiagnostic("session_present_and_submission_known", {
        authenticated: true,
        hasSubmissionId: Boolean(submission.id),
        secureClientLaunchRequired: submission.secureClientLaunch?.required ?? false,
        secureClientLaunchKind: submission.secureClientLaunch?.required ? submission.secureClientLaunch.kind : null,
      });

      if (!submission.secureClientLaunch?.required || submission.secureClientLaunch.kind === "ALLOW") {
        // Either this exam doesn't require Tether after all (shouldn't
        // normally reach this page in that case, but harmless), or a
        // verified session already exists (resuming after an earlier
        // successful launch) — either way, proceed straight into the
        // exam, exactly like the join page does.
        router.replace(`/student/exams/${submission.id}`);
        return;
      }

      const launchRes = await fetch(`/api/submissions/${submission.id}/secure-client/launch`, { method: "POST" });
      if (!launchRes.ok) {
        const body = await launchRes.json().catch(() => null);
        setError(resolveTetherLaunchFailureMessage(typeof body?.code === "string" ? body.code : ""));
        return;
      }
      const { manifest, signature } = await launchRes.json();
      // manifestId only — never the nonce, signature, or full manifest
      // contents (the manifest is the launch token; see
      // secureLaunchManifest.ts's own doc comment on why the raw nonce
      // must never be persisted, let alone logged).
      logClientTetherDiagnostic("launch_manifest_issued", { manifestId: manifest.manifestId, clientType: manifest.clientType });

      const consumeRes = await fetch(`/api/secure-client/launch/${manifest.manifestId}/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest, signature }),
      });
      if (!consumeRes.ok) {
        const body = await consumeRes.json().catch(() => null);
        setError(resolveTetherLaunchFailureMessage(typeof body?.code === "string" ? body.code : ""));
        return;
      }
      const consumed: { ok: boolean; sessionId?: string } = await consumeRes.json();
      logClientTetherDiagnostic("launch_manifest_consumed_session_created", {
        outcome: "CONSUMED",
        hasSessionId: Boolean(consumed.sessionId),
      });

      // Consumed successfully — a verified secure-client session now
      // exists for this submission. Land directly in the exam; the
      // Electron app's own live display-enforcement (registered from app
      // start, independent of this page) takes over from here.
      router.replace(`/student/exams/${submission.id}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading || !result) {
    return <p className="mx-auto mt-16 max-w-md text-center text-gray-500">Loading...</p>;
  }

  if (!result.ok) {
    const message =
      result.reason === "no_access"
        ? "You do not have access to this exam."
        : result.reason === "not_open"
          ? `This exam is not yet open.${"opensAt" in result ? ` It opens at ${new Date(result.opensAt).toLocaleString()}.` : ""}`
          : "This exam has closed.";
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-lg font-medium">Exam link</h1>
        <p className="mt-3 text-gray-700">{message}</p>
      </div>
    );
  }

  if (result.existingSubmission?.status === "IN_PROGRESS" || busy) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-lg font-medium">{result.exam.title}</h1>
        <p className="mt-3 text-sm text-gray-500">Opening your exam in Tether Secure Browser…</p>
        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {error}
            <button
              onClick={() => void runLaunchSequence(accessCode || null)}
              className="mt-2 block w-full rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800"
            >
              I have installed it — open examination
            </button>
          </div>
        )}
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
      {result.exam.description && <p className="mt-2 text-sm text-gray-600">{result.exam.description}</p>}
      <p className="mt-2 text-sm text-gray-500">{result.exam.durationMins} minutes</p>

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
          <input type="checkbox" className="mt-0.5" checked={policyAcknowledged} onChange={(e) => setPolicyAcknowledged(e.target.checked)} />
          I understand the permitted resources and exam conditions.
        </label>
      </div>

      {result.exam.accessCodeRequired && (
        <div className="mt-4">
          <label className="block text-sm font-medium">Access code</label>
          <input
            type="text"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            placeholder="Enter the code your lecturer shared"
          />
        </div>
      )}

      <button
        onClick={() => void runLaunchSequence(accessCode || null)}
        disabled={busy || !policyAcknowledged || (result.exam.accessCodeRequired && !accessCode.trim())}
        className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? "Starting..." : "Start exam"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
