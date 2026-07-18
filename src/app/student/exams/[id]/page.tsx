"use client";

import { useCallback, useEffect, useRef, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import {
  isFinalizedSubmissionStatus,
  remainingSeconds,
  shouldAutoSubmit,
  shouldRunExamTimer,
} from "@/lib/assessmentLifecycle";
import { isRunningInLockdownBrowser } from "@/lib/lockdownDetection";
import {
  classifyFrameQuality,
  computeLuminanceVariance,
  computeNextDetectionDelayMs,
  evaluatePersonDetections,
  evaluatePhoneDetections,
  decidePhoneEmission,
  decideSecondPersonEmission,
  decideNoPersonEmission,
  decideFrameQualityEmission,
  shouldLogAiCameraDebug,
  DetectionCooldownTracker,
  PHONE_CONFIDENCE_THRESHOLD,
  isVideoFrameReady,
  shouldSuppressCameraIntegrityDuringStartup,
  cameraStartupPhase,
  type CameraStartupPhase,
  type DetectedObject,
} from "@/lib/cameraIntegrityDetection";
import { loadCameraObjectDetector, type CameraObjectDetector } from "@/lib/cameraObjectDetector";
import {
  clearAiCameraViolationOverlay,
  computeLocalAiCameraOverlay,
  handleAiCameraIntegrityReport,
  type AiCameraViolationOverlayState,
} from "@/lib/aiCameraViolationOverlay";
import {
  buildEvidenceFrameUploadPath,
  evidenceUploadSkipReason,
  isEvidenceFrameSourceReady,
  isEvidenceCaptureEligibleEventType,
  shouldAttemptEvidenceUpload,
  shouldLogEvidenceUploadDebug,
} from "@/lib/aiCameraEvidenceFrame";
import { ExamWatermark } from "@/components/ExamWatermark";

type Question = {
  id: string;
  type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
  text: string;
  options: string[] | null;
  points: number;
};

type Answer = {
  questionId: string;
  response: string | null;
  score?: number;
  feedback?: string;
};

type SecureSettings = {
  secureModeEnabled: boolean;
  requireFullscreen: boolean;
  blockCopyPaste: boolean;
  blockRightClick: boolean;
  trackWindowBlur: boolean;
  autoSubmitOnTimerEnd: boolean;
  allowLateSubmit: boolean;
  maxAttempts: number;
  showIntegrityWarningToStudent: boolean;
  requireCamera: boolean;
  showCameraPreview: boolean;
  cameraHeartbeatEnabled: boolean;
  cameraHeartbeatIntervalSeconds: number;
  recordCameraUnavailableEvents: boolean;
  blockKeyboardShortcuts: boolean;
  disableQuestionTextSelection: boolean;
  enforceFullscreenReturn: boolean;
  requireStudentVerification: boolean;
  enableAiCameraIntegrityChecks: boolean;
  captureAiViolationEvidence: boolean;
  enableExamWatermark: boolean;
  oneQuestionAtATime: boolean;
  allowBackNavigation: boolean;
  randomiseQuestionOrder: boolean;
  randomiseMcqOptionOrder: boolean;
};

type SubmissionData = {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
  attemptNumber: number;
  deadline: string;
  totalScore: number | null;
  marksReleased: boolean;
  marksReleasedAt: string | null;
  exam: {
    id: string;
    title: string;
    questions: Question[];
    totalQuestions: number;
    secureSettings: SecureSettings;
  };
  answers: Answer[];
  student: { id: string; name: string; email: string; institutionStudentId: string | null };
};

// One-Question-At-A-Time Exam Delivery v1 — the payload shape returned by
// GET/POST /api/submissions/[id]/question(-progress). Never includes
// other questions, correctAnswer, or the raw questionOrderJson.
type OneQuestionPayload = {
  currentIndex: number;
  totalQuestions: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  question: {
    id: string;
    type: "MULTIPLE_CHOICE" | "SHORT_ANSWER" | "ESSAY";
    text: string;
    options: string[] | null;
    points: number;
  };
  existingResponse: string | null;
};

type IntegrityEventType =
  | "FULLSCREEN_EXIT"
  | "WINDOW_BLUR"
  | "WINDOW_FOCUS_RETURN"
  | "COPY_ATTEMPT"
  | "PASTE_ATTEMPT"
  | "RIGHT_CLICK_ATTEMPT"
  | "NETWORK_OFFLINE"
  | "NETWORK_ONLINE"
  | "AUTOSAVE_FAILED"
  | "TIMER_EXPIRED"
  | "CAMERA_PERMISSION_GRANTED"
  | "CAMERA_PERMISSION_DENIED"
  | "CAMERA_STARTED"
  | "CAMERA_STOPPED"
  | "CAMERA_UNAVAILABLE"
  | "CAMERA_HEARTBEAT_MISSED"
  | "CAMERA_PRECHECK_FAILED"
  | "KEYBOARD_SHORTCUT_BLOCKED"
  | "FULLSCREEN_FORCED_RETURN"
  | "STUDENT_VERIFICATION_CONFIRMED"
  | "POSSIBLE_PHONE_VISIBLE"
  | "POSSIBLE_SECOND_PERSON_VISIBLE"
  | "NO_PERSON_VISIBLE"
  | "CAMERA_VIEW_BLOCKED"
  | "CAMERA_TOO_DARK"
  | "AI_CAMERA_CHECK_UNAVAILABLE";

type IntegritySeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

const DEBOUNCE_MS: Partial<Record<IntegrityEventType, number>> = {
  WINDOW_BLUR: 10_000,
  COPY_ATTEMPT: 5_000,
  PASTE_ATTEMPT: 5_000,
  AUTOSAVE_FAILED: 10_000,
  KEYBOARD_SHORTCUT_BLOCKED: 5_000,
  CAMERA_HEARTBEAT_MISSED: 5_000,
  CAMERA_UNAVAILABLE: 5_000,
  POSSIBLE_PHONE_VISIBLE: 45_000,
  POSSIBLE_SECOND_PERSON_VISIBLE: 45_000,
  NO_PERSON_VISIBLE: 45_000,
  CAMERA_VIEW_BLOCKED: 60_000,
  CAMERA_TOO_DARK: 60_000,
  AI_CAMERA_CHECK_UNAVAILABLE: 60_000,
};

const MESSAGES: Record<IntegrityEventType, string> = {
  FULLSCREEN_EXIT: "You exited fullscreen mode.",
  WINDOW_BLUR: "You switched away from the exam window.",
  WINDOW_FOCUS_RETURN: "You returned to the exam window.",
  COPY_ATTEMPT: "A copy action was attempted.",
  PASTE_ATTEMPT: "A paste action was attempted.",
  RIGHT_CLICK_ATTEMPT: "A right-click was attempted.",
  NETWORK_OFFLINE: "Your connection appears to be offline.",
  NETWORK_ONLINE: "Your connection is back online.",
  AUTOSAVE_FAILED: "A save attempt failed and was retried.",
  TIMER_EXPIRED: "The exam timer has expired.",
  CAMERA_PERMISSION_GRANTED: "Camera permission was granted.",
  CAMERA_PERMISSION_DENIED: "Camera permission was denied.",
  CAMERA_STARTED: "Camera monitoring started.",
  CAMERA_STOPPED: "Camera monitoring stopped.",
  CAMERA_UNAVAILABLE: "Your camera became unavailable.",
  CAMERA_HEARTBEAT_MISSED: "A camera check did not receive a response.",
  CAMERA_PRECHECK_FAILED: "The camera pre-check failed.",
  KEYBOARD_SHORTCUT_BLOCKED: "A keyboard shortcut was blocked.",
  FULLSCREEN_FORCED_RETURN: "Fullscreen mode was restored.",
  STUDENT_VERIFICATION_CONFIRMED: "Student confirmed identity before starting the exam.",
  POSSIBLE_PHONE_VISIBLE: "Possible mobile phone visible in camera view. Lecturer review required.",
  POSSIBLE_SECOND_PERSON_VISIBLE:
    "Possible additional person visible in camera view. Lecturer review required.",
  NO_PERSON_VISIBLE: "No student appears visible in the camera view. Lecturer review required.",
  CAMERA_VIEW_BLOCKED: "Camera view appears blocked or covered. Lecturer review required.",
  CAMERA_TOO_DARK: "Camera view appears too dark or unusable. Lecturer review required.",
  AI_CAMERA_CHECK_UNAVAILABLE: "On-device camera integrity checks are unavailable.",
};

function severityFor(eventType: IntegrityEventType, settings: SecureSettings): IntegritySeverity {
  switch (eventType) {
    case "FULLSCREEN_EXIT":
      return settings.requireFullscreen ? "HIGH" : "MEDIUM";
    case "WINDOW_BLUR":
      return "MEDIUM";
    case "WINDOW_FOCUS_RETURN":
      return "INFO";
    case "COPY_ATTEMPT":
    case "PASTE_ATTEMPT":
      return settings.blockCopyPaste ? "MEDIUM" : "LOW";
    case "RIGHT_CLICK_ATTEMPT":
      return settings.blockRightClick ? "MEDIUM" : "LOW";
    case "NETWORK_OFFLINE":
      return "MEDIUM";
    case "NETWORK_ONLINE":
      return "INFO";
    case "AUTOSAVE_FAILED":
      return "MEDIUM";
    case "TIMER_EXPIRED":
      return "HIGH";
    case "CAMERA_PERMISSION_GRANTED":
    case "CAMERA_STARTED":
      return "INFO";
    case "CAMERA_PERMISSION_DENIED":
    case "CAMERA_STOPPED":
    case "CAMERA_UNAVAILABLE":
    case "CAMERA_PRECHECK_FAILED":
      return settings.requireCamera ? "HIGH" : "MEDIUM";
    case "CAMERA_HEARTBEAT_MISSED":
      return "MEDIUM";
    case "KEYBOARD_SHORTCUT_BLOCKED":
      return "INFO";
    case "FULLSCREEN_FORCED_RETURN":
      return "LOW";
    // --- Optional Student Verification + On-Device AI Camera Integrity
    // Detection v1 — see docs/on-device-ai-integrity-detection-v1.md.
    case "STUDENT_VERIFICATION_CONFIRMED":
      return "INFO";
    case "POSSIBLE_PHONE_VISIBLE":
    case "POSSIBLE_SECOND_PERSON_VISIBLE":
    case "NO_PERSON_VISIBLE":
    case "CAMERA_VIEW_BLOCKED":
      return "MEDIUM";
    case "CAMERA_TOO_DARK":
      return "LOW";
    case "AI_CAMERA_CHECK_UNAVAILABLE":
      return "INFO";
  }
}

// Best-effort keyboard shortcut blocking. This cannot guarantee blocking of
// browser- or OS-reserved shortcuts (e.g. Ctrl+Tab) — see
// docs/secure-exam-threat-model.md ("Browser-Level Friction v1").
function isBlockableShortcut(e: KeyboardEvent): boolean {
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.key === "F12") return true;
  if (ctrlOrCmd && e.shiftKey && ["i", "j", "c"].includes(key)) return true;
  if (ctrlOrCmd && !e.shiftKey && ["c", "v", "x", "a", "s", "p"].includes(key)) return true;
  if (ctrlOrCmd && key === "u") return true;

  return false;
}

