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
 *    true): v1.7.4 pre-exam readiness two-phase lifecycle (see
 *    docs/tether-preflight-lifecycle-v1.7.4.md):
 *
 *      PHASE 1 — PRE-EXAM READINESS: runs the access-check -> policy-
 *      acknowledgement screen, then (on Start exam / auto-resume) a
 *      calm, in-page PRECHECK of every mandatory native condition
 *      (prohibited applications, remote session, display topology) with
 *      NO strict overlay and NO submission/timer created yet. A failed
 *      check shows a factual remediation screen (Task Manager, Alt+Tab,
 *      Windows display settings all remain fully usable) with a
 *      Recheck button. Only once every mandatory check passes does an
 *      explicit "Ready to begin — Begin examination" screen appear
 *      (never an auto-start).
 *
 *      PHASE 2 — SECURE ACTIVATION: only after Begin examination is
 *      selected — POST /start (creates/resumes the submission, but for
 *      a gated exam its activatedAt stays null: no timer, no question
 *      content yet — see src/lib/secureClientActivation.ts) -> issue/
 *      consume the signed launch manifest -> submit genuine client
 *      attestation -> require server verificationStatus VERIFIED -> a
 *      FRESH native pre-activation check (closes the race where
 *      TeamViewer/a second display appears between PRECHECK and Begin
 *      examination) -> window.sesLockdown.activateSecureExamLockdown()
 *      (the real native lockdown ACTIVATE+ACKNOWLEDGE handshake — never
 *      a client-trusted boolean) -> only once that succeeds, POST
 *      /api/submissions/[id]/activate (the authoritative SERVER
 *      activation — this is what actually starts the timer and unlocks
 *      question content server-side) -> only then does this page
 *      navigate into the exam. The student never returns to the
 *      dashboard to find it themselves.
 */

