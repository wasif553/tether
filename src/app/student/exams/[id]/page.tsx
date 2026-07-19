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
  type DetectedObject,
} from "@/lib/cameraIntegrityDetection";
// Camera Startup Lifecycle v2 — see
// docs/on-device-ai-integrity-detection-v1.md ("Camera startup
// lifecycle"). Replaces the old flat 3-second-grace-period approach: the
// camera is only ever considered READY after 3 consecutive genuinely
// rendered frames plus a settle-time warm-up, never merely because
// getUserMedia() resolved.
import {
  isRenderedFrameValid,
  nextConsecutiveRenderedFrameCount,
  hasReachedFrameReadiness,
  resetCameraLifecycleTimers,
  initialCameraLifecycleTimers,
  isDetectionArmed,
  isDetectionFullyArmed,
  shouldSuppressFocusEvent,
  shouldAutoRetry,
  isCurrentGeneration,
  CAMERA_WARMUP_MS,
  CAMERA_READY_TIMEOUT_MS,
  CAMERA_RETRY_DELAY_MS,
  DETECTION_SAMPLING_WARMUP_MS,
  DETECTION_SAMPLING_STARTUP_TIMEOUT_MS,
  DETECTION_SAMPLING_MAX_RETRIES,
  DETECTION_SAMPLING_RETRY_DELAY_MS,
  type CameraLifecycleState,
  type CameraLifecycleTimers,
} from "@/lib/cameraLifecycle";
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
  // Question Navigator v1 — see docs/question-navigator-v1.md.
  showQuestionNavigator: boolean;
  allowQuestionJumping: boolean;
  allowFlagForReview: boolean;
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

// Question Navigator v1 — see docs/question-navigator-v1.md. Safe
// metadata only — never question text, options, correct answers, answer
// text, or unselected questions.
type NavigatorQuestionState = "CURRENT" | "ANSWERED" | "SKIPPED" | "NOT_VISITED";

type NavigatorQuestionTile = {
  questionId: string;
  index: number;
  number: number;
  state: NavigatorQuestionState;
  flaggedForReview: boolean;
  locked: boolean;
  canNavigate: boolean;
};

