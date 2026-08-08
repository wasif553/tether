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

import { useEffect, useRef, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import { isRunningInLockdownBrowser } from "@/lib/lockdownDetection";
import { buildTetherDeepLink, shouldShowInstallerFallback, resolveTetherLaunchFailureMessage, isSecureClientSessionVerified } from "@/lib/tetherLaunch";
import { logClientTetherDiagnostic } from "@/lib/tetherDiagnosticLog";
import { ensureRegisteredInstallation } from "@/lib/secureClient/installationClient";
import { ManualReviewNotice } from "@/components/ManualReviewNotice";
import { LockdownApplicationCheck } from "@/components/LockdownApplicationCheck";
import { ensureLockdownBridgeInitialized, type LockdownCapabilityInfo } from "@/lib/lockdownClient";

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

type SecureClientLaunchField = { required: false } | { required: true; kind: "ALLOW" | "REDIRECT_TO_TETHER_LAUNCH"; redirectTo: string | null };
type StartResponse = { id: string; secureClientLaunch?: SecureClientLaunchField };

// Pilot operations + distribution readiness v1 — this used to be a
// hardcoded literal (`/downloads/tether-secure-browser/latest/...`)
// pointing at a route/file that never existed — a dead link shown to
// every student who reached the installer-fallback state. Now sourced
// from the one canonical release-metadata endpoint
// (GET /api/tether/release-metadata -> resolveTetherReleaseMetadata),
// so this can never again silently drift out of sync with whether a
// real installer is actually published.
type ReleaseMetadata = { version: string; installerUrl: string | null; downloadsEnabled: boolean };

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
  // Mandatory Tether Delivery for Final Examinations — Part 7: "Use
  // simple student-facing copy: 'This final examination must be opened
  // in Tether Secure Browser.'" A read-only, side-effect-free lookup
  // purely for wording — never gates anything here (the actual
  // enforcement is entirely server-side; see secureClientStartGate.ts).
  const [isFinalExamination, setIsFinalExamination] = useState(false);
  // Pilot operations + distribution readiness v1 — null until loaded;
  // the fallback panel treats a still-loading/failed fetch the same as
  // "downloads not configured" (never assumes a download link exists).
  const [release, setRelease] = useState<ReleaseMetadata | null>(null);

  useEffect(() => {
    fetch(`/api/exams/${examId}/access-check`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: AccessCheckResult | null) => {
        if (data?.ok) {
          setIsFinalExamination(data.exam.assessmentType === "FINAL_EXAMINATION");
        }
      })
      .catch(() => {});
  }, [examId]);

  useEffect(() => {
    fetch("/api/tether/release-metadata")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ReleaseMetadata | null) => setRelease(data))
      .catch(() => setRelease(null));
  }, []);

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
        {isFinalExamination
          ? "This final examination must be opened in Tether Secure Browser."
          : "This exam must be taken in Tether Secure Browser, our first-party secure exam client. It does not use Safe Exam Browser, and no Browser Exam Key or Config Key is needed."}
      </p>
      <button onClick={attemptLaunch} className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white">
        Open Tether Secure Browser
      </button>
      {/* Tether System Check and Exam Readiness v1 — see
          docs/tether-system-check-v1.md. */}
      <a href="/student/system-check" className="mt-2 block w-full rounded border border-gray-300 px-4 py-2 text-center text-sm text-gray-800">
        Check this computer
      </a>
      {/* Registered Tether Devices and Revocation UI v1 — a low-emphasis
          text link, not another button, so this screen doesn't get
          crowded when the student's actual goal here is opening Tether. */}
      <a href="/student/tether-devices" className="mt-2 block text-center text-xs text-gray-500 underline">
        Manage registered computers
      </a>
      {attemptedAt != null && !showFallback && <p className="mt-3 text-center text-xs text-gray-500">Opening Tether Secure Browser…</p>}
      {showFallback && (
        <div className="mt-5 border-t border-gray-200 pt-4">
          <p className="text-sm text-gray-700">
            If nothing opened, Tether Secure Browser may not be installed on this device yet — a webpage can never
            be completely certain either way.
          </p>
          {release?.downloadsEnabled && release.installerUrl ? (
            <>
              <a
                href={release.installerUrl}
                className="mt-3 block w-full rounded border border-gray-300 px-4 py-2 text-center text-sm text-gray-800"
              >
                Download Tether Secure Browser (Windows)
              </a>
              <div className="mt-4 text-xs text-gray-500">
                <p className="font-medium text-gray-600">Installing Tether Secure Browser</p>
                <ol className="mt-1 list-decimal space-y-1 pl-4">
                  <li>Download the installer above.</li>
                  <li>Run the downloaded file and follow the on-screen prompts.</li>
                  <li>Once installed, return to this page and select &quot;I have installed it — open examination&quot;.</li>
                </ol>
              </div>
            </>
          ) : (
            <p className="mt-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              Tether Secure Browser is not yet available for public download. Contact your institution or exam
              support for the approved installer.
            </p>
          )}
          <button onClick={attemptLaunch} className="mt-2 w-full rounded bg-black px-4 py-2 text-sm text-white">
            I have installed it — open examination
          </button>
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
  // Secure-recovery hardening v1, Part B — true once the authoritative
  // recovery-status endpoint has reported MANUAL_REVIEW_REQUIRED for the
  // existing IN_PROGRESS submission this page would otherwise
  // auto-relaunch. Checked ONCE, before ever calling runLaunchSequence,
  // so an unbound-original/device-mismatch attempt never enters the
  // relaunch sequence at all here — no SecureClientSession row is
  // created by this page in that case, and the automatic retry loop
  // (this effect re-running relaunch, silently, on every mount) never
  // starts.
  const [manualReview, setManualReview] = useState(false);

  // Tether Windows Lockdown Hardening v1, Part 3 — see
  // docs/tether-windows-lockdown-hardening-v1.md. `lockdownBlocked` and
  // `lockdownUnavailable` are mutually exclusive with `manualReview`
  // above and with each other; `pendingLaunchCodeRef` remembers which
  // launch attempt (auto-resume vs a manual Start click, and if manual,
  // with which access code) was interrupted by the preflight check, so
  // "Check again" can resume the EXACT same attempt rather than
  // re-deriving it.
  const [lockdownBlocked, setLockdownBlocked] = useState<string[] | null>(null);
  const [lockdownUnavailable, setLockdownUnavailable] = useState(false);
  const [lockdownChecking, setLockdownChecking] = useState(false);
  const pendingLaunchCodeRef = useRef<string | null>(null);
  const pendingIsFinalExamRef = useRef(false);
  const lockdownCapabilityInfoRef = useRef<Map<string, LockdownCapabilityInfo> | null>(null);

  // P0 secure-launch redirect loop hotfix — see
  // docs/tether-secure-launch-loop-hotfix.md. Two independent guards:
  //
  //  - `unmountedRef`: runLaunchSequence is a plain async function, not a
  //    cancellable effect — if the student navigates away (e.g. clicks
  //    "My Exams" in the nav bar) WHILE a launch attempt is still
  //    in-flight, the in-flight promise chain previously kept running
  //    after unmount and its trailing `router.replace(...)` would still
  //    fire once network calls resolved, silently pulling the student
  //    back into the exam/tether-launch bounce even though they had
  //    already navigated away. Checked immediately before every
  //    navigation call this component makes.
  //  - `autoAttemptedRef`: the mount effect below auto-resumes an
  //    existing IN_PROGRESS submission at most ONCE per mount — a
  //    defensive one-shot guard, not a retry-count/timer hack. The real
  //    fix for the infinite mount->redirect->remount cycle is that a
  //    failed/unverified launch no longer navigates into the exam at all
  //    (see runLaunchSequence below) — this guard is a second, cheap
  //    line of defense against the same effect firing twice in one
  //    mount for any other reason (e.g. a dependency re-run).
  const unmountedRef = useRef(false);
  const autoAttemptedRef = useRef(false);
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  /**
   * Part 3/5 — returns true when it is safe to proceed into
   * runLaunchSequence. Fails OPEN when this packaged build predates the
   * lockdown bridge (older installs simply don't expose
   * runLockdownPreflightScan — feature-detected like every other
   * optional bridge method) so existing installations are never broken
   * by this addition. `isFinalExamination` is passed explicitly (never
   * read from the `result` component-state closure) because this
   * function is also called from inside the mount effect's async
   * callback, before `result` state has been set for the first time —
   * reading the stale closure there would silently apply the WRONG
   * exam-type gate.
   */
  async function checkLockdownPreflight(code: string | null, isFinalExamination: boolean): Promise<boolean> {
    pendingLaunchCodeRef.current = code;
    pendingIsFinalExamRef.current = isFinalExamination;
    if (typeof window.sesLockdown?.runLockdownPreflightScan !== "function") return true;
    lockdownCapabilityInfoRef.current = await ensureLockdownBridgeInitialized();
    setLockdownChecking(true);
    try {
      const scan = await window.sesLockdown.runLockdownPreflightScan();
      if (scan.state === "BLOCKED") {
        const names = scan.matchedCapabilityIds.map((id) => lockdownCapabilityInfoRef.current?.get(id)?.displayName ?? "an application");
        setLockdownBlocked([...new Set(names)]);
        window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_PREFLIGHT_BLOCKED", { examId, capabilityCount: scan.matchedCapabilityIds.length });
        return false;
      }
      if (scan.state === "UNAVAILABLE") {
        setLockdownUnavailable(true);
        window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_PROCESS_INSPECTION_UNAVAILABLE", { examId, reason: scan.reason });
        return false;
      }
      // Part 5 — "fail closed for final examinations when remote-session
      // state cannot be safely resolved and policy requires it; ordinary
      // non-final assessments must remain unchanged unless configured."
      // Checked only after the process scan itself is clean, and only
      // for final examinations — a non-final Tether exam never runs this
      // check at all (Part 16 item 32).
      if (isFinalExamination) {
        const session = await window.sesLockdown?.getRemoteSessionStatus?.();
        if (!session || session.remoteSessionSignalSource === "UNAVAILABLE") {
          setLockdownUnavailable(true);
          window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_REMOTE_SESSION_CHECK_FAILED_CLOSED", { examId });
          return false;
        }
        if (session.isRemoteSession) {
          setLockdownBlocked(["Remote Desktop session"]);
          window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_PREFLIGHT_BLOCKED", { examId, capabilityCount: 1, reason: "REMOTE_SESSION" });
          return false;
        }
      }
      setLockdownBlocked(null);
      setLockdownUnavailable(false);
      return true;
    } finally {
      setLockdownChecking(false);
    }
  }

  function checkLockdownAgain() {
    void checkLockdownPreflight(pendingLaunchCodeRef.current, pendingIsFinalExamRef.current).then((ok) => {
      if (ok) void runLaunchSequence(pendingLaunchCodeRef.current);
    });
  }

  useEffect(() => {
    fetch(`/api/exams/${examId}/access-check`)
      .then((res) => res.json())
      .then(async (data: AccessCheckResult) => {
        setResult(data);
        // Already has a submission — no need to show the acknowledgement
        // screen again; go straight into the start/launch sequence,
        // unless the authoritative recovery state says this attempt
        // requires manual review first.
        if (data.ok && data.existingSubmission?.status === "IN_PROGRESS" && !autoAttemptedRef.current) {
          const requiresManualReview = await checkManualReviewRequired(data.existingSubmission.id);
          if (requiresManualReview) {
            logClientTetherDiagnostic("RECOVERY_REQUIRED", { examId, submissionId: data.existingSubmission.id });
            setManualReview(true);
            return;
          }
          const preflightOk = await checkLockdownPreflight(null, data.exam.assessmentType === "FINAL_EXAMINATION");
          if (!preflightOk) return;
          if (unmountedRef.current) return;
          autoAttemptedRef.current = true;
          void runLaunchSequence(null);
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  /**
   * Best-effort, read-only check against the authoritative
   * GET /api/submissions/[id]/recovery-status endpoint (never a local
   * guess) — see src/lib/tetherRecoveryRunner.ts. Fails OPEN (returns
   * false) on any network/parse error: this is only a UI-layer decision
   * about whether to show the manual-review notice instead of attempting
   * a relaunch here; the real, authoritative content gate is always the
   * server-side check inside POST /api/exams/[id]/start and
   * GET /api/submissions/[id], which enforce this regardless of what this
   * page decides to render.
   */
  async function checkManualReviewRequired(submissionId: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/submissions/${submissionId}/recovery-status`);
      if (!res.ok) return false;
      const body: { state?: string } = await res.json();
      return body.state === "MANUAL_REVIEW_REQUIRED";
    } catch {
      return false;
    }
  }

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
    // Corrective pass v1.2.2, Tasks 2/3 — activate the fail-closed
    // enforcement gate the MOMENT the student enters a secured exam
    // (clicking Start/Continue, or this page's own auto-resume of an
    // existing IN_PROGRESS submission below), not merely once the exam
    // CONTENT page later mounts. The acknowledgement screen itself is
    // deliberately left uncovered (the student must be able to read it
    // and type an access code) — this only covers the LOADING transition
    // from here into verified exam content. Un-covered again below on
    // any failure, so the error/retry UI stays visible and usable; a
    // successful run leaves this active — the exam page's own mount
    // effect then carries it through to ready:true once policy/session
    // are confirmed, with no gap across the SPA navigation.
    window.sesLockdown?.setSecureClientEnforcementState?.({ active: true, ready: false, requireSingleDisplay: false });
    logClientTetherDiagnostic("exam_entry_cover_activated", { examId });
    try {
      const startRes = await fetch(`/api/exams/${examId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(code ? { accessCode: code } : {}), policyAcknowledged: true }),
      });
      if (!startRes.ok) {
        const body = await startRes.json().catch(() => null);
        setError(typeof body?.error === "string" ? body.error : "Failed to start exam.");
        uncoverOnFailure();
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
        // successful launch) — either way, POST /start has ALREADY made
        // the authoritative eligibility decision here (kind: "ALLOW" is
        // only ever returned once the server itself has confirmed a
        // verified session exists) — proceed straight into the exam,
        // exactly like the join page does.
        logClientTetherDiagnostic("NAVIGATION_ALLOWED", { examId, reason: "start_allow" });
        if (unmountedRef.current) return;
        router.replace(`/student/exams/${submission.id}`);
        return;
      }

      const launchRes = await fetch(`/api/submissions/${submission.id}/secure-client/launch`, { method: "POST" });
      if (!launchRes.ok) {
        const body = await launchRes.json().catch(() => null);
        setError(resolveTetherLaunchFailureMessage(typeof body?.code === "string" ? body.code : ""));
        uncoverOnFailure();
        return;
      }
      const { manifest, signature } = await launchRes.json();
      // manifestId only — never the nonce, signature, or full manifest
      // contents (the manifest is the launch token; see
      // secureLaunchManifest.ts's own doc comment on why the raw nonce
      // must never be persisted, let alone logged).
      logClientTetherDiagnostic("MANIFEST_ISSUED", { manifestId: manifest.manifestId, clientType: manifest.clientType });

      const consumeRes = await fetch(`/api/secure-client/launch/${manifest.manifestId}/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest, signature }),
      });
      if (!consumeRes.ok) {
        const body = await consumeRes.json().catch(() => null);
        setError(resolveTetherLaunchFailureMessage(typeof body?.code === "string" ? body.code : ""));
        uncoverOnFailure();
        return;
      }
      const consumed: { ok: boolean; sessionId?: string } = await consumeRes.json();
      logClientTetherDiagnostic("MANIFEST_CONSUMED", {
        outcome: "CONSUMED",
        hasSessionId: Boolean(consumed.sessionId),
      });

      // Corrective pass v1.2.2, Task 1/2 (real root cause) — consuming
      // the manifest only CREATES a secure-client session with
      // verificationStatus NOT_CHECKED; it does NOT verify it.
      // Verification only ever transitions to VERIFIED via
      // POST /api/secure-client/sessions/[sessionId]/attestation (see
      // recordAttestation in secureClientRunner.ts) — and nothing in the
      // real launch flow ever called it. Only the dev mock-client
      // simulator (src/app/dev/mock-secure-client/[id]/page.tsx) did,
      // which is why this defect was invisible in every prior automated
      // test and every dev-simulator smoke check: GET
      // /api/submissions/[id]'s TETHER_SESSION_REQUIRED gate (and the
      // identical check in POST /api/exams/[id]/start) both require
      // verificationStatus === "VERIFIED" — with no attestation ever
      // submitted, a real physical Tether launch could consume a
      // manifest successfully and still never pass that gate, bouncing
      // back to this page indefinitely without ever reaching a state
      // that reports a real deliveryMode/displayPolicy to the exam page.
      // Submits the one check this exam type actually implements
      // (displayCheck, via the already-exposed
      // window.sesLockdown.getDisplayCount() bridge) so a real launch
      // establishes verification the same way the mock simulator always
      // has.
      if (consumed.sessionId) {
        const attestationOutcome = await submitInitialAttestation(consumed.sessionId, submission.id);
        logClientTetherDiagnostic(attestationOutcome.submitted ? "launch_manifest_attestation_submitted" : "LEGACY_ATTESTATION_FAILED", {
          sessionId: consumed.sessionId,
          submitted: attestationOutcome.submitted,
        });
        // Secure Client Attestation v2 — see
        // docs/tether-system-check-v1.md, "Wiring installation attestation
        // into real exam sessions". Best-effort and additive: under the
        // safe default TETHER_EXAM_ATTESTATION_MODE=LEGACY this has zero
        // effect on whether the student can proceed (the legacy
        // attestation above remains the sole real gate) — it only records
        // genuine installation-bound evidence so DUAL/V2_REQUIRED can be
        // enabled later without every existing session lacking it. Never
        // blocks or delays entry into the exam on failure.
        await submitExamSessionAttestationV2(consumed.sessionId, submission.id);
      }

      // P0 secure-launch redirect loop hotfix — see
      // docs/tether-secure-launch-loop-hotfix.md. THE FIX: consuming a
      // manifest and submitting attestation only ever CREATES/ATTEMPTS
      // verification — it never guarantees the session actually reached
      // verificationStatus VERIFIED (attestation can fail outright, or
      // succeed but resolve to ACTION_REQUIRED/CANNOT_START, e.g. a
      // display-policy violation). Previously this function navigated
      // into the exam unconditionally at this point; GET
      // /api/submissions/[id]'s own TETHER_SESSION_REQUIRED gate would
      // then immediately bounce back here, and this page's mount effect
      // would auto-retry the exact same broken sequence — an infinite
      // Loading/Opening-your-exam cycle with no stable error state ever
      // shown, and the student never reaching camera/screen-share checks
      // (which only render once the exam page itself loads).
      //
      // The fix re-reads the SAME authoritative, already-computed
      // session state the real gate uses (GET
      // /api/submissions/[id]/secure-client/status's session.verificationStatus
      // — server-computed, never re-derived here) and only navigates
      // when it is exactly "VERIFIED". This never duplicates security
      // policy client-side: it is a read of the server's own decision,
      // not a new one.
      const verified = await checkAuthoritativeSessionVerified(submission.id);
      if (!verified) {
        logClientTetherDiagnostic("AUTHORITATIVE_SESSION_NOT_VERIFIED", { examId, submissionId: submission.id });
        setError('Tether could not verify this secure exam session. Select "Try again" below, or contact support if this continues.');
        uncoverOnFailure();
        return;
      }

      // Land directly in the exam; the Electron app's own live
      // display-enforcement (registered from app start, independent of
      // this page) takes over from here regardless of the one-time
      // attestation result above.
      logClientTetherDiagnostic("NAVIGATION_ALLOWED", { examId, reason: "authoritative_session_verified" });
      if (unmountedRef.current) return;
      router.replace(`/student/exams/${submission.id}`);
    } catch {
      // A thrown exception (network failure, etc.) rather than a
      // non-ok response — same fail-closed handling: never leave the
      // student stuck behind a permanent cover with no visible error or
      // retry option.
      setError("Failed to start exam. Check your connection and try again.");
      uncoverOnFailure();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Corrective pass v1.2.2, Task 1/2 — the missing verification step.
   * Fetches the same /secure-client/status endpoint the exam page uses
   * to learn whether this attempt's immutable policy actually requires
   * a display check, reports the current Electron display count for
   * that ONE check if so (feature-detected — never fails hard if an
   * older packaged install doesn't expose getDisplayCount), and submits
   * the attestation.
   *
   * P0 secure-launch redirect loop hotfix — this used to return
   * Promise<void> and never told its caller whether the HTTP submission
   * itself succeeded, let alone whether the resulting overallStatus was
   * actually READY. `runLaunchSequence` no longer needs that distinction
   * from THIS function directly (it now separately re-checks the
   * authoritative session.verificationStatus via
   * checkAuthoritativeSessionVerified below, which is the single source
   * of truth the real content gate also uses) — but `submitted` is still
   * returned so the caller can log a clear LEGACY_ATTESTATION_FAILED
   * diagnostic specifically for "the request itself never went through"
   * (network failure), distinct from "it went through but didn't verify"
   * (which the authoritative check below distinguishes on its own).
   * Never throws — a request failure here just means the session stays
   * unverified, which the authoritative check correctly detects.
   */
  async function submitInitialAttestation(sessionId: string, submissionId: string): Promise<{ submitted: boolean }> {
    try {
      const statusRes = await fetch(`/api/submissions/${submissionId}/secure-client/status`);
      const status = statusRes.ok ? await statusRes.json().catch(() => null) : null;
      const requireDisplayCheck = typeof status?.requireDisplayCheck === "boolean" ? status.requireDisplayCheck : false;

      const checks: Record<string, string> = {};
      if (requireDisplayCheck && typeof window.sesLockdown?.getDisplayCount === "function") {
        const displayCount = await window.sesLockdown.getDisplayCount();
        checks.displayCheck = displayCount <= 1 ? "PASS" : "FAIL";
      }

      const res = await fetch(`/api/secure-client/sessions/${sessionId}/attestation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: window.sesLockdown?.platform?.() ?? undefined,
          clientVersion: window.sesLockdown?.version ?? undefined,
          checks,
          required: requireDisplayCheck ? { displayCheck: true } : {},
        }),
      });
      const body = await res.json().catch(() => null);
      const overallStatus = typeof body?.overallStatus === "string" ? body.overallStatus : null;
      logClientTetherDiagnostic("secure_client_session_verified", { ok: res.ok, overallStatus });
      if (res.ok && overallStatus !== "READY") {
        logClientTetherDiagnostic("LEGACY_ATTESTATION_NOT_VERIFIED", { sessionId, overallStatus });
      }
      return { submitted: res.ok };
    } catch {
      logClientTetherDiagnostic("secure_client_session_verified", { ok: false, overallStatus: null });
      return { submitted: false };
    }
  }

  /**
   * P0 secure-launch redirect loop hotfix — the authoritative gate this
   * page must check before EVER navigating into exam content. Reads the
   * SAME server-computed field (SecureClientSession.verificationStatus,
   * via GET /api/submissions/[id]/secure-client/status) that GET
   * /api/submissions/[id]'s own TETHER_SESSION_REQUIRED check is based
   * on — never a second, client-derived approximation of that decision.
   * Fails CLOSED (returns false) on any network/parse error or missing
   * session, matching "NEVER navigate to exam content unless the server
   * confirms the secure client session satisfies the authoritative entry
   * gate."
   */
  async function checkAuthoritativeSessionVerified(submissionId: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/submissions/${submissionId}/secure-client/status`);
      if (!res.ok) return false;
      const body = await res.json();
      // The actual decision logic lives in isSecureClientSessionVerified
      // (src/lib/tetherLaunch.ts) — pure and unit-tested there — never
      // duplicated here.
      return isSecureClientSessionVerified(body);
    } catch {
      return false;
    }
  }

  /**
   * Secure Client Attestation v2 — see docs/tether-system-check-v1.md,
   * "Wiring installation attestation into real exam sessions". Registers
   * (if needed) this installation, requests a purpose=EXAM_SESSION
   * challenge bound to this exact session/exam/submission/policy, asks
   * Tether's main process to sign a canonical response over facts it
   * gathers itself (never a value this page supplies independently), and
   * submits it for verification. Every failure path here is silent by
   * design — an older packaged install simply won't expose
   * attestExamSession yet, and under the default LEGACY compatibility
   * mode this evidence has no bearing on whether the student can start
   * their exam.
   */
  async function submitExamSessionAttestationV2(sessionId: string, submissionId: string): Promise<void> {
    try {
      const installationId = await ensureRegisteredInstallation();
      if (!installationId || typeof window.sesLockdown?.attestExamSession !== "function") {
        logClientTetherDiagnostic("exam_session_attestation_v2_skipped", { reason: !installationId ? "INSTALLATION_UNAVAILABLE" : "ATTESTATION_UNAVAILABLE" });
        return;
      }

      const challengeRes = await fetch("/api/tether/exam-session/attestation/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId, submissionId }),
      });
      if (!challengeRes.ok) {
        logClientTetherDiagnostic("exam_session_attestation_v2_skipped", { reason: "CHALLENGE_FAILED" });
        return;
      }
      const { challenge, signature: challengeSignature } = await challengeRes.json();

      const attestation = await window.sesLockdown.attestExamSession({
        nonce: challenge.nonce,
        examId: challenge.examId,
        submissionId: challenge.submissionId,
        policyHash: challenge.policyHash,
        secureClientSessionId: challenge.secureClientSessionId,
      });
      if (!attestation) {
        logClientTetherDiagnostic("exam_session_attestation_v2_skipped", { reason: "ATTESTATION_FAILED" });
        return;
      }

      const verifyRes = await fetch("/api/tether/exam-session/attestation/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge,
          challengeSignature,
          installationSignature: attestation.signature,
          clientVersion: attestation.clientVersion,
          platform: attestation.platform,
          displayTopologyClassification: attestation.displayTopologyClassification,
          displayCount: attestation.displayCount,
          capabilities: attestation.capabilities,
          timestamp: attestation.timestamp,
        }),
      });
      const body = await verifyRes.json().catch(() => null);
      logClientTetherDiagnostic("exam_session_attestation_v2_result", { sessionId, verified: verifyRes.ok && body?.verified === true });
    } catch {
      logClientTetherDiagnostic("exam_session_attestation_v2_skipped", { reason: "EXCEPTION" });
    }
  }

  /** Task 3 — un-cover only on a definitive launch failure, so the error/retry UI on this page is visible and usable. There is no exam content to protect yet at this point; re-clicking Start/Continue re-arms the cover from the top of runLaunchSequence. */
  function uncoverOnFailure() {
    window.sesLockdown?.setSecureClientEnforcementState?.({ active: false, ready: false, requireSingleDisplay: false });
    // Part 10 — "failed exam launch" / "failed attestation" is one of
    // the explicit restoration triggers; safe to call even though
    // nothing lockdown-specific may have activated yet this attempt (see
    // lockdownLifecycle.ts's own idempotency doc comment).
    window.sesLockdown?.restoreLockdownControls?.("launch-failure");
    logClientTetherDiagnostic("exam_entry_cover_released_on_failure", { examId });
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

  // Secure-recovery hardening v1, Part B — takes priority over the
  // busy/auto-relaunch view below: no relaunch was ever attempted from
  // this page for this submission (checkManualReviewRequired ran before
  // runLaunchSequence could be called), so exam content stays blocked
  // and no further automatic action happens here.
  if (manualReview) {
    return <ManualReviewNotice />;
  }

  // Part 3 — takes priority for the same reason as manualReview above:
  // no launch/relaunch was attempted while a blocking capability was
  // detected or process inspection could not be verified.
  if (lockdownBlocked) {
    return <LockdownApplicationCheck state="BLOCKED" applicationNames={lockdownBlocked} onCheckAgain={checkLockdownAgain} checking={lockdownChecking} />;
  }
  if (lockdownUnavailable) {
    return <LockdownApplicationCheck state="UNAVAILABLE" onCheckAgain={checkLockdownAgain} checking={lockdownChecking} />;
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
        onClick={() =>
          void checkLockdownPreflight(accessCode || null, result.exam.assessmentType === "FINAL_EXAMINATION").then((ok) => {
            if (ok) void runLaunchSequence(accessCode || null);
          })
        }
        disabled={busy || lockdownChecking || !policyAcknowledged || (result.exam.accessCodeRequired && !accessCode.trim())}
        className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? "Starting..." : lockdownChecking ? "Checking…" : "Start exam"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