import { useEffect, useRef, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import { isRunningInLockdownBrowser } from "@/lib/lockdownDetection";
import {
  buildTetherDeepLink,
  shouldShowInstallerFallback,
  resolveTetherLaunchFailureMessage,
  isSecureClientSessionVerified,
  classifyDisplayBridgeAvailability,
  buildDisplayInvokeFailedDiagnostic,
  resolveDisplayPreflightIssue,
  resolveActivationFailureIssue,
  type DisplayDiagnostic,
  type PreflightIssue,
} from "@/lib/tetherLaunch";
import { logClientTetherDiagnostic } from "@/lib/tetherDiagnosticLog";
import { ensureRegisteredInstallation } from "@/lib/secureClient/installationClient";
import { ManualReviewNotice } from "@/components/ManualReviewNotice";
import { LockdownApplicationCheck } from "@/components/LockdownApplicationCheck";
import { ensureLockdownBridgeInitialized, type LockdownCapabilityInfo } from "@/lib/lockdownClient";
import { isValidReportedDisplayCount } from "@/lib/secureClient/attestation";

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

// v1.7.4 pre-exam readiness — computed from the exam's CURRENT settings
// (no per-attempt frozen snapshot exists before /start — see
// GET /api/exams/[id]/access-check's own doc comment), used only to
// decide which mandatory native PRECHECK conditions apply before Begin
// examination is ever shown.
type SecurePreflightSummary = {
  requiresSecureClient: boolean;
  requireDisplayCheck: boolean;
  displayPolicy: string;
  requireRemoteSessionCheck: boolean;
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
      securePreflight: SecurePreflightSummary;
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
// Inside Tether — v1.7.4 two-phase lifecycle: PRECHECK -> Ready to begin
// -> Begin examination -> secure activation -> exam content.
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

  // v1.7.4 pre-exam readiness — PHASE 1 PRECHECK state. `precheckIssue`
  // unifies every possible mandatory-condition failure (prohibited
  // application, remote session, display topology) into one calm,
  // factual remediation screen — see LockdownApplicationCheck.tsx and
  // resolveActivationFailureIssue/resolveDisplayPreflightIssue in
  // tetherLaunch.ts. `precheckPassed` gates the explicit "Ready to
  // begin — Begin examination" screen: precheck becoming clean NEVER
  // auto-starts the exam on its own.
  const [precheckIssue, setPrecheckIssue] = useState<PreflightIssue | null>(null);
  const [precheckPassed, setPrecheckPassed] = useState(false);
  const [precheckChecking, setPrecheckChecking] = useState(false);
  const pendingLaunchCodeRef = useRef<string | null>(null);
  const pendingIsFinalExamRef = useRef(false);
  const pendingSecurePreflightRef = useRef<SecurePreflightSummary | null>(null);
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
   * v1.7.4 pre-exam readiness — PHASE 1 PRECHECK. Runs EVERY mandatory
   * native condition this exam's policy requires (Part 1): prohibited
   * applications/processes (incl. TeamViewer), remote session, and now
   * display topology (Part 8) — extended from the pre-v1.7.4
   * checkLockdownPreflight, which covered only the first two. No
   * submission is created and no timer starts here — this may run any
   * number of times (Recheck) with zero side effects beyond the reads
   * themselves. Fails OPEN only when the installed build predates the
   * relevant bridge method entirely (feature-detected, exactly like
   * every other optional bridge method) — existing installations are
   * never broken by this addition; the REAL, non-bypassable enforcement
   * remains Phase 2's fresh native check + server-side activation gate.
   */
  async function runPrecheck(code: string | null, isFinalExamination: boolean, securePreflight: SecurePreflightSummary): Promise<boolean> {
    pendingLaunchCodeRef.current = code;
    pendingIsFinalExamRef.current = isFinalExamination;
    pendingSecurePreflightRef.current = securePreflight;
    setPrecheckChecking(true);
    try {
      if (typeof window.sesLockdown?.runLockdownPreflightScan !== "function") {
        setPrecheckIssue(null);
        return true;
      }
      lockdownCapabilityInfoRef.current = await ensureLockdownBridgeInitialized();
      const scan = await window.sesLockdown.runLockdownPreflightScan();
      if (scan.state === "BLOCKED") {
        const names = scan.matchedCapabilityIds.map((capId) => lockdownCapabilityInfoRef.current?.get(capId)?.displayName ?? "an application");
        setPrecheckIssue({
          title: "Close applications before continuing",
          message:
            "Tether found applications that may allow screen sharing, remote access, recording or debugging. Close the listed applications, then select Recheck.",
          applicationNames: [...new Set(names)],
        });
        window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_PREFLIGHT_BLOCKED", { examId, capabilityCount: scan.matchedCapabilityIds.length });
        return false;
      }
      if (scan.state === "UNAVAILABLE") {
        setPrecheckIssue({
          title: "Application check could not be completed",
          message: "Tether could not verify that prohibited applications are closed. Restart Tether or contact exam support.",
        });
        window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_PROCESS_INSPECTION_UNAVAILABLE", { examId, reason: scan.reason });
        return false;
      }

      // Part 5 — "fail closed for final examinations when remote-session
      // state cannot be safely resolved and policy requires it; ordinary
      // non-final assessments must remain unchanged unless configured."
      // Extended (unchanged reasoning) to also cover an exam whose
      // frozen-equivalent policy explicitly requires it regardless of
      // assessment type.
      if (isFinalExamination || securePreflight.requireRemoteSessionCheck) {
        const session = await window.sesLockdown?.getRemoteSessionStatus?.();
        if (!session || session.remoteSessionSignalSource === "UNAVAILABLE") {
          setPrecheckIssue({
            title: "Remote session check could not be completed",
            message: "Tether could not verify the remote-session status of this computer. Restart Tether or contact exam support.",
          });
          window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_REMOTE_SESSION_CHECK_FAILED_CLOSED", { examId });
          return false;
        }
        if (session.isRemoteSession) {
          setPrecheckIssue({
            title: "Remote Desktop session detected",
            message: "This computer is connected to over Remote Desktop. End the remote session, then select Recheck.",
          });
          window.sesLockdown?.reportLockdownAuditFact?.("TETHER_LOCKDOWN_PREFLIGHT_BLOCKED", { examId, capabilityCount: 1, reason: "REMOTE_SESSION" });
          return false;
        }
      }

      // Part 8 — fresh native display-topology read, factual reporting
      // only. Read-only (getDisplayTopology never toggles any
      // enforcement/overlay state on its own — see
      // apps/lockdown/src/displayEnforcement.ts's own doc comment).
      if (securePreflight.requireDisplayCheck) {
        if (typeof window.sesLockdown?.getDisplayTopology === "function") {
          const topology = await window.sesLockdown.getDisplayTopology();
          const issue = resolveDisplayPreflightIssue(topology.electronDisplayCount, topology.classification);
          if (issue) {
            setPrecheckIssue(issue);
            return false;
          }
        }
        // getDisplayTopology missing entirely (a build old enough to
        // predate it) fails OPEN here, exactly like every other optional
        // bridge method above — Phase 2's fresh native check and the
        // server-side content gate remain the real, non-bypassable
        // enforcement for the display requirement.
      }

      setPrecheckIssue(null);
      return true;
    } finally {
      setPrecheckChecking(false);
    }
  }

  function recheckPrecheck() {
    void runPrecheck(pendingLaunchCodeRef.current, pendingIsFinalExamRef.current, pendingSecurePreflightRef.current!).then((ok) => {
      if (ok) setPrecheckPassed(true);
    });
  }

  useEffect(() => {
    fetch(`/api/exams/${examId}/access-check`)
      .then((res) => res.json())
      .then(async (data: AccessCheckResult) => {
        setResult(data);
        // Already has a submission — no need to show the acknowledgement
        // screen again; go straight into the precheck/relaunch sequence,
        // unless the authoritative recovery state says this attempt
        // requires manual review first.
        if (data.ok && data.existingSubmission?.status === "IN_PROGRESS" && !autoAttemptedRef.current) {
          const requiresManualReview = await checkManualReviewRequired(data.existingSubmission.id);
          if (requiresManualReview) {
            logClientTetherDiagnostic("RECOVERY_REQUIRED", { examId, submissionId: data.existingSubmission.id });
            setManualReview(true);
            return;
          }
          const precheckOk = await runPrecheck(null, data.exam.assessmentType === "FINAL_EXAMINATION", data.securePreflight);
          if (!precheckOk) return;
          if (unmountedRef.current) return;
          autoAttemptedRef.current = true;
          // A RESUME never shows the explicit "Ready to begin" screen —
          // it goes straight back into the (already-consented-to) attempt.
          // Phase 2's fresh native check + activation handshake inside
          // runLaunchSequence still runs unconditionally (Part 6: native
          // lockdown must be restored/confirmed before content is
          // exposed again after a reload/restart).
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
   * src/app/dev/mock-secure-client/[id]/page.tsx — then (v1.7.4) runs
   * the full Phase 2 secure-activation handshake before ever navigating
   * into content.
   *
   * v1.7.4 pre-exam readiness — this function NO LONGER covers the exam
   * window the instant it starts running (the pre-v1.7.4
   * setSecureClientEnforcementState({active:true,ready:false}) call is
   * gone). That old mechanism existed because content used to become
   * reachable the moment this page navigated to it; now content is
   * genuinely unreachable server-side (isSubmissionContentAccessible)
   * until POST /activate succeeds, and native lockdown itself only ever
   * activates atomically, inside ensureSecureActivation, once every
   * fresh check has already passed — there is no longer a "loading"
   * window that needs a temporary cover, and removing it also removes
   * the confirmed BLOCKED==ADDITIONAL_DISPLAY_PRESENT false-positive
   * this whole pass fixes (POLICY_NOT_READY can no longer appear on this
   * page's own transition into the exam).
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

      if (!submission.secureClientLaunch?.required) {
        // This exam doesn't require Tether after all (shouldn't normally
        // reach this page in that case, but harmless) — nothing to
        // activate; proceed straight into the exam exactly like the join
        // page does.
        logClientTetherDiagnostic("NAVIGATION_ALLOWED", { examId, reason: "start_allow" });
        if (unmountedRef.current) return;
        router.replace(`/student/exams/${submission.id}`);
        return;
      }

      let verified = submission.secureClientLaunch.kind === "ALLOW";
      if (!verified) {
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
        logClientTetherDiagnostic("MANIFEST_ISSUED", { manifestId: manifest.manifestId, clientType: manifest.clientType });

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
        logClientTetherDiagnostic("MANIFEST_CONSUMED", {
          outcome: "CONSUMED",
          hasSessionId: Boolean(consumed.sessionId),
        });

        // Corrective pass v1.2.2, Task 1/2 (real root cause) — consuming
        // the manifest only CREATES a secure-client session with
        // verificationStatus NOT_CHECKED; it does NOT verify it.
        // Verification only ever transitions to VERIFIED via
        // POST /api/secure-client/sessions/[sessionId]/attestation (see
        // recordAttestation in secureClientRunner.ts).
        if (consumed.sessionId) {
          const attestationOutcome = await submitInitialAttestation(consumed.sessionId, submission.id);
          logClientTetherDiagnostic(attestationOutcome.submitted ? "launch_manifest_attestation_submitted" : "LEGACY_ATTESTATION_FAILED", {
            sessionId: consumed.sessionId,
            submitted: attestationOutcome.submitted,
          });
          // Secure Client Attestation v2 — see
          // docs/tether-system-check-v1.md, "Wiring installation attestation
          // into real exam sessions". Best-effort and additive.
          await submitExamSessionAttestationV2(consumed.sessionId, submission.id);
        }

        verified = await checkAuthoritativeSessionVerified(submission.id);
      }

      if (!verified) {
        logClientTetherDiagnostic("AUTHORITATIVE_SESSION_NOT_VERIFIED", { examId, submissionId: submission.id });
        setError('Tether could not verify this secure exam session. Select "Try again" below, or contact support if this continues.');
        return;
      }

      // v1.7.4 pre-exam readiness — PHASE 2, steps E-I. Runs
      // unconditionally once verified, whether verification came from
      // the fast ALLOW path (a resumed, already-verified session — Part
      // 6) or the manifest/attestation sequence just above. This is the
      // ONLY place native lockdown is ever activated, and the ONLY place
      // the server's authoritative timer/content activation is ever
      // requested.
      const activated = await ensureSecureActivation(submission.id);
      if (!activated) return;

      logClientTetherDiagnostic("NAVIGATION_ALLOWED", { examId, reason: "authoritative_session_verified_and_activated" });
      if (unmountedRef.current) return;
      router.replace(`/student/exams/${submission.id}`);
    } catch {
      // A thrown exception (network failure, etc.) rather than a
      // non-ok response — same fail-closed handling: never leave the
      // student stuck behind a permanent cover with no visible error or
      // retry option.
      setError("Failed to start exam. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * v1.7.4 pre-exam readiness — PHASE 2, steps E-I (the required
   * ordering: fresh native checks -> native lockdown ACTIVE confirmed ->
   * server activates timed attempt). Returns true only once BOTH the
   * native handshake and the server activation call have genuinely
   * succeeded. Never trusts a client-side boolean on its own: the native
   * result comes from window.sesLockdown.activateSecureExamLockdown()
   * (which itself re-runs fresh checks natively — see
   * apps/lockdown/src/main.ts), and the server call
   * (POST /api/submissions/[id]/activate) independently re-derives its
   * own eligibility from the authoritative VERIFIED secure-client
   * session — this function's only job is sequencing, never trust.
   */
  async function ensureSecureActivation(submissionId: string): Promise<boolean> {
    const statusRes = await fetch(`/api/submissions/${submissionId}/secure-client/status`);
    const status = statusRes.ok ? await statusRes.json().catch(() => null) : null;
    const requireSingleDisplay = status?.displayRequirement?.status === "ENFORCED_BY_SECURE_CLIENT";
    const requireRemoteSessionCheck = status?.requireRemoteSessionCheck === true;

    if (typeof window.sesLockdown?.activateSecureExamLockdown !== "function") {
      // A build old enough to predate the whole v1.7.4 activation
      // handshake — fail closed. This is the crux of the security
      // model, unlike the diagnostic/optional bridge methods elsewhere
      // on this page, so there is no "fail open for an old build" path
      // here.
      setError("This version of Tether Secure Browser does not support the required secure activation step. Please update Tether Secure Browser.");
      return false;
    }

    const activation = await window.sesLockdown.activateSecureExamLockdown({ requireSingleDisplay, requireRemoteSessionCheck });
    logClientTetherDiagnostic("secure_activation_native_result", { submissionId, ok: activation.ok });
    if (!activation.ok) {
      // A fresh check caught something the earlier calm PRECHECK didn't
      // (Part 6/E — TeamViewer or a second display appearing in the gap
      // between PRECHECK and Begin examination). Never navigate; show
      // the SAME calm remediation screen, and let the student return
      // through Recheck -> Begin examination again from the top — no
      // submission timer was ever started for a fresh attempt (an
      // already-activated resume's timer was already running before
      // this call, and stays exactly where it was — this failure only
      // withholds content, it never rewinds or extends anything).
      const capabilityDisplayNames = lockdownCapabilityInfoRef.current
        ? new Map([...lockdownCapabilityInfoRef.current].map(([capId, info]) => [capId, info.displayName]))
        : undefined;
      const issue = resolveActivationFailureIssue(activation, capabilityDisplayNames);
      setPrecheckIssue(issue);
      setPrecheckPassed(false);
      return false;
    }

    const activateRes = await fetch(`/api/submissions/${submissionId}/activate`, { method: "POST" });
    if (!activateRes.ok) {
      const body = await activateRes.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : "Tether could not activate this secure exam session. Select \"Try again\" below.");
      return false;
    }
    return true;
  }

  /**
   * P0 secure-launch redirect loop hotfix — the missing verification
   * step. Fetches the same /secure-client/status endpoint the exam page
   * uses to learn whether this attempt's immutable policy actually
   * requires a display check, reports the current Electron display count
   * for that ONE check if so (feature-detected — never fails hard if an
   * older packaged install doesn't expose getDisplayCount), and submits
   * the attestation. Never throws — a request failure here just means
   * the session stays unverified, which the authoritative check below
   * detects.
   */
  async function submitInitialAttestation(sessionId: string, submissionId: string): Promise<{ submitted: boolean }> {
    try {
      const statusRes = await fetch(`/api/submissions/${submissionId}/secure-client/status`);
      const status = statusRes.ok ? await statusRes.json().catch(() => null) : null;
      const requireDisplayCheck = typeof status?.requireDisplayCheck === "boolean" ? status.requireDisplayCheck : false;

      // P0 runtime display-bridge failure capture — see
      // docs/tether-secure-launch-verification-investigation.md. Five
      // mutually-exclusive, conclusive outcomes.
      const checks: Record<string, string> = {};
      let resolvedDisplayCount: number | null = null;
      let displayDiagnostic: DisplayDiagnostic | null = null;
      if (requireDisplayCheck) {
        const availability = classifyDisplayBridgeAvailability(window.sesLockdown);
        if (availability === "SES_LOCKDOWN_UNAVAILABLE" || availability === "DISPLAY_COUNT_METHOD_UNAVAILABLE") {
          displayDiagnostic = { outcome: availability };
        } else {
          try {
            // Bridge existence already confirmed by classifyDisplayBridgeAvailability
            // above — non-null assertion is safe here, never re-derived.
            const rawDisplayCount = await window.sesLockdown!.getDisplayCount!();
            if (isValidReportedDisplayCount(rawDisplayCount)) {
              checks.displayCheck = rawDisplayCount <= 1 ? "PASS" : "FAIL";
              resolvedDisplayCount = rawDisplayCount;
              displayDiagnostic = { outcome: "DISPLAY_COUNT_OK" };
            } else {
              displayDiagnostic = { outcome: "DISPLAY_COUNT_INVALID_RESULT" };
            }
          } catch (err) {
            displayDiagnostic = buildDisplayInvokeFailedDiagnostic(err);
          }
        }
        logClientTetherDiagnostic(displayDiagnostic.outcome, { sessionId, ...displayDiagnostic });
      }

      const res = await fetch(`/api/secure-client/sessions/${sessionId}/attestation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: window.sesLockdown?.platform?.() ?? undefined,
          clientVersion: window.sesLockdown?.version ?? undefined,
          checks,
          required: requireDisplayCheck ? { displayCheck: true } : {},
          displayCount: resolvedDisplayCount ?? undefined,
          displayDiagnostic: displayDiagnostic ?? undefined,
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
   * session.
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

  // Secure-recovery hardening v1, Part B — takes priority over every
  // other view below: no relaunch/precheck was ever attempted for this
  // submission.
  if (manualReview) {
    return <ManualReviewNotice />;
  }

  // v1.7.4 pre-exam readiness — PHASE 1 remediation screen. Plain page
  // content: no screen-saver-level overlay, Task Manager/Alt+Tab/Windows
  // display settings all remain fully usable, no submission/timer exists
  // yet for a fresh attempt.
  if (precheckIssue) {
    return (
      <LockdownApplicationCheck
        title={precheckIssue.title}
        message={precheckIssue.message}
        applicationNames={precheckIssue.applicationNames}
        onCheckAgain={recheckPrecheck}
        checking={precheckChecking}
      />
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
            {/* P0 retest fix — this button retries the launch/attestation
                sequence itself, not an installer re-check; "I have
                installed it — open examination" (copied from the
                OutsideTetherPrompt installer-fallback flow, where it's
                correct) was misleading here — the student is already
                inside Tether and installation was never in question. */}
            <button
              onClick={() => void runLaunchSequence(accessCode || null)}
              className="mt-2 block w-full rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-800"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  // v1.7.4 pre-exam readiness — the explicit "Ready to begin" screen.
  // Precheck becoming clean NEVER auto-starts the exam — the student
  // must take this one deliberate action, which is what actually kicks
  // off Phase 2 (secure activation, native lockdown, then content).
  if (precheckPassed) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
        <h1 className="text-lg font-medium">Ready to begin</h1>
        <p className="mt-3 text-sm text-gray-700">
          {result.exam.title} — every required check has passed. Selecting Begin examination will activate secure
          lockdown and start your exam timer.
        </p>
        <button
          onClick={() => void runLaunchSequence(accessCode || null)}
          disabled={busy}
          className="mt-5 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Begin examination
        </button>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
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
          void runPrecheck(accessCode || null, result.exam.assessmentType === "FINAL_EXAMINATION", result.securePreflight).then((ok) => {
            if (ok) setPrecheckPassed(true);
          })
        }
        disabled={busy || precheckChecking || !policyAcknowledged || (result.exam.accessCodeRequired && !accessCode.trim())}
        className="mt-4 w-full rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {precheckChecking ? "Checking…" : "Start exam"}
      </button>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