type NavigatorResponseDto = {
  submissionId: string;
  currentQuestionIndex: number;
  totalQuestions: number;
  settings: {
    showQuestionNavigator: boolean;
    allowQuestionJumping: boolean;
    allowBackNavigation: boolean;
    allowFlagForReview: boolean;
  };
  progress: {
    answeredCount: number;
    unansweredCount: number;
    flaggedCount: number;
    visitedCount: number;
  };
  questions: NavigatorQuestionTile[];
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

// Question Navigator v1 — see docs/question-navigator-v1.md. Presentation
// only: every state shown here is exactly what the server already
// authorised in `navigator.questions[].locked/canNavigate` — clicking a
// tile never bypasses server policy, it only ever requests a move the
// server may still reject.
const NAVIGATOR_STATE_STYLES: Record<NavigatorQuestionState, string> = {
  CURRENT: "border-2 border-black bg-white text-black",
  ANSWERED: "border border-green-300 bg-green-50 text-green-800",
  SKIPPED: "border border-amber-300 bg-amber-50 text-amber-800",
  NOT_VISITED: "border border-gray-200 bg-gray-50 text-gray-500",
};

const NAVIGATOR_STATE_ICON: Record<NavigatorQuestionState, string> = {
  CURRENT: "◆",
  ANSWERED: "✓",
  SKIPPED: "…",
  NOT_VISITED: "",
};

/** First tile matching `predicate` that the server already marked navigable — never bypasses server policy (it only ever picks among what canNavigate already permits). */
function findFirstNavigableIndex(nav: NavigatorResponseDto, predicate: (tile: { answered: boolean; flaggedForReview: boolean }) => boolean): number | null {
  const match = nav.questions.find((t) => predicate({ answered: t.state === "ANSWERED", flaggedForReview: t.flaggedForReview }) && t.canNavigate);
  return match ? match.index : null;
}

// Camera Startup Lifecycle v2 — see docs/on-device-ai-integrity-detection-v1.md.
// Neutral, non-accusatory operational messages only — never "Camera
// blocked" / "Integrity violation" / "Suspicious behaviour" during
// ordinary startup.
function cameraLifecycleStatusMessage(state: CameraLifecycleState): string {
  switch (state) {
    case "IDLE":
      return "";
    case "REQUESTING_PERMISSION":
    case "RETRYING":
      return "Starting camera checks…";
    case "PERMISSION_GRANTED":
    case "STREAM_RECEIVED":
    case "VIDEO_ATTACHED":
    case "WAITING_FOR_PLAYBACK":
      return "Waiting for the camera preview…";
    case "WAITING_FOR_FIRST_FRAME":
    case "WARMING_UP":
      return "Preparing camera integrity checks…";
    case "READY":
      return "Camera monitoring active";
    case "FAILED":
      return "Camera could not start. Check browser permission and try again.";
  }
}

function navigatorTileLabel(tile: NavigatorQuestionTile): string {
  const parts = [`Question ${tile.number}`];
  if (tile.state === "CURRENT") parts.push("current question");
  else if (tile.state === "ANSWERED") parts.push("answered");
  else if (tile.state === "SKIPPED") parts.push("visited but unanswered");
  else parts.push("not visited");
  if (tile.flaggedForReview) parts.push("flagged for review");
  if (tile.locked) parts.push("locked — navigation not available for this question");
  return parts.join(", ");
}

function QuestionNavigatorPanel({
  navigator,
  open,
  onToggleOpen,
  disabled,
  onSelectQuestion,
}: {
  navigator: NavigatorResponseDto;
  open: boolean;
  onToggleOpen: () => void;
  disabled: boolean;
  onSelectQuestion: (index: number) => void;
}) {
  return (
    <div className="mb-4 rounded border border-gray-200">
      {/* Mobile/tablet: collapsible section (Part 9). Desktop keeps it
          expanded by default via the sm:block override below, without
          needing separate markup. */}
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium sm:cursor-default"
        aria-expanded={open}
      >
        <span>
          Question {navigator.currentQuestionIndex + 1} of {navigator.totalQuestions}
        </span>
        <span className="sm:hidden">{open ? "Hide" : "Show"} question navigator</span>
      </button>
      <div className={`${open ? "block" : "hidden"} border-t border-gray-100 p-3 sm:block sm:border-t-0`}>
        <div className="flex flex-wrap gap-3 text-xs text-gray-600">
          <span>{navigator.progress.answeredCount} answered</span>
          <span>{navigator.progress.unansweredCount} unanswered</span>
          {navigator.settings.allowFlagForReview && <span>{navigator.progress.flaggedCount} flagged</span>}
        </div>
        {/* Compact, left-aligned wrapping group — NOT a fixed-column grid,
            which would stretch a small tile count across the whole panel
            width. Each tile has a fixed 40px size; gap-2 (8px) matches the
            requested spacing regardless of how many tiles there are. */}
        <div className="mt-1.5 flex flex-wrap items-start justify-start gap-2">
          {navigator.questions.map((tile) => (
            <button
              key={tile.questionId}
              type="button"
              disabled={disabled || tile.locked}
              onClick={() => onSelectQuestion(tile.index)}
              aria-current={tile.state === "CURRENT" ? "step" : undefined}
              aria-label={navigatorTileLabel(tile)}
              title={navigatorTileLabel(tile)}
              className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-60 ${NAVIGATOR_STATE_STYLES[tile.state]}`}
            >
              {tile.number}
              {NAVIGATOR_STATE_ICON[tile.state] && (
                <span aria-hidden="true" className="absolute -right-1 -top-1 text-[10px]">
                  {NAVIGATOR_STATE_ICON[tile.state]}
                </span>
              )}
              {tile.flaggedForReview && (
                <span aria-hidden="true" className="absolute -left-1 -top-1 text-[10px]">
                  🚩
                </span>
              )}
              {tile.locked && (
                <span aria-hidden="true" className="absolute -bottom-1 -right-1 text-[10px]">
                  🔒
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 border-t border-gray-100 pt-2 text-xs text-gray-500">
          <span>◆ Current</span>
          <span>✓ Answered</span>
          <span>… Skipped</span>
          {navigator.settings.allowFlagForReview && <span>🚩 Flagged</span>}
          <span>Not visited</span>
          <span>🔒 Locked</span>
        </div>
      </div>
    </div>
  );
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
  // Question Navigator v1 — see docs/question-navigator-v1.md.
  const [questionNav, setQuestionNav] = useState<NavigatorResponseDto | null>(null);
  const [navigatorPanelOpen, setNavigatorPanelOpen] = useState(false);
  const [navigatorAnnouncement, setNavigatorAnnouncement] = useState("");
  const [flaggingQuestionId, setFlaggingQuestionId] = useState<string | null>(null);
  const [showReviewModal, setShowReviewModal] = useState(false);
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

  // --- Exam Session Binding v1 ---
  // Periodic, best-effort heartbeat only — see
  // docs/exam-session-binding-v1.md. Shows only NEUTRAL operational
  // status to the student (never an accusatory warning); failure here
  // never blocks the exam, never loses an answer, never affects
  // submission. No canvas/WebGL/audio fingerprinting, no keystroke or
  // clipboard capture — only coarse browser/OS/timezone/screen-bucket
  // hints already visible to any website.
  const sessionHeartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [sessionConnectionState, setSessionConnectionState] = useState<
    "connecting" | "connected" | "unconfirmed"
  >("connecting");
  const [concurrentSessionNotice, setConcurrentSessionNotice] = useState(false);

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
  // Camera Startup Lifecycle v2 — see
  // docs/on-device-ai-integrity-detection-v1.md ("Camera startup
  // lifecycle"). Fixes false CAMERA_VIEW_BLOCKED/CAMERA_TOO_DARK/
  // NO_PERSON_VISIBLE/POSSIBLE_PHONE_VISIBLE/POSSIBLE_SECOND_PERSON_VISIBLE
  // — and the premature "granted" that let students proceed before the
  // camera was actually rendering anything — with an explicit state
  // machine. `cameraLifecycleRef` is the SYNCHRONOUS source of truth read
  // inside async continuations and event listeners (a ref never goes
  // stale mid-await); `cameraLifecycleState` mirrors it only to drive
  // re-renders. `cameraStartGenerationRef` is bumped on every
  // startCamera() call — only a callback whose captured generation still
  // matches the current one may update state, assign/stop a stream, or
  // report an error, so a stale in-flight attempt can never clobber a
  // newer successful one (Part 8).
  const cameraLifecycleRef = useRef<CameraLifecycleState>("IDLE");
  const [cameraLifecycleState, setCameraLifecycleStateRaw] = useState<CameraLifecycleState>("IDLE");
  const cameraStartGenerationRef = useRef(0);
  const cameraTimersRef = useRef<CameraLifecycleTimers>(initialCameraLifecycleTimers());
  const cameraRetryAttemptRef = useRef(0);
  const [cameraStartupError, setCameraStartupError] = useState<string | null>(null);
  // Back-compat aliases: firstReadyFrameAtRef mirrors
  // cameraTimersRef.current.firstFrameReadyAt so any remaining reads
  // elsewhere stay accurate without needing a second source of truth.
  const cameraStreamStartedAtRef = useRef<number | null>(null);
  const firstReadyFrameAtRef = useRef<number | null>(null);

  // Detection-sampling sink (fixes "detection remains disabled until
  // refresh" — see docs/on-device-ai-integrity-detection-v1.md,
  // "Detection-sampling sink readiness"). detectionSamplingReadyRef is
  // the SYNCHRONOUS source of truth the detection tick loop reads —
  // owned entirely by startDetectionSamplingVideo() below, reset
  // whenever a new camera generation starts (never carried across
  // restarts, never left stuck at whatever a stale attempt last wrote).
  // Persisted in refs (not effect-local `let`s) so a re-render or an
  // unrelated effect restart can never discard in-progress readiness.
  const detectionSamplingReadyRef = useRef(false);
  const [detectionSamplingReady, setDetectionSamplingReady] = useState(false);
  const detectionSamplingConsecutiveFramesRef = useRef(0);
  const detectionSamplingFirstFrameAtRef = useRef<number | null>(null);
  const detectionSamplingRetryAttemptRef = useRef(0);
  const [detectionSamplingError, setDetectionSamplingError] = useState<string | null>(null);
  // detectionArmed mirrors isDetectionFullyArmed(primary READY, sampling
  // ready) purely for UI display — the detection tick loop itself always
  // reads the two refs directly, never this state (never stale mid-tick).
  // Derived on every render — no separate state/effect needed since both
  // inputs are already React state.
  const detectionArmed = isDetectionFullyArmed(cameraLifecycleState === "READY", detectionSamplingReady);
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

  // Exam Session Binding v1 — see docs/exam-session-binding-v1.md. Sends
  // a lightweight heartbeat every 25s while the attempt is in progress.
  // The server creates/resumes the session-binding cookies on the FIRST
  // call; every call after that just confirms the session is still
  // alive. Best-effort only: a failed heartbeat never blocks the exam,
  // never loses an answer — it only shows a neutral "reconnecting"
  // status. Existing camera-permission state (already tracked by Camera
  // Monitoring v1 above) is reported coarsely; no new camera logic is
  // added here.
  const submissionId = data?.id;
  const submissionStatus = data?.status;
  useEffect(() => {
    if (!submissionId || submissionStatus !== "IN_PROGRESS") return;

    const mappedCameraPermission =
      cameraStatus === "granted" ? "granted" : cameraStatus === "denied" ? "denied" : "prompt";

    const sendHeartbeat = () => {
      fetch(`/api/submissions/${submissionId}/session-heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          screenWidth: typeof window !== "undefined" ? window.screen.width : undefined,
          cameraPermissionState: mappedCameraPermission,
        }),
      })
        .then((res) => {
          if (!res.ok) {
            setSessionConnectionState("unconfirmed");
            return null;
          }
          return res.json();
        })
        .then((body: { concurrentSessionDetected?: boolean } | null) => {
          if (!body) return;
          setSessionConnectionState("connected");
          setConcurrentSessionNotice(Boolean(body.concurrentSessionDetected));
        })
        .catch(() => setSessionConnectionState("unconfirmed"));
    };

    sendHeartbeat();
    sessionHeartbeatTimer.current = setInterval(sendHeartbeat, 25_000);
    return () => {
      if (sessionHeartbeatTimer.current) clearInterval(sessionHeartbeatTimer.current);
    };
  }, [submissionId, submissionStatus, cameraStatus]);

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

  // Question Navigator v1 — see docs/question-navigator-v1.md. Refreshed
  // after every navigation, flag change, or answer save so counts/states
  // never go stale. Silently no-ops on failure (progress display, not the
  // source of truth for anything security-relevant).
  const loadNavigator = useCallback(async () => {
    const res = await fetch(`/api/submissions/${id}/question-navigator`).catch(() => null);
    if (res && res.ok) setQuestionNav(await res.json());
  }, [id]);

  useEffect(() => {
    if (oneQuestionAtATime && secureSettings?.showQuestionNavigator && gateAcknowledged) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadNavigator();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oneQuestion.payload?.question.id, gateAcknowledged]);

  /**
   * Direct (GOTO) navigation via a grid tile — a DISTINCT, stricter
   * server path from navigateQuestion() above (see
   * canNavigateToQuestion in src/lib/questionNavigator.ts). Follows the
   * same disable-controls -> save -> request -> load -> refresh ->
   * re-enable flow to avoid double-click/overlapping-save races.
   */
  async function navigateQuestionDirect(targetIndex: number) {
    if (!oneQuestion.payload || navigatingQuestion) return;
    setNavigatingQuestion(true);
    setOneQuestion((prev) => ({ ...prev, error: null }));
    const saved = await flushAnswerNow(oneQuestion.payload.question.id);
    if (!saved) {
      setOneQuestion((prev) => ({ ...prev, error: "Your answer could not be saved. Please try again before moving on." }));
      setNavigatingQuestion(false);
      return;
    }
    try {
      const res = await fetch(`/api/submissions/${id}/question-progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "GOTO", targetIndex }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setOneQuestion((prev) => ({
          ...prev,
          error: typeof body?.error === "string" ? body.error : "Could not move to that question. Please try again.",
        }));
        return;
      }
      const payload: OneQuestionPayload = await res.json();
      setOneQuestion({ loading: false, error: null, payload });
      setNavigatorAnnouncement(`Moved to question ${payload.currentIndex + 1} of ${payload.totalQuestions}.`);
      if (payload.existingResponse != null) {
        setResponses((prev) => (prev[payload.question.id] !== undefined ? prev : { ...prev, [payload.question.id]: payload.existingResponse! }));
      }
    } catch {
      setOneQuestion((prev) => ({ ...prev, error: "Could not reach the server. Please try again." }));
    } finally {
      setNavigatingQuestion(false);
    }
  }

  async function toggleFlagCurrentQuestion() {
    if (!oneQuestion.payload || flaggingQuestionId) return;
    const questionId = oneQuestion.payload.question.id;
    const currentlyFlagged = questionNav?.questions.find((t) => t.questionId === questionId)?.flaggedForReview ?? false;
    setFlaggingQuestionId(questionId);
    try {
      const res = await fetch(`/api/submissions/${id}/question-state/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flaggedForReview: !currentlyFlagged }),
      });
      if (res.ok) {
        setNavigatorAnnouncement(!currentlyFlagged ? "Question flagged for review." : "Question unflagged.");
        await loadNavigator();
      }
    } finally {
      setFlaggingQuestionId(null);
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
    // Camera Startup Lifecycle v2 (Part 7) — the getUserMedia() permission
    // prompt (and the OS-level camera-access dialog on some platforms)
    // can itself trigger a window blur or visibilitychange. Suppressing
    // focus-loss reporting during every camera-startup phase — and ONLY
    // during those phases, never permanently — prevents a false
    // WINDOW_BLUR from firing on first exam start. A genuine focus loss
    // once the camera is READY is never suppressed.
    const onBlur = () => {
      if (shouldSuppressFocusEvent(cameraLifecycleRef.current)) {
        logAiCameraDebug("focus: suppressed", { eventType: "WINDOW_BLUR", reason: "camera-permission-or-startup" });
        return;
      }
      if (secureSettings.trackWindowBlur) reportIntegrityEvent("WINDOW_BLUR");
    };
    const onFocus = () => secureSettings.trackWindowBlur && reportIntegrityEvent("WINDOW_FOCUS_RETURN");
    const onVisibilityChange = () => {
      if (!secureSettings.trackWindowBlur) return;
      if (document.hidden) {
        if (shouldSuppressFocusEvent(cameraLifecycleRef.current)) {
          logAiCameraDebug("focus: suppressed", { eventType: "visibilitychange", reason: "camera-permission-or-startup" });
          return;
        }
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

  // --- Camera Startup Lifecycle v2: start/stop, preview, heartbeat ---
  // See docs/on-device-ai-integrity-detection-v1.md ("Camera startup
  // lifecycle") for the full design rationale.

  function setCameraLifecycleState(next: CameraLifecycleState, generation: number) {
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) {
      logAiCameraDebug("lifecycle: stale generation ignored", {
        generation,
        currentGeneration: cameraStartGenerationRef.current,
        attemptedState: next,
      });
      return;
    }
    cameraLifecycleRef.current = next;
    setCameraLifecycleStateRaw(next);
    logAiCameraDebug("lifecycle: transition", { generation, state: next });
  }

  /** Stops any active stream and detaches every <video> element referencing it. Always safe to call, even if nothing is running. */
  function teardownCameraStream(reason: string) {
    if (heartbeatTimer.current) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    if (examVideoRef.current) examVideoRef.current.srcObject = null;
    if (detectionVideoRef.current) detectionVideoRef.current.srcObject = null;
    cameraTimersRef.current = initialCameraLifecycleTimers();
    cameraStreamStartedAtRef.current = null;
    firstReadyFrameAtRef.current = null;
    // Detection-sampling sink is a consumer of the same stream — it goes
    // away whenever the stream itself does, and must never carry stale
    // readiness into whatever starts next.
    detectionSamplingReadyRef.current = false;
    setDetectionSamplingReady(false);
    detectionSamplingConsecutiveFramesRef.current = 0;
    detectionSamplingFirstFrameAtRef.current = null;
    logAiCameraDebug("stream: cleanup", { reason });
  }

  function stopCamera() {
    // Bumping the generation here means any still-in-flight
    // startCameraAttempt from before this call can never resurrect a
    // stream after this teardown (Part 8).
    cameraStartGenerationRef.current += 1;
    teardownCameraStream("stopCamera");
    cameraLifecycleRef.current = "IDLE";
    setCameraLifecycleStateRaw("IDLE");
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForVideoEvent(el: HTMLVideoElement, event: "loadedmetadata", timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (el.readyState >= 1) return resolve();
      const timer = setTimeout(() => {
        el.removeEventListener(event, onEvent);
        resolve(); // Never rejects the whole startup — the frame-readiness poll below is the real gate.
      }, timeoutMs);
      function onEvent() {
        clearTimeout(timer);
        el.removeEventListener(event, onEvent);
        resolve();
      }
      el.addEventListener(event, onEvent);
    });
  }

  /**
   * Polls (via requestVideoFrameCallback where supported, else
   * requestAnimationFrame) until REQUIRED_CONSECUTIVE_RENDERED_FRAMES
   * genuinely valid frames have been observed in a row (Part 5), or the
   * overall startup timeout elapses. A single bad frame resets the
   * streak — never "banks" partial progress from before a dropout.
   */
  /**
   * Generic rendered-frame poller, shared by the primary camera lifecycle
   * AND the detection-sampling sink below — same strict readiness bar for
   * both, never a weaker one for the sampling sink. `label`/`onFrame` let
   * each caller log and record progress into its own state without this
   * function needing to know which one it's serving.
   */
  function waitForRenderedFrames(
    video: HTMLVideoElement,
    stream: MediaStream,
    generation: number,
    options: { timeoutMs?: number; label?: string; onFrame?: (consecutive: number) => void } = {},
  ): Promise<boolean> {
    const timeoutMs = options.timeoutMs ?? CAMERA_READY_TIMEOUT_MS;
    const label = options.label ?? "primary";
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let consecutive = 0;
      let rvfcHandle: number | null = null;
      let rafHandle: number | null = null;
      let settled = false;

      function finish(result: boolean) {
        if (settled) return;
        settled = true;
        const videoWithRvfc = video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
        if (rvfcHandle != null) videoWithRvfc.cancelVideoFrameCallback?.(rvfcHandle);
        if (rafHandle != null) cancelAnimationFrame(rafHandle);
        resolve(result);
      }

      function checkFrame() {
        if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return finish(false);
        const track = stream.getVideoTracks()[0];
        const valid = isRenderedFrameValid({
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          currentTime: video.currentTime,
          paused: video.paused,
          trackReadyState: track?.readyState,
        });
        consecutive = nextConsecutiveRenderedFrameCount(consecutive, valid);
        options.onFrame?.(consecutive);
        logAiCameraDebug(`frame: observed (${label})`, { generation, valid, consecutive, readyState: video.readyState, width: video.videoWidth, height: video.videoHeight });
        if (hasReachedFrameReadiness(consecutive)) return finish(true);
        if (Date.now() > deadline) return finish(false);
        scheduleNext();
      }

      function scheduleNext() {
        const videoWithRvfc = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
        if (typeof videoWithRvfc.requestVideoFrameCallback === "function") {
          rvfcHandle = videoWithRvfc.requestVideoFrameCallback(() => checkFrame());
        } else {
          rafHandle = requestAnimationFrame(() => checkFrame());
        }
      }

      scheduleNext();
    });
  }

  /**
   * One full, idempotent camera-startup attempt: permission -> stream ->
   * attach -> metadata -> playback -> first-rendered-frame (x3
   * consecutive) -> warm-up -> READY. Every step checks the captured
   * `generation` before touching shared state, so a newer startCamera()
   * call (manual retry, or a second click) always wins over a stale one.
   */
  async function startCameraAttempt(generation: number): Promise<{ ok: true } | { ok: false; reason: "permission" | "readiness" }> {
    let permissionState = "unknown";
    try {
      const permissionsApi = (navigator as Navigator & { permissions?: { query: (opts: { name: string }) => Promise<{ state: string }> } }).permissions;
      if (permissionsApi?.query) {
        const status = await permissionsApi.query({ name: "camera" });
        permissionState = status.state;
      }
    } catch {
      permissionState = "unknown";
    }
    logAiCameraDebug("permission: state", { generation, permissionState });

    setCameraLifecycleState("REQUESTING_PERMISSION", generation);
    let stream: MediaStream;
    try {
      logAiCameraDebug("getUserMedia: requesting", { generation });
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      logAiCameraDebug("getUserMedia: success", { generation, videoTrackCount: stream.getVideoTracks().length });
    } catch (err) {
      logAiCameraDebug("getUserMedia: failed", { generation, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, reason: "permission" };
    }
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, reason: "readiness" };
    }

    setCameraLifecycleState("PERMISSION_GRANTED", generation);
    cameraStreamRef.current = stream;
    cameraTimersRef.current = resetCameraLifecycleTimers(Date.now());
    cameraStreamStartedAtRef.current = cameraTimersRef.current.streamStartedAt;
    reportIntegrityEvent("CAMERA_PERMISSION_GRANTED");

    // Detection-sampling sink — see docs/on-device-ai-integrity-detection-v1.md
    // ("Detection-sampling sink readiness"). Started here, in PARALLEL
    // with the primary preview's own readiness/warm-up below, using the
    // SAME stream and the SAME generation — never gated behind
    // gateAcknowledged or the primary reaching READY first, which
    // previously created a second, unhandled cold start after the
    // primary camera had already finished. Fire-and-forget: never
    // awaited here, so it can never delay the primary lifecycle from
    // reaching READY.
    if (secureSettings?.enableAiCameraIntegrityChecks) {
      detectionSamplingReadyRef.current = false;
      setDetectionSamplingReady(false);
      detectionSamplingConsecutiveFramesRef.current = 0;
      detectionSamplingFirstFrameAtRef.current = null;
      detectionSamplingRetryAttemptRef.current = 0;
      setDetectionSamplingError(null);
      void startDetectionSamplingWithRetry(stream, generation);
    }

    setCameraLifecycleState("STREAM_RECEIVED", generation);
    const video = videoRef.current;
    if (!video) return { ok: false, reason: "readiness" };
    video.srcObject = stream;
    setCameraLifecycleState("VIDEO_ATTACHED", generation);

    await waitForVideoEvent(video, "loadedmetadata", 5_000);
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return { ok: false, reason: "readiness" };

    setCameraLifecycleState("WAITING_FOR_PLAYBACK", generation);
    try {
      await video.play();
      logAiCameraDebug("video.play: success", { generation });
    } catch (err) {
      // Some browsers resolve play() late (or reject once, then still
      // render) — the frame-readiness poll below is the real gate, so a
      // rejected play() promise alone doesn't abort startup.
      logAiCameraDebug("video.play: failed", { generation, error: err instanceof Error ? err.message : String(err) });
    }
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return { ok: false, reason: "readiness" };

    setCameraLifecycleState("WAITING_FOR_FIRST_FRAME", generation);
    const reachedReadiness = await waitForRenderedFrames(video, stream, generation, {
      timeoutMs: CAMERA_READY_TIMEOUT_MS,
      label: "primary",
      onFrame: (consecutive) => {
        cameraTimersRef.current = { ...cameraTimersRef.current, consecutiveRenderedFrames: consecutive };
      },
    });
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return { ok: false, reason: "readiness" };
    if (!reachedReadiness) {
      logAiCameraDebug("readiness: timed out waiting for rendered frames", { generation });
      return { ok: false, reason: "readiness" };
    }

    const firstFrameReadyAt = Date.now();
    cameraTimersRef.current = { ...cameraTimersRef.current, firstFrameReadyAt };
    firstReadyFrameAtRef.current = firstFrameReadyAt;
    logAiCameraDebug("readiness: first rendered frame confirmed (3 consecutive)", { generation, firstFrameReadyAt });

    setCameraLifecycleState("WARMING_UP", generation);
    logAiCameraDebug("warmup: start", { generation, warmupMs: CAMERA_WARMUP_MS });
    await delay(CAMERA_WARMUP_MS);
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return { ok: false, reason: "readiness" };
    logAiCameraDebug("warmup: end", { generation });

    setCameraLifecycleState("READY", generation);
    setCameraStatus("granted");
    setCameraStartupError(null);
    reportIntegrityEvent("CAMERA_STARTED");
    logAiCameraDebug("lifecycle: primary camera READY", {
      generation,
      detectionSamplingReady: detectionSamplingReadyRef.current,
    });
    return { ok: true };
  }

  /**
   * Explicit startup sequence for the hidden AI-detection sampling
   * `<video>` — see docs/on-device-ai-integrity-detection-v1.md
   * ("Detection-sampling sink readiness"). Mirrors the primary camera's
   * own sequence (attach -> metadata -> explicit awaited play() -> N
   * consecutive rendered frames -> settle warm-up) rather than relying
   * on the `autoPlay` HTML attribute alone, which is not reliably
   * sufficient for a second, initially off-screen (`display: none`)
   * consumer of an already-live stream. Writes only to refs
   * (detectionSamplingReadyRef and friends) — never effect-local `let`s
   * — so a re-render or an unrelated effect restart can never discard
   * in-progress readiness (Part 4). Every step checks `generation`
   * before proceeding (Part 5), so a stale attempt can never arm
   * detection for, or stop the stream of, a newer one.
   */
  /**
   * The hidden detection `<video>` element only mounts once the pre-exam
   * gate screen closes (secureModeEnabled && !gateAcknowledged is a
   * separate early `return`, so this element cannot exist in that
   * branch's tree — see Part 1 findings). startDetectionSamplingVideo()
   * is started from inside startCameraAttempt(), which can run WHILE the
   * student is still on the gate screen (camera is typically enabled
   * there). Rather than depending on gateAcknowledged and treating "not
   * mounted yet" as a hard failure (which the bounded retry budget could
   * exhaust before the student even clicks "Begin exam"), this polls
   * briefly for the ref to appear.
   */
  function waitForDetectionVideoRef(generation: number, timeoutMs = 20_000): Promise<HTMLVideoElement | null> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      function check() {
        if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return resolve(null);
        if (detectionVideoRef.current) return resolve(detectionVideoRef.current);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(check, 150);
      }
      check();
    });
  }

  async function startDetectionSamplingVideo(stream: MediaStream, generation: number): Promise<boolean> {
    const video = await waitForDetectionVideoRef(generation);
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return false;
    if (!video) {
      logAiCameraDebug("detection sampling: no video element", { generation });
      return false;
    }
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return false;

    // Clear any stale previous srcObject before reattaching — the same
    // teardown-before-(re)attach discipline the primary lifecycle uses.
    video.srcObject = null;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    logAiCameraDebug("detection sampling: stream attached", { generation });

    await waitForVideoEvent(video, "loadedmetadata", 5_000);
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return false;

    try {
      await video.play();
      logAiCameraDebug("detection sampling: play success", { generation });
    } catch (err) {
      logAiCameraDebug("detection sampling: play failed", { generation, error: err instanceof Error ? err.message : String(err) });
    }
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return false;

    const reachedReadiness = await waitForRenderedFrames(video, stream, generation, {
      timeoutMs: DETECTION_SAMPLING_STARTUP_TIMEOUT_MS,
      label: "detection-sampling",
      onFrame: (consecutive) => {
        detectionSamplingConsecutiveFramesRef.current = consecutive;
      },
    });
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return false;
    if (!reachedReadiness) {
      logAiCameraDebug("detection sampling: timed out waiting for rendered frames", { generation });
      return false;
    }

    const firstFrameReadyAt = Date.now();
    detectionSamplingFirstFrameAtRef.current = firstFrameReadyAt;
    logAiCameraDebug("detection sampling: readiness confirmed (3 consecutive)", { generation, firstFrameReadyAt });

    logAiCameraDebug("detection sampling: warmup start", { generation, warmupMs: DETECTION_SAMPLING_WARMUP_MS });
    await delay(DETECTION_SAMPLING_WARMUP_MS);
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return false;
    logAiCameraDebug("detection sampling: warmup end", { generation });

    detectionSamplingReadyRef.current = true;
    setDetectionSamplingReady(true);
    setDetectionSamplingError(null);
    logAiCameraDebug("detection sampling: ready", { generation });
    return true;
  }

  /**
   * Bounded retry (Part 6/9) — restarts ONLY the sampling sink (clear
   * srcObject, reattach the SAME live stream, play again) on a timeout
   * or failure. Never touches the primary stream/lifecycle, never
   * restarts the submission, never discards answers or the current
   * question — this is purely a second, independent consumer of the
   * already-working camera stream.
   */
  async function startDetectionSamplingWithRetry(stream: MediaStream, generation: number): Promise<void> {
    const ok = await startDetectionSamplingVideo(stream, generation);
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return;
    if (ok) return;

    if (shouldAutoRetry(detectionSamplingRetryAttemptRef.current, DETECTION_SAMPLING_MAX_RETRIES)) {
      detectionSamplingRetryAttemptRef.current += 1;
      logAiCameraDebug("detection sampling: automatic retry", {
        generation,
        attempt: detectionSamplingRetryAttemptRef.current,
      });
      await delay(DETECTION_SAMPLING_RETRY_DELAY_MS);
      if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return;
      await startDetectionSamplingWithRetry(stream, generation);
      return;
    }

    logAiCameraDebug("detection sampling: retries exhausted", { generation });
    setDetectionSamplingError("Camera preview is active, but camera integrity checks could not start.");
  }

  /**
   * Manual "Retry camera checks" — restarts only the sampling sink using
   * the CURRENT camera generation and the already-live primary stream.
   * Requires the primary camera to already be READY; never re-requests
   * getUserMedia() and never touches the submission.
   */
  async function retryDetectionSampling() {
    const stream = cameraStreamRef.current;
    if (!stream || cameraLifecycleRef.current !== "READY") return;
    const generation = cameraStartGenerationRef.current;
    detectionSamplingRetryAttemptRef.current = 0;
    setDetectionSamplingError(null);
    await startDetectionSamplingWithRetry(stream, generation);
  }

  /**
   * Bounded automatic retry (Part 9) — only for READINESS failures
   * (stream/frame never settled), never for a permission denial (that
   * needs the student to act). Each retry does a full teardown first, so
   * a zombie stream can never block the next getUserMedia() call the way
   * it previously could (this is exactly why a full page reload used to
   * be required).
   */
  async function attemptCameraStartWithRetry(generation: number): Promise<boolean> {
    const result = await startCameraAttempt(generation);
    if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return false;
    if (result.ok) {
      cameraRetryAttemptRef.current = 0;
      return true;
    }

    if (result.reason === "permission") {
      setCameraLifecycleState("FAILED", generation);
      setCameraStatus("denied");
      setCameraStartupError(
        "Camera permission is required for this exam. Allow camera access in your browser, then select “Try camera again”.",
      );
      if (gateAcknowledged) reportIntegrityEvent("CAMERA_PRECHECK_FAILED");
      else reportIntegrityEvent("CAMERA_PERMISSION_DENIED");
      return false;
    }

    if (shouldAutoRetry(cameraRetryAttemptRef.current)) {
      cameraRetryAttemptRef.current += 1;
      logAiCameraDebug("retry: automatic attempt", { generation, attempt: cameraRetryAttemptRef.current });
      setCameraLifecycleState("RETRYING", generation);
      teardownCameraStream("automatic-retry");
      await delay(CAMERA_RETRY_DELAY_MS);
      if (!isCurrentGeneration(cameraStartGenerationRef.current, generation)) return false;
      return attemptCameraStartWithRetry(generation);
    }

    setCameraLifecycleState("FAILED", generation);
    setCameraStatus("denied");
    setCameraStartupError("Camera could not start. Check browser permission and try again.");
    if (secureSettings?.recordCameraUnavailableEvents) reportIntegrityEvent("CAMERA_UNAVAILABLE");
    return false;
  }

  /**
   * The single authoritative entry point for starting (or retrying) the
   * camera — used for the initial "Enable camera" click, the manual "Try
   * camera again" button, and heartbeat-triggered restarts alike. Always
   * tears down any existing stream first (idempotent — Part 4) and bumps
   * the generation so any previous in-flight attempt is invalidated.
   */
  async function startCamera(): Promise<boolean> {
    cameraStartGenerationRef.current += 1;
    const generation = cameraStartGenerationRef.current;
    cameraRetryAttemptRef.current = 0;
    setCameraStartupError(null);
    setCameraStatus("requesting");
    teardownCameraStream("restart");
    return attemptCameraStartWithRetry(generation);
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

  // The hidden detection video's stream attachment is no longer handled
  // by a gateAcknowledged/cameraStatus-triggered effect — see
  // docs/on-device-ai-integrity-detection-v1.md ("Detection-sampling
  // sink readiness"). That reattachment ran only once cameraStatus was
  // already "granted" AND gateAcknowledged was true, which is a strictly
  // LATER point than when startDetectionSamplingVideo() now starts (in
  // parallel with the primary camera, from inside startCameraAttempt) —
  // keeping this effect around would just reattach the same stream a
  // second time, restarting the sampling sink's own decode pipeline
  // right as it (or its readiness poll) was settling.

  // Clean up the camera stream on unmount, regardless of how the page is left.
  useEffect(() => {
    return () => {
      stopCamera();
      stopAiDetection();
    };
    // Intentionally unmount-only — stopCamera/stopAiDetection are stable
    // function declarations and this must run exactly once, on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Detection-sampling sink readiness — see
    // docs/on-device-ai-integrity-detection-v1.md ("Detection-sampling
    // sink readiness"). Ownership of readiness tracking moved OUT of
    // this effect and into detectionSamplingReadyRef (a persistent,
    // component-level ref written only by startDetectionSamplingVideo())
    // — this effect only ever READS it. That fixes the earlier bug where
    // readiness tracking lived in effect-local `let`s: any restart of
    // THIS effect (its deps include cameraStatus, which flips on every
    // camera restart) used to discard all in-progress readiness,
    // permanently stalling detection until a full page refresh gave the
    // whole flow a single, uninterrupted run.
    //
    // `previouslyArmed` guards against stale-counter carryover at the
    // exact moment arming flips false -> true: the frame-QUALITY
    // counters below (blocked/dark/second-person/no-person) keep
    // recording every tick regardless of arming (so a persistent signal
    // confirms quickly once armed), which means a couple of transient
    // bad ticks recorded WHILE unarmed could otherwise satisfy a
    // 2-consecutive-tick rule on the very first armed tick. Resetting
    // the tracker at that exact transition guarantees post-arm counting
    // always starts from zero.
    let previouslyArmed = false;

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
        if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

        // Camera Startup Lifecycle v2 — see
        // docs/on-device-ai-integrity-detection-v1.md ("Camera startup
        // lifecycle" / "Detection-sampling sink readiness"). Detection/
        // inference still runs every tick regardless of readiness (so the
        // model warms up and the local overlay/quality pipeline stay
        // exercised), but EMISSION (backend logging, the local violation
        // overlay, and evidence-frame upload) is armed ONLY once BOTH the
        // primary lifecycle has reached READY AND the detection-sampling
        // sink has independently reached its own readiness — read
        // directly from the persistent refs startDetectionSamplingVideo()
        // owns, never recomputed here.
        const armed = isDetectionFullyArmed(isDetectionArmed(cameraLifecycleRef.current), detectionSamplingReadyRef.current);
        const suppressStartup = !armed;
        if (suppressStartup) {
          logAiCameraDebug("tick: suppressed — not yet fully armed", {
            lifecycleState: cameraLifecycleRef.current,
            detectionSamplingReady: detectionSamplingReadyRef.current,
            detectionSamplingConsecutiveFrames: detectionSamplingConsecutiveFramesRef.current,
          });
        }
        // Stale-carryover guard — see the `previouslyArmed` comment above.
        if (armed && !previouslyArmed) {
          cooldown.reset();
          logAiCameraDebug("tick: cooldown reset at arm transition", {});
        }
        previouslyArmed = armed;

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
            // Question Navigator v1 — Part 12: progress counts must
            // update after every answer save, not only after
            // navigation. Best-effort; never blocks/delays the save.
            else if (oneQuestionAtATime && secureSettings?.showQuestionNavigator) loadNavigator();
          })
          .catch(() => {
            if (secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
          });
      }, 600);
    },
    [id, secureModeEnabled, reportIntegrityEvent, oneQuestionAtATime, secureSettings?.showQuestionNavigator, loadNavigator],
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
                    {cameraStatus === "requesting"
                      ? (cameraLifecycleStatusMessage(cameraLifecycleState) || "Starting…")
                      : cameraStartupError
                        ? "Try camera again"
                        : "Enable camera"}
                  </button>
                  {cameraStartupError && (
                    <p className="mt-2 text-sm text-red-600">{cameraStartupError}</p>
                  )}
                </>
              )}
              {/* The <video> element is mounted unconditionally (whenever
                  camera access is required) rather than only after
                  cameraStatus === "granted" — startCameraAttempt() needs
                  videoRef.current to exist BEFORE the camera is ready in
                  order to attach the stream and await metadata/playback.
                  Visually hidden until the preview should actually show. */}
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className={
                  cameraStatus === "granted" && secureSettings?.showCameraPreview
                    ? "mt-2 w-48 rounded border border-gray-300"
                    : "sr-only"
                }
              />
              {cameraStatus === "granted" && secureSettings?.showCameraPreview && (
                <p className="mt-1 text-xs text-gray-500">
                  Your camera preview — only you can see this
                </p>
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

      {/* Exam Session Binding v1 — see docs/exam-session-binding-v1.md.
          NEUTRAL operational status only — never an accusatory warning.
          The concurrent-session notice is informational, not a block:
          v1 never automatically terminates either session. */}
      {sessionConnectionState === "unconfirmed" && (
        <p className="mt-2 text-xs text-gray-500">Session connection could not be confirmed.</p>
      )}
      {concurrentSessionNotice && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          This exam is also active in another browser session. Close the other session to avoid answer conflicts.
        </p>
      )}

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
          {requireCamera && cameraStatus !== "granted" && cameraStatus !== "denied" && cameraLifecycleState !== "IDLE" && (
            <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
              {cameraLifecycleStatusMessage(cameraLifecycleState)}
            </span>
          )}
          {enableAiCameraIntegrityChecks && (
            <span
              className={
                aiCheckStatus === "unavailable" || cameraLifecycleState === "FAILED" || detectionSamplingError
                  ? "rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                  : !detectionArmed
                    ? "rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700"
                    : "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
              }
            >
              {/* Part 8 — the "active" state is never shown merely
                  because the primary camera reached READY; it requires
                  detectionArmed (primary READY AND the detection-
                  sampling sink independently ready) — see
                  docs/on-device-ai-integrity-detection-v1.md. */}
              {aiCheckStatus === "unavailable"
                ? "Camera integrity checks unavailable"
                : cameraLifecycleState === "FAILED"
                  ? "Camera setup issue — checks unavailable"
                  : detectionSamplingError
                    ? "Camera preview is active, but camera integrity checks could not start."
                    : cameraLifecycleState !== "READY"
                      ? "Preparing camera integrity checks…"
                      : !detectionArmed
                        ? "Starting camera integrity checks…"
                        : "Camera integrity checks active"}
            </span>
          )}
          {enableAiCameraIntegrityChecks && detectionSamplingError && (
            <button
              type="button"
              onClick={retryDetectionSampling}
              className="rounded border border-gray-300 bg-white px-2 py-0.5 text-xs"
            >
              Retry camera checks
            </button>
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
              {/* Camera Startup Lifecycle v2 — a calm, non-alarming status
                  message during startup, never the violation overlay. See
                  docs/on-device-ai-integrity-detection-v1.md. */}
              {enableAiCameraIntegrityChecks && cameraLifecycleState !== "READY" && cameraLifecycleState !== "FAILED" && (
                <p className="mt-1 text-xs text-gray-500">{cameraLifecycleStatusMessage(cameraLifecycleState)}</p>
              )}
              {enableAiCameraIntegrityChecks && cameraLifecycleState === "READY" && !detectionArmed && !detectionSamplingError && (
                <p className="mt-1 text-xs text-gray-500">Starting camera integrity checks…</p>
              )}
              {enableAiCameraIntegrityChecks && cameraLifecycleState === "FAILED" && (
                <p className="mt-1 text-xs text-amber-700">
                  Camera could not start. Check browser permission and try again.
                </p>
              )}
              {enableAiCameraIntegrityChecks && detectionSamplingError && (
                <p className="mt-1 text-xs text-amber-700">{detectionSamplingError}</p>
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
      {/* Deliberately NOT gated on cameraStatus === "granted" (i.e. not
          gated on the primary camera already being READY) — see
          docs/on-device-ai-integrity-detection-v1.md ("Detection-
          sampling sink readiness"): that used to force a second cold
          start after the primary camera had already finished. Still
          only reachable once past the pre-exam gate screen's own early
          return (secureModeEnabled && !gateAcknowledged) — see
          waitForDetectionVideoRef() in startDetectionSamplingVideo,
          which tolerates that remaining gap by waiting for this element
          to mount rather than failing immediately. */}
      {requireCamera && enableAiCameraIntegrityChecks && (
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
              {/* Question Navigator v1 — see docs/question-navigator-v1.md.
                  An aria-live region so screen-reader users hear
                  confirmation after a successful navigation or
                  flag/unflag, without needing to find focus themselves. */}
              <div aria-live="polite" className="sr-only">
                {navigatorAnnouncement}
              </div>
              {secureSettings?.showQuestionNavigator && questionNav && (
                <QuestionNavigatorPanel
                  navigator={questionNav}
                  open={navigatorPanelOpen}
                  onToggleOpen={() => setNavigatorPanelOpen((v) => !v)}
                  disabled={submitting || autoSubmitLocked || timerStopped || navigatingQuestion}
                  onSelectQuestion={navigateQuestionDirect}
                />
              )}
              {oneQuestion.loading && <p className="text-gray-500">Loading question...</p>}
              {!oneQuestion.loading && oneQuestion.payload && (
                <div className="rounded border border-gray-200 p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-500">
                      Question {oneQuestion.payload.currentIndex + 1} of {oneQuestion.payload.totalQuestions}{" "}
                      · {oneQuestion.payload.question.points} pt(s)
                    </p>
                    {secureSettings?.allowFlagForReview && (
                      <button
                        type="button"
                        onClick={toggleFlagCurrentQuestion}
                        disabled={flaggingQuestionId === oneQuestion.payload.question.id}
                        aria-pressed={
                          questionNav?.questions.find((t) => t.questionId === oneQuestion.payload!.question.id)?.flaggedForReview ?? false
                        }
                        className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50"
                      >
                        {questionNav?.questions.find((t) => t.questionId === oneQuestion.payload!.question.id)?.flaggedForReview
                          ? "🚩 Flagged for review"
                          : "Flag for review"}
                      </button>
                    )}
                  </div>
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
            onClick={() => {
              if (remainingSecs === 0 && data.exam.secureSettings.autoSubmitOnTimerEnd) {
                handleSubmit({ systemAutoSubmit: true });
                return;
              }
              // Question Navigator v1 — Part 13: show the review panel
              // only when the navigator is actually active for this
              // exam; otherwise submission behaves exactly as before.
              if (oneQuestionAtATime && secureSettings?.showQuestionNavigator && questionNav) {
                setShowReviewModal(true);
                return;
              }
              handleSubmit();
            }}
            disabled={submitting || autoSubmitLocked || timerStopped}
            className="mt-6 rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit exam"}
          </button>
          {submitMessage && <p className="mt-2 text-sm text-red-600">{submitMessage}</p>}
        </div>

        {/* Question Navigator v1 — Part 13 review-before-submit workflow.
            See docs/question-navigator-v1.md. */}
        {showReviewModal && questionNav && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="review-exam-heading">
            <div className="w-full max-w-sm rounded border border-gray-300 bg-white p-5 shadow-lg">
              <p id="review-exam-heading" className="text-base font-semibold">
                Review your exam
              </p>
              <div className="mt-3 space-y-1 text-sm text-gray-700">
                <p>Answered: {questionNav.progress.answeredCount}</p>
                <p>Unanswered: {questionNav.progress.unansweredCount}</p>
                {questionNav.settings.allowFlagForReview && <p>Flagged for review: {questionNav.progress.flaggedCount}</p>}
              </div>
              {questionNav.progress.unansweredCount > 0 && (
                <p className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                  You still have {questionNav.progress.unansweredCount} unanswered question
                  {questionNav.progress.unansweredCount === 1 ? "" : "s"}. You may submit now, but unanswered
                  questions may receive no marks.
                </p>
              )}
              <div className="mt-4 flex flex-col gap-2">
                {questionNav.progress.unansweredCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = findFirstNavigableIndex(questionNav, (t) => !t.answered);
                      setShowReviewModal(false);
                      if (target != null) navigateQuestionDirect(target);
                      else setOneQuestion((prev) => ({ ...prev, error: "Unanswered questions cannot be reopened under this exam's navigation rules." }));
                    }}
                    className="rounded border border-gray-300 px-3 py-1.5 text-sm"
                  >
                    Return to unanswered questions
                  </button>
                )}
                {questionNav.settings.allowFlagForReview && questionNav.progress.flaggedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = findFirstNavigableIndex(questionNav, (t) => t.flaggedForReview);
                      setShowReviewModal(false);
                      if (target != null) navigateQuestionDirect(target);
                      else setOneQuestion((prev) => ({ ...prev, error: "Flagged questions cannot be reopened under this exam's navigation rules." }));
                    }}
                    className="rounded border border-gray-300 px-3 py-1.5 text-sm"
                  >
                    Review flagged questions
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowReviewModal(false);
                    handleSubmit();
                  }}
                  className="rounded bg-black px-3 py-1.5 text-sm text-white"
                >
                  Submit exam
                </button>
                <button type="button" onClick={() => setShowReviewModal(false)} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

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