export default function TakeExamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const router = useRouter();

  const [data, setData] = useState<SubmissionData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [remainingSecs, setRemainingSecs] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [autoSubmitLocked, setAutoSubmitLocked] = useState(false);
  const [timerStopped, setTimerStopped] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [gateAcknowledged, setGateAcknowledged] = useState(false);
  const [fullscreenDenied, setFullscreenDenied] = useState(false);
  const [fullscreenReturnNeeded, setFullscreenReturnNeeded] = useState(false);
  // One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md. Only ever populated when
  // oneQuestionAtATime is enabled; the full data.exam.questions array is
  // empty in that case (the server never sends the full paper), so this
  // is the sole source of question content for that mode.
  const [oneQuestion, setOneQuestion] = useState<{
    loading: boolean;
    error: string | null;
    payload: OneQuestionPayload | null;
  }>({ loading: true, error: null, payload: null });
  const [navigatingQuestion, setNavigatingQuestion] = useState(false);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastEventAt = useRef<Partial<Record<IntegrityEventType, number>>>({});
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSubmitTriggeredRef = useRef(false);
  const timerExpiredLoggedRef = useRef(false);
  const terminalSubmitRef = useRef(false);

  // --- Camera Monitoring v1 state ---
  // Camera Monitoring v1 records only camera availability status (see
  // docs/secure-exam-threat-model.md, "Camera Monitoring v1"). The stream
  // never leaves the browser — no video/images are uploaded or stored.
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraStatus, setCameraStatus] = useState<"idle" | "requesting" | "granted" | "denied">(
    "idle",
  );
  const [cameraWarning, setCameraWarning] = useState<string | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Persistent Camera Preview v1 — purely local UI state. Minimizing or
  // restoring the preview never creates an IntegrityEvent and never
  // pauses the stream/heartbeat below; it only toggles which DOM element
  // is rendered. See docs/known-limitations.md.
  const [cameraPreviewMinimized, setCameraPreviewMinimized] = useState(false);
  const examVideoRef = useRef<HTMLVideoElement | null>(null);

  // --- Optional Student Verification v1 ---
  // Purely a one-time confirmation gate — no face comparison, no ID
  // image capture/storage. See docs/on-device-ai-integrity-detection-v1.md.
  const [verificationConfirmed, setVerificationConfirmed] = useState(false);
  const [verificationChecked, setVerificationChecked] = useState(false);

  // --- On-Device AI Camera Integrity Detection v1 ---
  // Always samples from the same cameraStreamRef stream used for the
  // preview/heartbeat above — never a second getUserMedia call. A
  // dedicated hidden <video> element (detectionVideoRef) keeps sampling
  // alive even while the visible preview is minimized. Detection never
  // uploads or stores a frame — only numeric aggregates and, if the
  // object-detection model loaded, class/confidence pairs are sent as
  // IntegrityEvent metadata. See docs/on-device-ai-integrity-detection-v1.md.
  const detectionVideoRef = useRef<HTMLVideoElement | null>(null);
  const detectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Evidence Frames v1 — a separate, higher-resolution canvas from the
  // tiny 160px-wide one above (that one is sized for the ML model only).
  // Never rendered, never reused for detection — draws fresh from
  // detectionVideoRef only at the moment an eligible event is captured.
  const evidenceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const detectorRef = useRef<CameraObjectDetector | null>(null);
  const detectionCooldown = useRef(new DetectionCooldownTracker());
  const detectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [aiCheckStatus, setAiCheckStatus] = useState<"idle" | "loading" | "active" | "unavailable">(
    "idle",
  );
  // Camera Startup Readiness v1 — see
  // docs/on-device-ai-integrity-detection-v1.md ("Camera startup
  // readiness"). Fixes false CAMERA_VIEW_BLOCKED/CAMERA_TOO_DARK/
  // NO_PERSON_VISIBLE/POSSIBLE_PHONE_VISIBLE/POSSIBLE_SECOND_PERSON_VISIBLE
  // on first exam start: many webcams deliver a few transiently black/
  // dark/artifacted frames while auto-exposure/auto-focus settle, even
  // after the video element already reports itself as playable.
  // cameraStreamStartedAtRef is set the moment getUserMedia resolves;
  // firstReadyFrameAtRef is set on the first detection tick where the
  // video actually has a ready frame. Both are reset to null whenever a
  // NEW camera stream is acquired (see startCamera/stopCamera below), so
  // a lost-and-restarted stream gets its own fresh warm-up window rather
  // than being permanently suppressed or permanently un-suppressed.
  const cameraStreamStartedAtRef = useRef<number | null>(null);
  const firstReadyFrameAtRef = useRef<number | null>(null);
  const [cameraStartupPhaseState, setCameraStartupPhaseState] = useState<CameraStartupPhase>(
    "waiting_for_first_frame",
  );
  // Local exam-content blur/overlay driven by AI camera violation events
  // (distinct from browser/window blur — see aiCameraViolationOverlay.ts).
  // Purely local UI state: acknowledging it clears this back to null but
  // never deletes the backend IntegrityEvent. Local display is driven by
  // computeLocalAiCameraOverlay() every detection tick — independent of
  // the backend-logging cooldown — so if the underlying signal is still
  // present, the overlay reopens on the very next tick after being
  // acknowledged, instead of waiting out the 45-60s backend cooldown.
  const [aiCameraViolationOverlay, setAiCameraViolationOverlay] =
    useState<AiCameraViolationOverlayState | null>(null);
  // Mirrors aiCameraViolationOverlay for synchronous reads inside the
  // detection tick closure (which is defined once per effect run and
  // would otherwise see a stale value of the state variable itself).
  // Used only to avoid redundant setState calls (no visible flicker when
  // the same overlay reason is recomputed tick after tick) and for debug
  // logging — never used to gate correctness-critical logic.
  const aiCameraViolationOverlayRef = useRef<AiCameraViolationOverlayState | null>(null);
  useEffect(() => {
    aiCameraViolationOverlayRef.current = aiCameraViolationOverlay;
  }, [aiCameraViolationOverlay]);

  const [inLockdownBrowser, setInLockdownBrowser] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInLockdownBrowser(isRunningInLockdownBrowser());
  }, []);

  const applySubmissionData = useCallback((d: SubmissionData) => {
        // Temporary dev-only diagnostic for the production secureSettings
        // display investigation — never fires outside NODE_ENV=development,
        // and only when explicitly opted in via localStorage. Remove once
        // the production/local mismatch is resolved.
        if (
          process.env.NODE_ENV === "development" &&
          typeof window !== "undefined" &&
          window.localStorage.getItem("sesSecureSettingsDebug") === "true"
        ) {
          console.log("[sesSecureSettingsDebug] raw exam.secureSettings from GET /api/submissions/[id]:", d.exam.secureSettings);
        }
        setData(d);
        const initial: Record<string, string> = {};
        d.answers.forEach((a) => {
          if (a.response != null) initial[a.questionId] = a.response;
        });
        setResponses(initial);
  }, []);

  const loadSubmission = useCallback(async () => {
    try {
      const res = await fetch(`/api/submissions/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setLoadError(
          res.status === 404
            ? "This exam submission could not be found."
            : res.status === 403
              ? "You don't have access to this exam submission."
              : typeof body?.error === "string"
                ? body.error
                : `Could not load this exam (status ${res.status}). Try refreshing the page.`,
        );
        return null;
      }
      const d: SubmissionData = await res.json();
      setLoadError(null);
      applySubmissionData(d);
      return d;
    } catch {
      setLoadError("Could not load this exam — check your connection and try refreshing the page.");
      return null;
    }
  }, [id, applySubmissionData]);

  // One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md. Declared early (ahead of
  // secureSettings/secureModeEnabled below, which are also derived from
  // `data`) since the fetch effect right below needs them.
  const oneQuestionAtATime = data?.exam.secureSettings.oneQuestionAtATime ?? false;
  const allowBackNavigation = data?.exam.secureSettings.allowBackNavigation ?? true;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSubmission();
  }, [loadSubmission]);

  // One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md. Fetches only the CURRENT question
  // (never the full paper) once the exam is actually in progress and the
  // pre-exam gate has been passed — including on a plain refresh, which
  // restores exactly the last allowed/current question via the server's
  // stored currentQuestionIndex (GET never accepts a client-supplied
  // index, so there's nothing for the client to get wrong here).
  useEffect(() => {
    if (!oneQuestionAtATime || !gateAcknowledged || data?.status !== "IN_PROGRESS") return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOneQuestion((prev) => ({ ...prev, loading: true, error: null }));
    fetch(`/api/submissions/${id}/question`)
      .then((res) => (res.ok ? (res.json() as Promise<OneQuestionPayload>) : Promise.reject(res)))
      .then((payload) => {
        if (cancelled) return;
        setOneQuestion({ loading: false, error: null, payload });
        if (payload.existingResponse != null) {
          setResponses((prev) =>
            prev[payload.question.id] !== undefined
              ? prev
              : { ...prev, [payload.question.id]: payload.existingResponse! },
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOneQuestion({
            loading: false,
            error: "Could not load the current question. Please refresh the page.",
            payload: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [oneQuestionAtATime, gateAcknowledged, data?.status, id]);

  // Clears any pending debounced autosave for one question and saves it
  // immediately — used before every one-question-mode navigation so
  // "Next"/"Previous" always saves the current answer first, per
  // docs/one-question-delivery-v1.md. Returns false (without throwing) on
  // failure so the caller can show an error and refuse to navigate,
  // rather than silently losing the answer.
  async function flushAnswerNow(questionId: string): Promise<boolean> {
    clearTimeout(saveTimers.current[questionId]);
    const response = responses[questionId];
    if (response === undefined) return true;
    try {
      const res = await fetch(`/api/submissions/${id}/answers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, response }),
      });
      if (!res.ok) {
        if (secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
        return false;
      }
      return true;
    } catch {
      if (secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
      return false;
    }
  }

  // One-Question-At-A-Time Exam Delivery v1 — the only place the current
  // question index actually changes. Always flushes the current answer
  // first (per the navigation rules); never advances if that save fails,
  // so a student is never trapped by a transient autosave failure but
  // also never silently loses an answer by moving on regardless.
  // allowBackNavigation is enforced server-side in the question-progress
  // route regardless of what this sends — this is UX only, not the
  // source of truth.
  async function navigateQuestion(requestedIndex: number) {
    if (!oneQuestion.payload || navigatingQuestion) return;
    setNavigatingQuestion(true);
    setOneQuestion((prev) => ({ ...prev, error: null }));
    const saved = await flushAnswerNow(oneQuestion.payload.question.id);
    if (!saved) {
      setOneQuestion((prev) => ({
        ...prev,
        error: "Your answer could not be saved. Please try again before moving on.",
      }));
      setNavigatingQuestion(false);
      return;
    }
    try {
      const res = await fetch(`/api/submissions/${id}/question-progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentIndex: requestedIndex }),
      });
      if (!res.ok) throw new Error("navigation failed");
      const payload: OneQuestionPayload = await res.json();
      setOneQuestion({ loading: false, error: null, payload });
      if (payload.existingResponse != null) {
        setResponses((prev) =>
          prev[payload.question.id] !== undefined
            ? prev
            : { ...prev, [payload.question.id]: payload.existingResponse! },
        );
      }
    } catch {
      setOneQuestion((prev) => ({
        ...prev,
        error: "Could not load the next question. Please try again.",
      }));
    } finally {
      setNavigatingQuestion(false);
    }
  }

  // Lets the Electron Lockdown Browser (if present) know which
  // submission to attach queued OS-level integrity events to. This is a
  // secondary layer only — the existing browser-level Secure Exam Mode
  // handlers below stay active regardless of whether this call happens.
  useEffect(() => {
    if (!data) return;
    window.sesLockdown?.setExamContext({ examId: data.exam.id, submissionId: data.id });
  }, [data]);

  const secureSettings = data?.exam.secureSettings;
  const secureModeEnabled = secureSettings?.secureModeEnabled ?? false;

  const reportIntegrityEvent = useCallback(
    (eventType: IntegrityEventType, metadata?: Record<string, unknown>) => {
      if (!data || data.status !== "IN_PROGRESS" || !secureSettings) return;

      const debounceMs = DEBOUNCE_MS[eventType];
      const now = Date.now();
      const last = lastEventAt.current[eventType];
      if (debounceMs && last && now - last < debounceMs) {
        return;
      }
      lastEventAt.current[eventType] = now;

      const severity = severityFor(eventType, secureSettings);
      const message = MESSAGES[eventType];

      // One backend POST, shared by two independent consumers below:
      // handleAiCameraIntegrityReport (overlay + backend logging, existing
      // behavior, unchanged) and — only for eligible AI camera events with
      // evidence capture explicitly enabled — the evidence-frame upload,
      // which needs the created event's id. Both read the same fetch
      // Promise; only one of them ever calls response.json().
      const backendPromise = fetch(`/api/submissions/${id}/integrity-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType,
          severity,
          message,
          metadata,
          occurredAt: new Date().toISOString(),
        }),
      });

      // Local exam-content overlay (if this is an AI camera violation
      // event) is set synchronously, before the backend call is even
      // made — and a backend failure never clears it. See
      // src/lib/aiCameraViolationOverlay.ts.
      void handleAiCameraIntegrityReport(eventType, {
        setOverlay: setAiCameraViolationOverlay,
        sendToBackend: () => backendPromise,
      });

      // On-Device AI Camera Integrity Detection v1 — Evidence Frames
      // (opt-in, off by default — see src/lib/aiCameraEvidenceFrame.ts).
      // Only for POSSIBLE_PHONE_VISIBLE / POSSIBLE_SECOND_PERSON_VISIBLE,
      // only when the lecturer has explicitly enabled
      // captureAiViolationEvidence, and only once per backend-logged
      // event — this function body only runs past the debounce guard
      // above when a NEW event is actually being reported, never on an
      // overlay redisplay of an already-debounced signal (see
      // computeLocalAiCameraOverlay below, which reopens the overlay
      // independently of this function ever running again). Capture/
      // upload never blocks the overlay or the backend event above, and
      // a failure here never blocks exam continuation.
      const eventTypeEligible = isEvidenceCaptureEligibleEventType(eventType);
      logEvidenceDebug("evidence: eligibility check", {
        eventType,
        eventTypeEligible,
        captureAiViolationEvidence: secureSettings.captureAiViolationEvidence,
        enableAiCameraIntegrityChecks: secureSettings.enableAiCameraIntegrityChecks,
      });
      if (eventTypeEligible) {
        backendPromise
          .then((res) => {
            logEvidenceDebug("evidence: integrity event POST result", { status: res.status, ok: res.ok });
            return res.ok ? (res.json() as Promise<{ id?: string; eventType?: string }>) : null;
          })
          .then((created) => {
            const createdEventType = created?.eventType ?? eventType;
            const shouldAttempt = shouldAttemptEvidenceUpload(createdEventType, secureSettings, created?.id);
            const skipReason = shouldAttempt
              ? null
              : evidenceUploadSkipReason(createdEventType, secureSettings, created?.id);
            logEvidenceDebug("evidence: integrity event response", {
              eventId: created?.id ?? null,
              eventType: created?.eventType ?? null,
              shouldAttempt,
              skipReason,
            });
            if (shouldAttempt && created?.id) {
              void captureAndUploadEvidenceFrame(created.id);
            }
          })
          .catch((err) => {
            // Backend logging failure is already handled above; without a
            // created event id there is nothing to attach a frame to.
            logEvidenceDebug("evidence: integrity event POST threw", {
              skipReason: "upload-fetch-failed",
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      if (secureSettings.showIntegrityWarningToStudent && (severity === "MEDIUM" || severity === "HIGH")) {
        setBanner(`Exam integrity event recorded: ${message} Please remain in the exam window.`);
        if (bannerTimer.current) clearTimeout(bannerTimer.current);
        bannerTimer.current = setTimeout(() => setBanner(null), 8000);
      }
    },
    // captureAndUploadEvidenceFrame is a plain function (re-created each
    // render, reads current refs at call time) — intentionally omitted so
    // this callback doesn't get a new identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, id, secureSettings],
  );

  async function flushResponsesBeforeSubmit() {
    if (!data) return;
    Object.values(saveTimers.current).forEach((timer) => clearTimeout(timer));
    saveTimers.current = {};

    await Promise.allSettled(
      Object.entries(responses).map(([questionId, response]) =>
        fetch(`/api/submissions/${id}/answers`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, response }),
        }),
      ),
    );
  }

  async function handleSubmit(options: { systemAutoSubmit?: boolean } = {}) {
    if (submitting || terminalSubmitRef.current) return;
    setSubmitting(true);
    setSubmitMessage(null);
    if (options.systemAutoSubmit) {
      setSubmitMessage("Time is up. Submitting your exam automatically...");
      await flushResponsesBeforeSubmit();
    }

    const res = await fetch(`/api/submissions/${id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemAutoSubmit: options.systemAutoSubmit === true }),
    }).catch(() => null);
    setSubmitting(false);

    if (!res) {
      if (options.systemAutoSubmit) setAutoSubmitLocked(false);
      setSubmitMessage(
        options.systemAutoSubmit
          ? "Time is up. Automatic submission could not reach the server. Please retry submission now."
          : "Submission failed. Please try again.",
      );
      return;
    }

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      terminalSubmitRef.current = true;
      setTimerStopped(true);
      const latest = await loadSubmission();
      if (latest && isFinalizedSubmissionStatus(latest.status)) {
        setAutoSubmitLocked(false);
        setSubmitMessage(
          options.systemAutoSubmit
            ? "Time is up. Your exam has already been submitted."
            : "Your exam has already been submitted.",
        );
        stopCamera();
        stopAiDetection();
        router.refresh();
        return;
      }
      if (options.systemAutoSubmit) setAutoSubmitLocked(false);
      setSubmitMessage(
        typeof body.error === "string" ? body.error : "This exam can no longer be submitted.",
      );
      return;
    }

    if (res.ok) {
      stopCamera();
      stopAiDetection();
      const updated = await res.json();
      terminalSubmitRef.current = true;
      setTimerStopped(true);
      setAutoSubmitLocked(false);
      setData((prev) => (prev ? { ...prev, status: updated.status, totalScore: updated.totalScore } : prev));
      if (options.systemAutoSubmit) {
        setSubmitMessage("Time is up. Your exam has been submitted automatically.");
      }
      router.refresh();
    }
  }

  useEffect(() => {
    if (!data || !shouldRunExamTimer({ status: data.status, terminal: timerStopped })) return;
    const tick = () => {
      const secs = remainingSeconds(new Date(data.deadline));
      setRemainingSecs(secs);
      if (secs === 0) {
        if (!timerExpiredLoggedRef.current) {
          timerExpiredLoggedRef.current = true;
          reportIntegrityEvent("TIMER_EXPIRED");
        }
        if (
          shouldAutoSubmit({
            status: data.status,
            remainingSecs: secs,
            autoSubmitOnTimerEnd: data.exam.secureSettings.autoSubmitOnTimerEnd,
            alreadyTriggered: autoSubmitTriggeredRef.current,
            terminal: terminalSubmitRef.current,
          })
        ) {
          autoSubmitTriggeredRef.current = true;
          setAutoSubmitLocked(true);
          handleSubmit({ systemAutoSubmit: true });
        }
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, timerStopped]);

  // --- Browser-level friction: copy/cut/paste, right-click, keyboard shortcuts ---
  useEffect(() => {
    if (!data || data.status !== "IN_PROGRESS" || !secureModeEnabled || !secureSettings) return;

    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) {
        reportIntegrityEvent("FULLSCREEN_EXIT");
        if (secureSettings.requireFullscreen && secureSettings.enforceFullscreenReturn) {
          setFullscreenReturnNeeded(true);
          // Best-effort automatic attempt — browsers commonly require a
          // user gesture for requestFullscreen(), so this often fails
          // silently; the "Return to fullscreen" button is the fallback.
          document.documentElement.requestFullscreen().then(
            () => {
              setFullscreenReturnNeeded(false);
              reportIntegrityEvent("FULLSCREEN_FORCED_RETURN");
            },
            () => {
              // Expected when the browser requires a user gesture.
            },
          );
        }
      } else if (fullscreenReturnNeeded) {
        setFullscreenReturnNeeded(false);
      }
    };
    const onBlur = () => secureSettings.trackWindowBlur && reportIntegrityEvent("WINDOW_BLUR");
    const onFocus = () => secureSettings.trackWindowBlur && reportIntegrityEvent("WINDOW_FOCUS_RETURN");
    const onVisibilityChange = () => {
      if (!secureSettings.trackWindowBlur) return;
      if (document.hidden) {
        reportIntegrityEvent("WINDOW_BLUR");
      } else {
        reportIntegrityEvent("WINDOW_FOCUS_RETURN");
      }
    };

    const onCopy = (e: ClipboardEvent) => {
      if (secureSettings.blockCopyPaste) e.preventDefault();
      reportIntegrityEvent("COPY_ATTEMPT");
    };
    const onCut = (e: ClipboardEvent) => {
      if (secureSettings.blockCopyPaste) e.preventDefault();
      // No dedicated CUT_ATTEMPT event type exists — cut is logged as a
      // copy-style exfiltration attempt.
      reportIntegrityEvent("COPY_ATTEMPT");
    };
    const onPaste = (e: ClipboardEvent) => {
      if (secureSettings.blockCopyPaste) e.preventDefault();
      reportIntegrityEvent("PASTE_ATTEMPT");
    };
    const onContextMenu = (e: MouseEvent) => {
      if (secureSettings.blockRightClick) e.preventDefault();
      reportIntegrityEvent("RIGHT_CLICK_ATTEMPT");
    };
    const onOffline = () => reportIntegrityEvent("NETWORK_OFFLINE");
    const onOnline = () => reportIntegrityEvent("NETWORK_ONLINE");

    const onKeyDown = (e: KeyboardEvent) => {
      if (!secureSettings.blockKeyboardShortcuts) return;
      if (!isBlockableShortcut(e)) return;
      e.preventDefault();
      reportIntegrityEvent("KEYBOARD_SHORTCUT_BLOCKED");
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [data, secureModeEnabled, secureSettings, reportIntegrityEvent, fullscreenReturnNeeded]);

  async function enterFullscreen(): Promise<boolean> {
    try {
      await document.documentElement.requestFullscreen();
      setFullscreenDenied(false);
      if (fullscreenReturnNeeded) {
        setFullscreenReturnNeeded(false);
        reportIntegrityEvent("FULLSCREEN_FORCED_RETURN");
      }
      return true;
    } catch {
      setFullscreenDenied(true);
      return false;
    }
  }

  // --- Camera Monitoring v1: start/stop, preview, heartbeat ---
  function stopCamera() {
    if (heartbeatTimer.current) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    // Camera Startup Readiness v1 — a stopped stream has no readiness
    // state at all; the next startCamera() call gets a completely fresh
    // warm-up window, never an inherited one.
    cameraStreamStartedAtRef.current = null;
    firstReadyFrameAtRef.current = null;
    setCameraStartupPhaseState("waiting_for_first_frame");
  }

  async function startCamera(): Promise<boolean> {
    setCameraStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      cameraStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraStatus("granted");
      // Camera Startup Readiness v1 — see
      // docs/on-device-ai-integrity-detection-v1.md. Reset on every
      // successful (re)acquisition, including a restart after the stream
      // was lost, so that attempt gets its own fresh warm-up window
      // rather than reusing timing from a previous stream.
      cameraStreamStartedAtRef.current = Date.now();
      firstReadyFrameAtRef.current = null;
      setCameraStartupPhaseState("waiting_for_first_frame");
      reportIntegrityEvent("CAMERA_PERMISSION_GRANTED");
      reportIntegrityEvent("CAMERA_STARTED");
      return true;
    } catch {
      setCameraStatus("denied");
      if (gateAcknowledged) {
        reportIntegrityEvent("CAMERA_PRECHECK_FAILED");
      } else {
        reportIntegrityEvent("CAMERA_PERMISSION_DENIED");
      }
      return false;
    }
  }

  // Camera heartbeat: checks the existing stream's track state on an
  // interval. Never auto-submits or blocks saving/submission on failure.
  useEffect(() => {
    if (!data || data.status !== "IN_PROGRESS" || !gateAcknowledged) return;
    if (!secureSettings?.cameraHeartbeatEnabled || cameraStatus !== "granted") return;

    const intervalMs = Math.max(10, secureSettings.cameraHeartbeatIntervalSeconds) * 1000;
    heartbeatTimer.current = setInterval(() => {
      const stream = cameraStreamRef.current;
      const track = stream?.getVideoTracks()[0];
      const healthy = track && track.readyState === "live" && !track.muted;

      if (!healthy) {
        reportIntegrityEvent("CAMERA_HEARTBEAT_MISSED");
        if (secureSettings.requireCamera) {
          setCameraWarning(
            "Camera monitoring has stopped. Please restore camera access to continue your secure exam.",
          );
        }
      } else if (cameraWarning) {
        setCameraWarning(null);
      }
    }, intervalMs);

    return () => {
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, gateAcknowledged, secureSettings, cameraStatus]);

  async function handleRestoreCamera() {
    const ok = await startCamera();
    if (ok) {
      setCameraWarning(null);
    } else if (secureSettings?.recordCameraUnavailableEvents) {
      reportIntegrityEvent("CAMERA_UNAVAILABLE");
    }
  }

  // Persistent Camera Preview v1 — reattaches the already-running stream
  // (held in cameraStreamRef, never re-requested) to the exam-view video
  // element whenever it becomes visible: on entering the exam (gate ->
  // exam transition mounts a new <video> node) and on restoring from
  // minimized. The stream itself and the heartbeat above are never
  // affected by this — minimizing only stops rendering the <video> tag.
  useEffect(() => {
    if (gateAcknowledged && !cameraPreviewMinimized && examVideoRef.current && cameraStreamRef.current) {
      examVideoRef.current.srcObject = cameraStreamRef.current;
    }
  }, [gateAcknowledged, cameraPreviewMinimized, cameraStatus]);

  // Local UI state only — see the comment on cameraPreviewMinimized above.
  // Never reports an IntegrityEvent and never touches the camera stream.
  function toggleCameraPreviewMinimized() {
    setCameraPreviewMinimized((prev) => !prev);
  }

  // Reattaches the same camera stream to the hidden detection video
  // element regardless of the visible preview's minimized state, so AI
  // camera checks (if enabled) keep running even while minimized.
  useEffect(() => {
    if (gateAcknowledged && detectionVideoRef.current && cameraStreamRef.current) {
      detectionVideoRef.current.srcObject = cameraStreamRef.current;
    }
  }, [gateAcknowledged, cameraStatus]);

  // Clean up the camera stream on unmount, regardless of how the page is left.
  useEffect(() => {
    return () => {
      stopCamera();
      stopAiDetection();
    };
  }, []);

  function stopAiDetection() {
    if (detectionTimer.current) {
      clearTimeout(detectionTimer.current);
      detectionTimer.current = null;
    }
    detectorRef.current?.dispose();
    detectorRef.current = null;
    detectionCooldown.current.reset();
  }

  // Dev-only, opt-in diagnostic logging for tuning the interval/confidence
  // threshold — see docs/on-device-ai-integrity-detection-v1.md. Gated on
  // BOTH NODE_ENV === "development" AND an explicit localStorage flag, so
  // it never logs in production and never logs just because a developer
  // happens to be running `next dev`. Never sent to the server; only
  // class names, confidence scores, and timing numbers are ever logged —
  // never image/frame/base64/blob data.
  function logAiCameraDebug(message: string, data: Record<string, unknown>) {
    if (typeof window === "undefined") return;
    if (!shouldLogAiCameraDebug(process.env.NODE_ENV, window.localStorage.getItem("sesAiCameraDebug"))) {
      return;
    }
    console.log(`[sesAiCameraDebug] ${message}`, data);
  }

  // Evidence-upload diagnostic logging — deliberately Preview-safe: unlike
  // logAiCameraDebug above (which requires NODE_ENV === "development" and
  // so never logs anything in a Vercel Preview build), this only requires
  // the same opt-in localStorage.sesAiCameraDebug flag, so a tester can
  // diagnose a missing evidence-frame upload directly in Preview without
  // a code change. Never logs image/blob/base64 data, a storage key, or
  // student personal details — only ids, dimensions, byte counts, status
  // codes, and the request path (never the full URL/origin).
  function logEvidenceDebug(message: string, data: Record<string, unknown>) {
    if (typeof window === "undefined") return;
    if (!shouldLogEvidenceUploadDebug(window.localStorage.getItem("sesAiCameraDebug"))) return;
    console.log(`[sesAiCameraDebug] ${message}`, data);
  }

  // On-Device AI Camera Integrity Detection v1 — Evidence Frames (opt-in,
  // off by default). Draws the CURRENT frame from the same hidden
  // detectionVideoRef used for on-device detection (never a new
  // getUserMedia call, never getDisplayMedia/screen capture), downscales
  // to at most 640x360 preserving aspect ratio, re-encodes as JPEG
  // (quality ~0.6 — re-encoding also implicitly strips any embedded
  // metadata), and uploads it once, attached to the already-created
  // integrity event id. Never blocks the overlay (already shown by the
  // time this runs) or exam continuation: any failure here is caught,
  // optionally logged in development only, and never retried.
  async function captureAndUploadEvidenceFrame(integrityEventId: string) {
    try {
      const video = detectionVideoRef.current;
      logEvidenceDebug("evidence: video state at capture time", {
        integrityEventId,
        hasVideo: Boolean(video),
        readyState: video?.readyState ?? null,
        videoWidth: video?.videoWidth ?? null,
        videoHeight: video?.videoHeight ?? null,
      });
      if (!isEvidenceFrameSourceReady(video)) {
        logEvidenceDebug("evidence: skipped", { integrityEventId, skipReason: "video-not-ready" });
        return;
      }

      if (!evidenceCanvasRef.current) {
        evidenceCanvasRef.current = document.createElement("canvas");
      }
      const canvas = evidenceCanvasRef.current;

      const MAX_WIDTH = 640;
      const MAX_HEIGHT = 360;
      const scale = Math.min(MAX_WIDTH / video.videoWidth, MAX_HEIGHT / video.videoHeight, 1);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        logEvidenceDebug("evidence: skipped", { integrityEventId, skipReason: "blob-create-failed" });
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.6);
      });
      logEvidenceDebug("evidence: blob encoded", {
        integrityEventId,
        hasBlob: Boolean(blob),
        contentType: blob?.type ?? null,
        byteSize: blob?.size ?? null,
      });
      if (!blob) {
        logEvidenceDebug("evidence: skipped", { integrityEventId, skipReason: "blob-create-failed" });
        return;
      }

      const formData = new FormData();
      formData.append("file", blob, "evidence.jpg");

      const uploadPath = buildEvidenceFrameUploadPath(id, integrityEventId);
      let res: Response;
      try {
        res = await fetch(uploadPath, { method: "POST", body: formData });
      } catch (err) {
        logEvidenceDebug("evidence: skipped", {
          integrityEventId,
          skipReason: "upload-fetch-failed",
          path: uploadPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        logEvidenceDebug("evidence frame upload rejected", {
          path: uploadPath,
          status: res.status,
          integrityEventId,
          error: typeof body?.error === "string" ? body.error : null,
        });
      } else {
        logEvidenceDebug("evidence: upload succeeded", { path: uploadPath, status: res.status, integrityEventId });
      }
    } catch (err) {
      logEvidenceDebug("evidence frame capture/upload threw", {
        integrityEventId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // On-Device AI Camera Integrity Detection v1 — runs entirely against
  // the existing camera stream (via the hidden detectionVideoRef), on an
  // adaptive interval (not per-frame), independent of the preview's
  // minimize/restore state. Never uploads or stores a frame; only
  // numeric aggregates and, once loaded, object-detection class/score
  // pairs are ever sent as event metadata. A failed model load falls
  // back to "unavailable" and never crashes or blocks the exam.
  useEffect(() => {
    const enabled = secureSettings?.enableAiCameraIntegrityChecks ?? false;
    if (!enabled || !gateAcknowledged || cameraStatus !== "granted" || data?.status !== "IN_PROGRESS") {
      return;
    }

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAiCheckStatus("loading");

    loadCameraObjectDetector().then((detector) => {
      if (cancelled) return;
      detectorRef.current = detector;
      if (!detector) {
        setAiCheckStatus("unavailable");
        reportIntegrityEvent("AI_CAMERA_CHECK_UNAVAILABLE");
        return;
      }
      setAiCheckStatus("active");
    });

    // Adaptive cadence (computeNextDetectionDelayMs in
    // cameraIntegrityDetection.ts): 1s between ticks by default — fast
    // enough that a briefly-shown phone is very likely caught on the
    // very next tick — backing off to 1.5s only when the previous tick's
    // inference itself took long enough to suggest the device is
    // struggling. Starts at the fast interval; only ever updated from
    // measured inferenceMs, never guessed ahead of time.
    let currentDetectionDelayMs = computeNextDetectionDelayMs(null);

    // Self-scheduling (setTimeout-after-completion), not a fixed-rate
    // setInterval: each tick waits for the previous inference to fully
    // resolve before scheduling the next one, so a slow device can never
    // stack up overlapping detector.detect() calls regardless of how
    // short the chosen delay is.
    async function runDetectionTick() {
      if (cancelled) return;
      const video = detectionVideoRef.current;
      const cooldown = detectionCooldown.current;
      const now = Date.now();
      let inferenceMs: number | null = null;

      logAiCameraDebug("tick: start", { tickTimestamp: now, cadenceMs: currentDetectionDelayMs });

      try {
        if (!isVideoFrameReady(video)) return;

        // Camera Startup Readiness v1 — see
        // docs/on-device-ai-integrity-detection-v1.md ("Camera startup
        // readiness"). This is the fix for false CAMERA_VIEW_BLOCKED/
        // CAMERA_TOO_DARK/NO_PERSON_VISIBLE/POSSIBLE_PHONE_VISIBLE/
        // POSSIBLE_SECOND_PERSON_VISIBLE on first exam start: passing
        // isVideoFrameReady above only means the video element has SOME
        // frame, not that the camera's auto-exposure/auto-focus have
        // settled yet. Detection/inference still runs every tick from
        // here on (so the model warms up and the local overlay/quality
        // pipeline stay exercised) — only EMISSION (backend logging and
        // the local violation overlay) is suppressed until the grace
        // period since the first ready frame has elapsed.
        if (firstReadyFrameAtRef.current == null) {
          firstReadyFrameAtRef.current = now;
          logAiCameraDebug("camera startup: first ready frame observed", {
            readyState: video!.readyState,
            videoWidth: video!.videoWidth,
            videoHeight: video!.videoHeight,
            warmUpStartedAt: now,
          });
        }
        const suppressStartup = shouldSuppressCameraIntegrityDuringStartup(firstReadyFrameAtRef.current, now);
        const nextStartupPhase = cameraStartupPhase({
          firstReadyFrameAt: firstReadyFrameAtRef.current,
          now,
          streamStartedAt: cameraStreamStartedAtRef.current,
        });
        if (nextStartupPhase !== cameraStartupPhaseState) {
          logAiCameraDebug("camera startup: phase changed", {
            previousPhase: cameraStartupPhaseState,
            nextPhase: nextStartupPhase,
            firstReadyFrameAt: firstReadyFrameAtRef.current,
            warmUpEndedAt: nextStartupPhase === "ready" ? now : null,
          });
          setCameraStartupPhaseState(nextStartupPhase);
        }
        if (suppressStartup) {
          logAiCameraDebug("tick: suppressed — camera starting up", {
            reason: firstReadyFrameAtRef.current === now ? "no-video-dimensions-yet" : "warm-up-period",
            firstReadyFrameAt: firstReadyFrameAtRef.current,
            msSinceFirstReadyFrame: now - firstReadyFrameAtRef.current,
          });
        }

        if (!detectionCanvasRef.current) {
          detectionCanvasRef.current = document.createElement("canvas");
        }
        const canvas = detectionCanvasRef.current;
        canvas.width = 160;
        canvas.height = Math.round((160 * video.videoHeight) / video.videoWidth) || 120;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Non-AI camera quality checks — no model required.
        let imageData: ImageData;
        try {
          imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        } catch {
          return;
        }
        const { avgLuminance, variance } = computeLuminanceVariance(imageData.data);
        const quality = classifyFrameQuality(avgLuminance, variance);

        const blockedCount = cooldown.recordObservation("blocked", quality === "blocked");
        const darkCount = cooldown.recordObservation("dark", quality === "dark");
        if (quality !== "blocked") cooldown.recordObservation("blocked", false);
        if (quality !== "dark") cooldown.recordObservation("dark", false);

        // Frame-quality decisions: `conditionMet` (drives the local
        // overlay) is independent of the backend cooldown; `shouldEmit`
        // (drives backend logging) additionally requires it. See
        // shouldShowLocalAiOverlay / shouldLogAiIntegrityEvent in
        // cameraIntegrityDetection.ts. Both are forced false during
        // camera startup (see suppressStartup above) — a transiently
        // black/artifacted warm-up frame must never log an event or show
        // the violation overlay.
        const blockedDecisionRaw = decideFrameQualityEmission(
          quality === "blocked",
          blockedCount,
          cooldown.canEmit("CAMERA_VIEW_BLOCKED", now, 60_000),
        );
        const darkDecisionRaw = decideFrameQualityEmission(
          quality === "dark",
          darkCount,
          cooldown.canEmit("CAMERA_TOO_DARK", now, 60_000),
        );
        const blockedDecision = suppressStartup
          ? { conditionMet: false, shouldEmit: false }
          : blockedDecisionRaw;
        const darkDecision = suppressStartup ? { conditionMet: false, shouldEmit: false } : darkDecisionRaw;

        if (blockedDecision.shouldEmit) {
          cooldown.markEmitted("CAMERA_VIEW_BLOCKED", now);
          reportIntegrityEvent("CAMERA_VIEW_BLOCKED", {
            source: "on_device_camera_ai",
            confidenceBand: "medium",
            detectionIntervalSeconds: currentDetectionDelayMs / 1000,
          });
        } else if (darkDecision.shouldEmit) {
          cooldown.markEmitted("CAMERA_TOO_DARK", now);
          reportIntegrityEvent("CAMERA_TOO_DARK", {
            source: "on_device_camera_ai",
            confidenceBand: "medium",
            detectionIntervalSeconds: currentDetectionDelayMs / 1000,
          });
        }

        // Object-detection-based checks — only if the model loaded. These
        // default to "not currently met" so the local-overlay refresh
        // below (which must run regardless of whether object detection
        // ran this tick) has a well-defined value for every signal —
        // blocked/dark can still drive/reopen the overlay even on a tick
        // where the model isn't loaded or a single inference call fails.
        const detector = detectorRef.current;
        // Placeholder for ticks with no fresh object-detection data this
        // tick (model not loaded / inference threw) — deliberately
        // "nothing detected," never "no person," so it can't spuriously
        // satisfy any condition below.
        const noFreshPersonData = {
          personCount: 0,
          noPersonDetected: false,
          multiplePersons: false,
          multiplePersonsHighConfidence: false,
        };
        let phoneDecision = decidePhoneEmission({ detected: false, confidence: 0 }, true);
        let secondPersonDecision = decideSecondPersonEmission(noFreshPersonData, 0, true);
        let noPersonDecision = decideNoPersonEmission(noFreshPersonData, 0, true);

        if (!detector) {
          logAiCameraDebug("tick: model not loaded", { modelLoaded: false });
        } else {
          let detections: DetectedObject[] = [];
          const inferenceStart = performance.now();
          let inferenceThrew = false;
          try {
            detections = await detector.detect(video);
            inferenceMs = performance.now() - inferenceStart;
          } catch {
            inferenceMs = performance.now() - inferenceStart;
            inferenceThrew = true;
            logAiCameraDebug("tick: inference threw", { modelLoaded: true, inferenceMs });
          }

          if (!inferenceThrew) {
            const phoneThreshold = PHONE_CONFIDENCE_THRESHOLD;
            const personThreshold = 0.6;
            const phone = evaluatePhoneDetections(detections, phoneThreshold);
            const person = evaluatePersonDetections(detections, personThreshold);

            logAiCameraDebug("tick: inference complete", {
              modelLoaded: true,
              inferenceMs,
              cadenceMs: currentDetectionDelayMs,
              rawDetections: detections.map((d) => ({ className: d.className, score: d.score })),
              phoneThreshold,
              personThreshold,
              phoneDetected: phone.detected,
              phoneConfidence: phone.confidence,
              personCount: person.personCount,
            });

            // Phone is the urgent exception: `conditionMet` is true on the
            // first qualifying detection rather than waiting for a second
            // consecutive tick (see decidePhoneEmission), since a student
            // may show a phone only briefly. `shouldEmit` (backend
            // logging) still respects the cooldown, so a phone that stays
            // visible doesn't flood the evidence timeline with repeat
            // events — but the local overlay, driven by `conditionMet`
            // below, is not held back by that same cooldown.
            const phoneCooldownOk = cooldown.canEmit("POSSIBLE_PHONE_VISIBLE", now, 45_000);
            const secondPersonCount = cooldown.recordObservation("secondPerson", person.multiplePersons);
            const secondPersonCooldownOk = cooldown.canEmit("POSSIBLE_SECOND_PERSON_VISIBLE", now, 45_000);
            const noPersonCount = cooldown.recordObservation("noPerson", person.noPersonDetected);
            const noPersonCooldownOk = cooldown.canEmit("NO_PERSON_VISIBLE", now, 45_000);

            // Camera Startup Readiness v1 — counters above keep tracking
            // consecutive observations even during warm-up (so a signal
            // that's still true once warm-up ends can confirm quickly),
            // but the decisions themselves are forced to "nothing
            // detected" while suppressStartup is true — never emits an
            // event or shows the local overlay for a warm-up frame.
            phoneDecision = suppressStartup
              ? { conditionMet: false, shouldEmit: false, confidenceBand: null }
              : decidePhoneEmission(phone, phoneCooldownOk);
            secondPersonDecision = suppressStartup
              ? { conditionMet: false, shouldEmit: false, confidenceBand: null }
              : decideSecondPersonEmission(person, secondPersonCount, secondPersonCooldownOk);
            noPersonDecision = suppressStartup
              ? { conditionMet: false, shouldEmit: false }
              : decideNoPersonEmission(person, noPersonCount, noPersonCooldownOk);

            logAiCameraDebug("tick: phone decision", {
              phoneDetected: phone.detected,
              phoneConfidence: phone.confidence,
              phoneThreshold,
              conditionMet: phoneDecision.conditionMet,
              backendLogCooldownOk: phoneCooldownOk,
              backendLogSent: phoneDecision.shouldEmit,
              confidenceBand: phoneDecision.confidenceBand,
            });

            logAiCameraDebug("tick: second-person decision", {
              multiplePersons: person.multiplePersons,
              multiplePersonsHighConfidence: person.multiplePersonsHighConfidence,
              consecutiveCount: secondPersonCount,
              conditionMet: secondPersonDecision.conditionMet,
              backendLogCooldownOk: secondPersonCooldownOk,
              backendLogSent: secondPersonDecision.shouldEmit,
              confidenceBand: secondPersonDecision.confidenceBand,
            });

            logAiCameraDebug("tick: no-person decision", {
              noPersonDetected: person.noPersonDetected,
              consecutiveCount: noPersonCount,
              conditionMet: noPersonDecision.conditionMet,
              backendLogCooldownOk: noPersonCooldownOk,
              backendLogSent: noPersonDecision.shouldEmit,
            });

            if (phoneDecision.shouldEmit) {
              cooldown.markEmitted("POSSIBLE_PHONE_VISIBLE", now);
              reportIntegrityEvent("POSSIBLE_PHONE_VISIBLE", {
                source: "on_device_camera_ai",
                confidence: phone.confidence,
                confidenceBand: phoneDecision.confidenceBand,
                modelName: detector.modelName,
                modelVersion: detector.modelVersion,
                detectionIntervalSeconds: currentDetectionDelayMs / 1000,
              });
            }

            if (secondPersonDecision.shouldEmit) {
              cooldown.markEmitted("POSSIBLE_SECOND_PERSON_VISIBLE", now);
              reportIntegrityEvent("POSSIBLE_SECOND_PERSON_VISIBLE", {
                source: "on_device_camera_ai",
                confidenceBand: secondPersonDecision.confidenceBand,
                modelName: detector.modelName,
                modelVersion: detector.modelVersion,
                detectionIntervalSeconds: currentDetectionDelayMs / 1000,
              });
            }

            if (noPersonDecision.shouldEmit) {
              cooldown.markEmitted("NO_PERSON_VISIBLE", now);
              reportIntegrityEvent("NO_PERSON_VISIBLE", {
                source: "on_device_camera_ai",
                confidenceBand: "medium",
                modelName: detector.modelName,
                modelVersion: detector.modelVersion,
                detectionIntervalSeconds: currentDetectionDelayMs / 1000,
              });
            }
          }
        }

        // Local overlay refresh — runs every tick regardless of the
        // backend-logging cooldown above. This is the fix for slow/never
        // re-detection after "I understand — continue": acknowledging
        // only clears the previously-shown overlay object, it never
        // touches the cooldown tracker or this recomputation, so if the
        // same condition is still true on the very next tick the overlay
        // reopens immediately; if it cleared, the overlay stays cleared;
        // if a different condition is true, its overlay shows instead.
        // See src/lib/aiCameraViolationOverlay.ts.
        const activeConditions = [
          { eventType: "POSSIBLE_PHONE_VISIBLE", conditionMet: phoneDecision.conditionMet },
          { eventType: "POSSIBLE_SECOND_PERSON_VISIBLE", conditionMet: secondPersonDecision.conditionMet },
          { eventType: "NO_PERSON_VISIBLE", conditionMet: noPersonDecision.conditionMet },
          { eventType: "CAMERA_VIEW_BLOCKED", conditionMet: blockedDecision.conditionMet },
          { eventType: "CAMERA_TOO_DARK", conditionMet: darkDecision.conditionMet },
        ];
        const nextOverlay = computeLocalAiCameraOverlay(activeConditions);
        const currentOverlay = aiCameraViolationOverlayRef.current;

        logAiCameraDebug("tick: local overlay decision", {
          violationPresent: nextOverlay != null,
          activeReason: nextOverlay?.reason ?? null,
          overlayAwaitingAcknowledgement: currentOverlay != null,
          overlayWillChange: (currentOverlay?.reason ?? null) !== (nextOverlay?.reason ?? null),
        });

        if ((currentOverlay?.reason ?? null) !== (nextOverlay?.reason ?? null)) {
          // Avoids setState (and any resulting re-render/flicker) on
          // every tick when nothing has actually changed — only updates
          // when the overlay is newly appearing, newly clearing, or
          // switching to a different violation's reason.
          aiCameraViolationOverlayRef.current = nextOverlay;
          setAiCameraViolationOverlay(nextOverlay);
        }
      } finally {
        if (!cancelled) {
          currentDetectionDelayMs = computeNextDetectionDelayMs(inferenceMs);
          detectionTimer.current = setTimeout(runDetectionTick, currentDetectionDelayMs);
        }
      }
    }

    // Run the first tick immediately — preconditions (stream granted, gate
    // acknowledged, exam IN_PROGRESS) are already satisfied by the time this
    // effect runs. If the detection video hasn't loaded metadata yet, the
    // readyState/videoWidth guard in runDetectionTick makes it a harmless
    // no-op for that tick, and the finally block still schedules the next attempt.
    void runDetectionTick();

    return () => {
      cancelled = true;
      stopAiDetection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secureSettings?.enableAiCameraIntegrityChecks, gateAcknowledged, cameraStatus, data?.status]);

  function handleConfirmVerification() {
    setVerificationConfirmed(true);
    reportIntegrityEvent("STUDENT_VERIFICATION_CONFIRMED");
  }

  // Acknowledging the AI camera violation overlay only clears local UI
  // state — it never deletes or modifies the backend IntegrityEvent, and
  // detection keeps running, so the overlay may reappear later if the
  // same signal persists past its cooldown. Never auto-submits and never
  // permanently locks the exam.
  function acknowledgeAiCameraViolationOverlay() {
    // Clears ONLY the local overlay display — never the backend
    // IntegrityEvent, and never the detection loop or its cooldown
    // tracker. The ref is updated synchronously (not just via the
    // state-sync effect) so that if the next detection tick's setTimeout
    // fires before React has re-rendered, it still reads the correct
    // (cleared) value rather than a stale one. If the same condition is
    // still present, the very next tick's local-overlay refresh reopens
    // it — see the detection effect above and
    // src/lib/aiCameraViolationOverlay.ts.
    aiCameraViolationOverlayRef.current = clearAiCameraViolationOverlay();
    setAiCameraViolationOverlay(aiCameraViolationOverlayRef.current);
  }

  async function handleStartSecureExam() {
    if (secureSettings?.requireFullscreen) {
      const ok = await enterFullscreen();
      if (!ok) return; // stay on the checklist; never trap the student
    }
    setGateAcknowledged(true);
  }

  const saveAnswer = useCallback(
    (questionId: string, response: string) => {
      clearTimeout(saveTimers.current[questionId]);
      saveTimers.current[questionId] = setTimeout(() => {
        fetch(`/api/submissions/${id}/answers`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, response }),
        })
          .then((res) => {
            if (!res.ok && secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
          })
          .catch(() => {
            if (secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
          });
      }, 600);
    },
    [id, secureModeEnabled, reportIntegrityEvent],
  );

  function handleChange(questionId: string, value: string) {
    if (submitting || autoSubmitLocked || timerStopped) return;
    setResponses((prev) => ({ ...prev, [questionId]: value }));
    saveAnswer(questionId, value);
  }

  if (!data && loadError) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{loadError}</p>
          <button onClick={() => loadSubmission()} className="mt-2 text-sm underline">
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!data) return <p className="text-gray-500">Loading...</p>;

  if (data.status !== "IN_PROGRESS") {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        <p className="mt-4 text-gray-700">
          {submitMessage ??
            (inLockdownBrowser
              ? "Your exam has been submitted. You may now close Tether Secure Browser."
              : "Your exam has been submitted.")}
        </p>
        {inLockdownBrowser && (
          <p className="mt-2 text-sm text-gray-500">
            Keep Tether Secure Browser installed if you have more SES exams
            scheduled. Uninstall it only after your final SES exam or when
            your institution/pilot operator instructs you to remove it.
          </p>
        )}
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={() => router.push("/student")}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
          >
            Return to student dashboard
          </button>
          {inLockdownBrowser && (
            <button
              type="button"
              onClick={() => router.push("/lockdown-browser")}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            >
              View uninstall instructions
            </button>
          )}
        </div>
        {data.status === "SUBMITTED" && (
          <p className="mt-4 text-gray-600">
            Your exam has been submitted. Your marks will appear here after your lecturer releases them.
          </p>
        )}
        {data.status === "GRADED" && !data.marksReleased && (
          <p className="mt-4 text-gray-600">
            Submitted. Marks have not been released yet.
          </p>
        )}
        {data.status === "GRADED" && data.marksReleased && (
          <div className="mt-4">
            <p className="text-sm text-green-700">Marks released</p>
            <p className="text-lg">
              Score: <span className="font-semibold">{data.totalScore}</span>
            </p>
            <div className="mt-4 space-y-3">
              {data.exam.questions.map((q) => {
                const answer = data.answers.find((a) => a.questionId === q.id);
                return (
                  <div key={q.id} className="rounded border border-gray-200 p-3">
                    <p className="text-sm text-gray-500">{q.points} pt(s)</p>
                    <p>{q.text}</p>
                    <p className="mt-1 text-sm text-gray-600">
                      Your answer: {answer?.response ?? "(no answer)"}
                    </p>
                    {answer?.score != null && (
                      <p className="text-sm text-green-700">Score: {answer.score}</p>
                    )}
                    {answer?.feedback && (
                      <p className="text-sm text-gray-500">Feedback: {answer.feedback}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  const requireCamera = secureSettings?.requireCamera ?? false;
  const requireStudentVerification = secureSettings?.requireStudentVerification ?? false;
  const enableAiCameraIntegrityChecks = secureSettings?.enableAiCameraIntegrityChecks ?? false;
  const captureAiViolationEvidence = secureSettings?.captureAiViolationEvidence ?? false;
  const enableExamWatermark = secureSettings?.enableExamWatermark ?? false;
  const verificationGateSatisfied = !requireStudentVerification || verificationConfirmed;
  const cameraGateSatisfied =
    (!requireCamera || cameraStatus === "granted") && verificationGateSatisfied;

  // Temporary dev-only diagnostic for the production secureSettings
  // display investigation — never fires outside NODE_ENV=development,
  // and only when explicitly opted in via localStorage. Remove once the
  // production/local mismatch is resolved.
  if (
    process.env.NODE_ENV === "development" &&
    typeof window !== "undefined" &&
    window.localStorage.getItem("sesSecureSettingsDebug") === "true"
  ) {
    console.log("[sesSecureSettingsDebug] gate state:", {
      parsedSecureSettings: secureSettings,
      requireCamera,
      cameraStatus,
      cameraGateSatisfied,
    });
  }

  if (secureModeEnabled && !gateAcknowledged) {
    return (
      <div className="mx-auto max-w-lg">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        <div className="mt-4 rounded border border-gray-200 p-4">
          <p className="font-medium">Before you begin</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-gray-700">
            <li>The exam timer will start as soon as you begin and cannot be paused.</li>
            <li>Stay in the exam window for the duration of the exam.</li>
            <li>
              Fullscreen is {secureSettings?.requireFullscreen ? "required" : "recommended"} for
              this exam.
            </li>
            {(secureSettings?.blockCopyPaste || secureSettings?.blockRightClick) && (
              <li>Copy/paste and right-click may be restricted during this exam.</li>
            )}
            {secureSettings?.blockKeyboardShortcuts && (
              <li>Selected keyboard shortcuts may be blocked where the browser allows it.</li>
            )}
            {requireCamera && <li>This exam requires camera access.</li>}
            <li>Exam integrity signals (such as switching windows) may be recorded for lecturer review.</li>
            <li>Network interruptions during the exam may be logged.</li>
            {enableAiCameraIntegrityChecks && (
              <li>
                AI-assisted camera integrity checks are enabled for this exam. During this exam,
                your camera may be checked locally on your device for integrity signals such as
                whether a phone or another person may be visible. Video is not recorded, streamed,
                or stored. Any signals are indicators for lecturer review, not automatic misconduct
                decisions.
              </li>
            )}
            {enableAiCameraIntegrityChecks && captureAiViolationEvidence && (
              <li>
                This exam may save a single low-resolution camera evidence frame if a possible
                phone or second person is detected. No video is recorded. Evidence is available
                only to authorised reviewers.
              </li>
            )}
            {enableExamWatermark && (
              <li>
                This exam may display a watermark containing your student identifier, attempt ID,
                and timestamp to discourage copying, sharing, screenshots, and uploading assessment
                content to AI tools.
              </li>
            )}
            {oneQuestionAtATime && (
              <li>
                This exam shows one question at a time. Your answers are saved as you move between
                questions.
                {!allowBackNavigation && " You may not be able to return to previous questions after moving forward."}
              </li>
            )}
            <li>
              Your lecturer and institution make the final academic integrity decision — recorded
              signals are evidence for human review, not an automatic judgment.
            </li>
          </ul>

          {fullscreenDenied && (
            <p className="mt-3 text-sm text-red-600">
              Fullscreen was not enabled. Your browser may have blocked the request — try clicking
              the button again, or check your browser&apos;s permission prompt.
            </p>
          )}

          {requireStudentVerification && (
            <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3">
              <p className="text-sm font-medium">Confirm your identity</p>
              <dl className="mt-2 text-sm text-gray-700">
                <div className="flex gap-2">
                  <dt className="text-gray-500">Name:</dt>
                  <dd>{data.student.name}</dd>
                </div>
                {data.student.institutionStudentId && (
                  <div className="flex gap-2">
                    <dt className="text-gray-500">Student ID:</dt>
                    <dd>{data.student.institutionStudentId}</dd>
                  </div>
                )}
                <div className="flex gap-2">
                  <dt className="text-gray-500">Email:</dt>
                  <dd>{data.student.email}</dd>
                </div>
              </dl>
              <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={verificationChecked}
                  onChange={(e) => setVerificationChecked(e.target.checked)}
                  disabled={verificationConfirmed}
                />
                I confirm I am the student listed above and I will complete this exam myself.
              </label>
              {!verificationConfirmed ? (
                <button
                  onClick={handleConfirmVerification}
                  disabled={!verificationChecked}
                  className="mt-2 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  Confirm identity
                </button>
              ) : (
                <p className="mt-2 text-sm text-green-700">Identity confirmed.</p>
              )}
              <p className="mt-2 text-xs text-gray-500">
                This is a self-confirmation step only — no photo ID scan, face comparison, or
                image is captured or stored.
              </p>
            </div>
          )}

          {requireCamera && (
            <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3">
              <p className="text-sm font-medium">This exam requires camera access.</p>
              {cameraStatus !== "granted" && (
                <>
                  <button
                    onClick={startCamera}
                    disabled={cameraStatus === "requesting"}
                    className="mt-2 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    {cameraStatus === "requesting" ? "Requesting..." : "Enable camera"}
                  </button>
                  {cameraStatus === "denied" && (
                    <p className="mt-2 text-sm text-red-600">
                      Camera access is required for this exam. Please allow camera access in your
                      browser settings and try again.
                    </p>
                  )}
                </>
              )}
              {cameraStatus === "granted" && secureSettings?.showCameraPreview && (
                <div className="mt-2">
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    className="w-48 rounded border border-gray-300"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Your camera preview — only you can see this
                  </p>
                </div>
              )}
              {cameraStatus === "granted" && !secureSettings?.showCameraPreview && (
                <p className="mt-2 text-sm text-green-700">Camera enabled.</p>
              )}
            </div>
          )}

          {requireStudentVerification && !verificationConfirmed && (
            <p className="mt-3 text-sm text-red-600">
              Please confirm your identity above before starting the exam.
            </p>
          )}
          <button
            onClick={handleStartSecureExam}
            disabled={!cameraGateSatisfied}
            className="mt-4 rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Start secure exam
          </button>
          <a
            href="/privacy/student-exam-notice"
            target="_blank"
            rel="noreferrer"
            className="mt-3 block text-xs underline"
          >
            What does this record?
          </a>
        </div>
      </div>
    );
  }

  const minutes = remainingSecs != null ? Math.floor(remainingSecs / 60) : null;
  const seconds = remainingSecs != null ? remainingSecs % 60 : null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{data.exam.title}</h1>
        {remainingSecs != null && (
          <span className="rounded bg-gray-100 px-3 py-1 font-mono text-sm">
            {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
          </span>
        )}
      </div>

      {inLockdownBrowser && !secureModeEnabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
          <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
            Tether Browser Active
          </span>
        </div>
      )}

      {secureModeEnabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
            Secure Exam Mode active
          </span>
          {inLockdownBrowser && (
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
              Tether Browser Active
            </span>
          )}
          <span>Integrity events are logged for review.</span>
          {secureSettings?.requireFullscreen && !isFullscreen && (
            <>
              <span className="text-gray-500">
                {fullscreenReturnNeeded ? "Please return to fullscreen." : "Fullscreen required."}
              </span>
              <button
                onClick={enterFullscreen}
                className="rounded border border-gray-300 bg-white px-2 py-1 text-xs"
              >
                {fullscreenReturnNeeded ? "Return to fullscreen" : "Enter fullscreen"}
              </button>
            </>
          )}
          {requireCamera && cameraStatus === "granted" && (
            <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
              Camera monitoring active
            </span>
          )}
          {enableAiCameraIntegrityChecks && cameraStatus === "granted" && (
            <span
              className={
                aiCheckStatus === "unavailable" || cameraStartupPhaseState === "timed_out"
                  ? "rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                  : cameraStartupPhaseState !== "ready"
                    ? "rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700"
                    : "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
              }
            >
              {aiCheckStatus === "unavailable"
                ? "Camera integrity checks unavailable"
                : cameraStartupPhaseState === "timed_out"
                  ? "Camera setup issue — checks unavailable"
                  : cameraStartupPhaseState !== "ready"
                    ? "Starting camera checks..."
                    : "Camera integrity checks active"}
            </span>
          )}
          <a href="/privacy/student-exam-notice" target="_blank" rel="noreferrer" className="text-xs underline">
            What does this record?
          </a>
        </div>
      )}

      {banner && (
        <div className="mt-3 rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          {banner}
        </div>
      )}

      {cameraWarning && (
        <div className="mt-3 rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          {cameraWarning}
          <button
            onClick={handleRestoreCamera}
            className="ml-3 rounded border border-yellow-400 bg-white px-2 py-1 text-xs"
          >
            Restore camera
          </button>
        </div>
      )}

      {/* Persistent Camera Preview v1 — live-only, never recorded or
          uploaded (see docs/known-limitations.md). Minimize/restore is
          local UI state only: it never creates an IntegrityEvent and
          never pauses the stream or heartbeat above. */}
      {requireCamera && cameraStatus === "granted" && secureSettings?.showCameraPreview && (
        <div className="fixed bottom-4 right-4 z-50">
          {cameraPreviewMinimized ? (
            <button
              onClick={toggleCameraPreviewMinimized}
              className="flex items-center gap-2 rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs shadow"
              aria-label="Expand camera preview"
            >
              <span className="h-2 w-2 rounded-full bg-green-500" />
              Camera active
              <span aria-hidden>▸</span>
            </button>
          ) : (
            <div className="rounded border border-gray-300 bg-white p-2 shadow">
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="text-xs text-gray-500">Your camera — only you can see this</span>
                <button
                  onClick={toggleCameraPreviewMinimized}
                  className="rounded border border-gray-300 px-1.5 py-0.5 text-xs"
                  aria-label="Minimize camera preview"
                >
                  <span aria-hidden>▾</span>
                </button>
              </div>
              <video
                ref={examVideoRef}
                autoPlay
                muted
                playsInline
                className="w-40 rounded border border-gray-200"
              />
              {/* Camera Startup Readiness v1 — a calm, non-alarming
                  status message during the brief warm-up window, never
                  the violation overlay (see
                  docs/on-device-ai-integrity-detection-v1.md). */}
              {enableAiCameraIntegrityChecks &&
                (cameraStartupPhaseState === "waiting_for_first_frame" ||
                  cameraStartupPhaseState === "warming_up") && (
                  <p className="mt-1 text-xs text-gray-500">
                    Camera is starting. Please keep your face visible.
                  </p>
                )}
              {enableAiCameraIntegrityChecks && cameraStartupPhaseState === "timed_out" && (
                <p className="mt-1 text-xs text-amber-700">
                  Camera checks could not start. You can continue your exam — try refreshing the
                  camera if this persists.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* On-Device AI Camera Integrity Detection v1 — hidden, always-
          mounted video element used only for local frame sampling.
          Kept separate from the visible preview above so detection
          keeps running even while the preview is minimized. Never
          rendered visibly, never uploaded, never recorded. */}
      {requireCamera && cameraStatus === "granted" && enableAiCameraIntegrityChecks && (
        <video ref={detectionVideoRef} autoPlay muted playsInline style={{ display: "none" }} />
      )}

      <div className="relative">
        {/* Exam Watermark v1 — see docs/exam-watermark-v1.md. A visible,
            low-opacity, non-disruptive deterrent overlay, never a
            blur/hide — explicitly not the "hide question content when
            integrity is uncertain" approach this feature deliberately
            avoids. Always on top (rendered after the question content
            below) but pointer-events: none and aria-hidden, so it never
            blocks typing, reading, or assistive tech. */}
        {enableExamWatermark && <ExamWatermark student={data.student} submissionId={data.id} />}
        {/* On-Device AI Camera Integrity Detection v1 — local exam-content
            blur, distinct from browser/window blur. Blurred and made
            non-interactive only while an AI camera violation overlay is
            active; the modal below is a sibling (not a descendant), so it
            stays sharp and clickable. See src/lib/aiCameraViolationOverlay.ts. */}
        <div
          className={aiCameraViolationOverlay ? "pointer-events-none select-none blur-sm" : undefined}
          aria-hidden={aiCameraViolationOverlay ? true : undefined}
        >
          {oneQuestionAtATime ? (
            // One-Question-At-A-Time Exam Delivery v1 — see
            // docs/one-question-delivery-v1.md. Renders only
            // oneQuestion.payload.question (from GET/POST
            // .../question(-progress)) — data.exam.questions is empty in
            // this mode, the server never sends the full paper.
            <div className="mt-6">
              {oneQuestion.loading && <p className="text-gray-500">Loading question...</p>}
              {!oneQuestion.loading && oneQuestion.payload && (
                <div className="rounded border border-gray-200 p-4">
                  <p className="text-sm text-gray-500">
                    Question {oneQuestion.payload.currentIndex + 1} of {oneQuestion.payload.totalQuestions}{" "}
                    · {oneQuestion.payload.question.points} pt(s)
                  </p>
                  <p
                    className="mt-1"
                    style={secureSettings?.disableQuestionTextSelection ? { userSelect: "none" } : undefined}
                  >
                    {oneQuestion.payload.question.text}
                  </p>

                  {oneQuestion.payload.question.type === "MULTIPLE_CHOICE" &&
                    oneQuestion.payload.question.options && (
                      <div className="mt-2 space-y-1">
                        {oneQuestion.payload.question.options.map((opt) => (
                          <label key={opt} className="flex items-center gap-2 text-sm">
                            <input
                              type="radio"
                              name={oneQuestion.payload!.question.id}
                              value={opt}
                              checked={responses[oneQuestion.payload!.question.id] === opt}
                              onChange={(e) => handleChange(oneQuestion.payload!.question.id, e.target.value)}
                              disabled={submitting || autoSubmitLocked || timerStopped || navigatingQuestion}
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                    )}

                  {oneQuestion.payload.question.type === "SHORT_ANSWER" && (
                    <input
                      className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                      value={responses[oneQuestion.payload.question.id] ?? ""}
                      onChange={(e) => handleChange(oneQuestion.payload!.question.id, e.target.value)}
                      disabled={submitting || autoSubmitLocked || timerStopped || navigatingQuestion}
                    />
                  )}

                  {oneQuestion.payload.question.type === "ESSAY" && (
                    <textarea
                      rows={5}
                      className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                      value={responses[oneQuestion.payload.question.id] ?? ""}
                      onChange={(e) => handleChange(oneQuestion.payload!.question.id, e.target.value)}
                      disabled={submitting || autoSubmitLocked || timerStopped || navigatingQuestion}
                    />
                  )}

                  <div className="mt-4 flex items-center gap-2">
                    {oneQuestion.payload.canGoPrevious && (
                      <button
                        type="button"
                        onClick={() => navigateQuestion(oneQuestion.payload!.currentIndex - 1)}
                        disabled={submitting || autoSubmitLocked || timerStopped || navigatingQuestion}
                        className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
                      >
                        Previous
                      </button>
                    )}
                    {oneQuestion.payload.canGoNext && (
                      <button
                        type="button"
                        onClick={() => navigateQuestion(oneQuestion.payload!.currentIndex + 1)}
                        disabled={submitting || autoSubmitLocked || timerStopped || navigatingQuestion}
                        className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
                      >
                        Next
                      </button>
                    )}
                    {navigatingQuestion && <span className="text-xs text-gray-500">Saving...</span>}
                  </div>
                  {oneQuestion.error && <p className="mt-2 text-sm text-red-600">{oneQuestion.error}</p>}
                </div>
              )}
              {!oneQuestion.loading && !oneQuestion.payload && oneQuestion.error && (
                <p className="text-red-600">{oneQuestion.error}</p>
              )}
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              {data.exam.questions.map((q, i) => (
                <div key={q.id} className="rounded border border-gray-200 p-4">
                  <p
                    className="text-sm text-gray-500"
                    style={secureSettings?.disableQuestionTextSelection ? { userSelect: "none" } : undefined}
                  >
                    Q{i + 1} · {q.points} pt(s)
                  </p>
                  <p
                    className="mt-1"
                    style={secureSettings?.disableQuestionTextSelection ? { userSelect: "none" } : undefined}
                  >
                    {q.text}
                  </p>

                  {q.type === "MULTIPLE_CHOICE" && q.options && (
                    <div className="mt-2 space-y-1">
                      {q.options.map((opt) => (
                        <label
                          key={opt}
                          className="flex items-center gap-2 text-sm"
                          style={
                            secureSettings?.disableQuestionTextSelection ? { userSelect: "none" } : undefined
                          }
                        >
                          <input
                            type="radio"
                            name={q.id}
                            value={opt}
                            checked={responses[q.id] === opt}
                            onChange={(e) => handleChange(q.id, e.target.value)}
                            disabled={submitting || autoSubmitLocked || timerStopped}
                          />
                          {opt}
                        </label>
                      ))}
                    </div>
                  )}

                  {q.type === "SHORT_ANSWER" && (
                    <input
                      className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                      value={responses[q.id] ?? ""}
                      onChange={(e) => handleChange(q.id, e.target.value)}
                      disabled={submitting || autoSubmitLocked || timerStopped}
                    />
                  )}

                  {q.type === "ESSAY" && (
                    <textarea
                      rows={5}
                      className="mt-2 w-full rounded border border-gray-300 px-3 py-2"
                      value={responses[q.id] ?? ""}
                      onChange={(e) => handleChange(q.id, e.target.value)}
                      disabled={submitting || autoSubmitLocked || timerStopped}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() =>
              remainingSecs === 0 && data.exam.secureSettings.autoSubmitOnTimerEnd
                ? handleSubmit({ systemAutoSubmit: true })
                : handleSubmit()
            }
            disabled={submitting || autoSubmitLocked || timerStopped}
            className="mt-6 rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit exam"}
          </button>
          {submitMessage && <p className="mt-2 text-sm text-red-600">{submitMessage}</p>}
        </div>

        {aiCameraViolationOverlay && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-sm rounded border border-gray-300 bg-white p-5 shadow-lg">
              <p className="text-base font-semibold">{aiCameraViolationOverlay.title}</p>
              <p className="mt-2 text-sm text-gray-700">{aiCameraViolationOverlay.reason}</p>
              <p className="mt-2 text-sm text-gray-600">
                Please return to the expected exam conditions before continuing.
              </p>
              <button
                onClick={acknowledgeAiCameraViolationOverlay}
                className="mt-4 rounded bg-black px-4 py-2 text-sm text-white"
              >
                I understand — continue
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
