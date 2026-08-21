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
import { logClientTetherDiagnostic } from "@/lib/tetherDiagnosticLog";
import { classifyNavigationSaveStrategy } from "@/lib/pendingSaveQueue";
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
  classifyCameraStreamHealth,
  decideCameraStreamEmission,
  resolveCameraIntegrityState,
  decideVisibilityRestoredEmission,
  shouldLogAiCameraDebug,
  isPhoneCalibrationEnabled,
  DetectionCooldownTracker,
  PHONE_CONFIDENCE_THRESHOLD,
  UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND,
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
// Strengthened phone detection (angled/edge/partial candidates) — see
// docs/phone-detection-calibration-v1.md. Runs alongside, not instead of,
// the existing single-frame full-confidence path in cameraIntegrityDetection.ts.
import {
  PhoneCandidateTracker,
  dedupeObservations,
  isPlausiblePhoneGeometry,
  phoneEvidenceTier,
  shouldRunSecondStageVerification,
  expandCandidateBoxForVerification,
  phoneConfidenceBand,
  buildPhoneCalibrationEventSummary,
  PHONE_DETECTION_ALGORITHM_VERSION,
  type PhoneObservation,
  type PhoneDetectionSource,
  type PhoneConfidenceBand,
  type NormalizedBox,
} from "@/lib/phoneDetectionTracking";
import {
  PHONE_CROP_REGIONS,
  computeCropSchedule,
  mapCropDetectionToOriginalFrame,
  pixelBoxToNormalized,
  withinCropInferenceBudget,
  prunedCropInferenceTimestamps,
  MAX_VERIFICATION_ATTEMPTS_PER_TICK,
} from "@/lib/phoneMultiScaleCrops";
import {
  clearAiCameraViolationOverlay,
  computeLocalAiCameraOverlay,
  handleAiCameraIntegrityReport,
  type AiCameraViolationOverlayState,
} from "@/lib/aiCameraViolationOverlay";
import {
  computeDisplayViolationModal,
  displayStatusOnInitialQueryFailure,
  type DisplayEnforcementBridgeStatus,
} from "@/lib/displayViolationOverlay";
import { applyLocalNavigatorTransition } from "@/lib/navigatorLocalSync";
import {
  buildEvidenceFrameUploadPath,
  evidenceUploadSkipReason,
  isEvidenceFrameSourceReady,
  isEvidenceCaptureEligibleEventType,
  shouldAttemptEvidenceUpload,
  shouldLogEvidenceUploadDebug,
} from "@/lib/aiCameraEvidenceFrame";
import { ExamWatermark } from "@/components/ExamWatermark";
import { AiBrainstormPanel } from "@/components/AiBrainstormPanel";
import { AnswerDevelopmentPanel } from "@/components/AnswerDevelopmentPanel";
import { useScreenShareLifecycle } from "@/hooks/useScreenShareLifecycle";
import { useAnswerDevelopmentCapture } from "@/hooks/useAnswerDevelopmentCapture";
import { useResilientAutosave } from "@/hooks/useResilientAutosave";
import { RecoveryStatusBanner } from "@/components/RecoveryStatusBanner";
import { ManualReviewNotice } from "@/components/ManualReviewNotice";
import {
  ensureLockdownBridgeInitialized,
  reportLockdownCapabilityTransition,
  reportLockdownScanUnavailable,
  reportRemoteSessionMonitorTransition,
  type LockdownCapabilityInfo,
} from "@/lib/lockdownClient";
import { resolveNativeLockdownConfirmation, shouldBlockExamContentRendering, type ContentGateState } from "@/lib/secureExamNativeLockdown";
import { buildTetherLaunchPagePath } from "@/lib/secureClientStartGate";

/**
 * Strengthened phone detection (Part 3/4) — converts raw detector output
 * from a single source (full frame OR one crop) into normalized,
 * ORIGINAL-frame-space phone observations for the candidate tracker.
 * Pure enough to live at module scope: no closure over component state,
 * everything it needs is passed in explicitly. See
 * docs/phone-detection-calibration-v1.md.
 */
const PHONE_CLASS_NAMES = new Set(["cell phone", "mobile phone", "phone"]);
/** Crop canvases are resized up to this before a second detector pass (Part 4) — matches coco-ssd's own internal input scale, so a small edge/lower-frame candidate occupies far more model pixels than it would in the full, uniformly-downscaled frame. */
const PHONE_CROP_INPUT_SIZE = 300;

/** Physical acceptance follow-up (phone-detection calibration) — a candidate rejected purely on geometry (isPlausiblePhoneGeometry), captured ONLY for the calibration log below; never persisted, never sent anywhere. */
type GeometryRejectedPhoneCandidate = { source: PhoneDetectionSource; confidence: number; box: NormalizedBox };

function phoneObservationsFromDetections(
  detections: DetectedObject[],
  sourceWidth: number,
  sourceHeight: number,
  source: PhoneDetectionSource,
  cropRegionBox?: NormalizedBox,
  // Optional out-param (physical acceptance follow-up — phone-detection
  // calibration mode): when provided, every geometry-rejected candidate is
  // ALSO appended here, purely for the bounded local calibration log
  // (buildPhoneCalibrationCandidates below) — never changes this
  // function's own return value or filtering behaviour for the real
  // detection path, which is untouched.
  geometryRejectedSink?: GeometryRejectedPhoneCandidate[],
): PhoneObservation[] {
  const observations: PhoneObservation[] = [];
  for (const d of detections) {
    if (!PHONE_CLASS_NAMES.has(d.className.toLowerCase().trim())) continue;
    if (!d.bbox) continue;
    const [x, y, width, height] = d.bbox;
    const normalizedLocal = pixelBoxToNormalized({ x, y, width, height }, sourceWidth, sourceHeight);
    const box = cropRegionBox ? mapCropDetectionToOriginalFrame(cropRegionBox, normalizedLocal) : normalizedLocal;
    if (!isPlausiblePhoneGeometry(box)) {
      geometryRejectedSink?.push({ source, confidence: d.score, box });
      continue;
    }
    observations.push({ box, score: d.score, source });
  }
  return observations;
}

/**
 * Physical acceptance follow-up — bounded, metadata-only phone-detection
 * calibration record. See docs/phone-detection-calibration-v1.md, "Known
 * limitations": this repo has no labelled fixture/hardware evaluation
 * harness yet — this is exactly that harness's data-collection side,
 * gated behind the SAME existing sesAiCameraDebug opt-in dev-only flag
 * every other on-device AI debug log already uses (shouldLogAiCameraDebug
 * in cameraIntegrityDetection.ts). Deliberately metadata-only: no image,
 * frame, or video data is ever captured here — only the plain numbers/
 * strings/booleans a real physical calibration session needs to compute a
 * detection-rate/confidence-distribution table per docs/phone-detection-
 * calibration-v1.md's test matrix.
 */
type PhoneCalibrationCandidate = {
  timestampMs: number;
  inferenceMs: number;
  source: PhoneDetectionSource;
  confidence: number;
  band: PhoneConfidenceBand;
  box: NormalizedBox;
  retained: boolean;
  rejectedReason: "confidence" | "geometry" | "tracking" | "verification" | null;
  trackId: string | null;
  localWarningTriggered: boolean;
};

function buildPhoneCalibrationCandidates(params: {
  nowMs: number;
  inferenceMs: number;
  observations: PhoneObservation[];
  dedupedObservations: PhoneObservation[];
  geometryRejected: GeometryRejectedPhoneCandidate[];
  tracks: PhoneCandidateTracker["getTracks"] extends () => infer T ? T : never;
}): PhoneCalibrationCandidate[] {
  const { nowMs, inferenceMs, observations, dedupedObservations, geometryRejected, tracks } = params;

  const fromObservations: PhoneCalibrationCandidate[] = observations.map((obs) => {
    const band = phoneConfidenceBand(obs.score);
    // A track's own box/score/source are overwritten to the LATEST
    // matching observation on every tracker.update() call (see
    // PhoneCandidateTracker.update in phoneDetectionTracking.ts) — an
    // exact triple match is therefore a reliable (if not perfectly
    // formal) correlation for calibration-logging purposes only.
    const matchedTrack = tracks.find((t) => t.latestSource === obs.source && t.latestScore === obs.score && t.box.x === obs.box.x && t.box.y === obs.box.y);
    const survivedDedup = dedupedObservations.includes(obs);
    const rejectedReason: PhoneCalibrationCandidate["rejectedReason"] =
      band === "none"
        ? "confidence"
        : !survivedDedup
          ? "tracking"
          : matchedTrack && matchedTrack.verificationOutcome === "lowered" && !matchedTrack.confirmedLocalWarning
            ? "verification"
            : matchedTrack && !matchedTrack.confirmedLocalWarning
              ? "tracking" // observed and retained, but not yet enough temporal confirmations
              : null;
    return {
      timestampMs: nowMs,
      inferenceMs,
      source: obs.source,
      confidence: obs.score,
      band,
      box: obs.box,
      retained: survivedDedup && band !== "none",
      rejectedReason,
      trackId: matchedTrack?.id ?? null,
      localWarningTriggered: matchedTrack?.confirmedLocalWarning ?? false,
    };
  });

  const fromGeometryRejected: PhoneCalibrationCandidate[] = geometryRejected.map((g) => ({
    timestampMs: nowMs,
    inferenceMs,
    source: g.source,
    confidence: g.confidence,
    band: phoneConfidenceBand(g.confidence),
    box: g.box,
    retained: false,
    rejectedReason: "geometry",
    trackId: null,
    localWarningTriggered: false,
  }));

  return [...fromObservations, ...fromGeometryRejected];
}

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
  // Controlled AI Brainstorming Assistance v1 — see
  // docs/controlled-ai-brainstorming-assistance-v1.md.
  aiAssistanceMode: "DISABLED" | "BRAINSTORM_ONLY";
  // Screen-share Evidence Mode v1 — see docs/screen-share-evidence-v1.md.
  screenShareMode: "OFF" | "REQUIRED";
  screenShareCaptureEvidence: boolean;
  screenShareEvidenceIntervalSeconds: number;
  screenShareMaxEvidenceFrames: number;
  // Answer-Development Provenance v1 — see
  // docs/answer-development-provenance-v1.md.
  answerProvenanceMode: "OFF" | "BASIC" | "DETAILED";
  answerVersionIntervalSeconds: number;
  enableOutlineWorkspace: boolean;
  enableCalculationWorkspace: boolean;
  enableCodeWorkspace: boolean;
  requireAiSourceDeclaration: boolean;
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
  | "AI_CAMERA_CHECK_UNAVAILABLE"
  | "CAMERA_STREAM_UNAVAILABLE"
  | "CAMERA_VISIBILITY_RESTORED";

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
  CAMERA_STREAM_UNAVAILABLE: 60_000,
  CAMERA_VISIBILITY_RESTORED: 60_000,
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
  // Face-visibility false-positive fix (Part 4) — exact required neutral
  // copy, shared with NEUTRAL_CAMERA_VISIBILITY_MESSAGES in
  // cameraIntegrityDetection.ts. NO_PERSON_VISIBLE is only ever reported
  // now when the frame quality was adequate AND the condition was
  // sustained (see decideNoPersonEmission) — never merely because the
  // room was dark or the detector was uncertain.
  NO_PERSON_VISIBLE: "Face not visible for a sustained period.",
  CAMERA_VIEW_BLOCKED: "Camera view appears blocked or covered. Lecturer review required.",
  CAMERA_TOO_DARK: "Lighting is too low to verify camera visibility.",
  AI_CAMERA_CHECK_UNAVAILABLE: "On-device camera integrity checks are unavailable.",
  // Corrective pass v1.2.2, Task 8 — a resource/capture-level camera
  // interruption (e.g. another application holding the camera). Neutral
  // wording, never implies the student did anything or that their face
  // was confirmed absent — see classifyCameraStreamHealth in
  // cameraIntegrityDetection.ts for why this is reported separately from
  // NO_PERSON_VISIBLE.
  CAMERA_STREAM_UNAVAILABLE: "Camera feed was temporarily interrupted.",
  // Camera integrity reliability pass — the neutral "stable recovery"
  // message. Only ever reported after a genuinely CONFIRMED
  // (SUSTAINED_NO_PERSON_VISIBLE) absence resolves back to several
  // consecutive, confidently visible frames — never merely because
  // lighting/uncertainty caused the streak to freeze (see
  // resolveCameraIntegrityState in cameraIntegrityDetection.ts). Never
  // implies the earlier absence was misconduct.
  CAMERA_VISIBILITY_RESTORED: "Camera visibility restored.",
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
    case "CAMERA_STREAM_UNAVAILABLE":
      return settings.requireCamera ? "MEDIUM" : "LOW";
    case "CAMERA_VISIBILITY_RESTORED":
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
  // Secure-recovery hardening v1, Part B — declared early (before
  // loadSubmission below, which needs to set it) so a bounce straight
  // out of loadSubmission's 403 handler never hits a temporal-dead-zone
  // issue. True once the authoritative recovery-status endpoint reports
  // MANUAL_REVIEW_REQUIRED — takes over the entire page render (see the
  // early-return render branch further down) instead of either the
  // TETHER_SESSION_REQUIRED redirect loop or any stale exam content.
  const [manualReviewRequired, setManualReviewRequired] = useState(false);
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
  // Question Navigator stale-request guard (Part 9) — see loadNavigator's
  // own doc comment below for why this exists.
  const navigatorRequestGenerationRef = useRef(0);
  const [navigatorPanelOpen, setNavigatorPanelOpen] = useState(false);
  const [navigatorAnnouncement, setNavigatorAnnouncement] = useState("");
  const [flaggingQuestionId, setFlaggingQuestionId] = useState<string | null>(null);
  const [showReviewModal, setShowReviewModal] = useState(false);
  // Tether Windows Lockdown Hardening v1 — see
  // docs/tether-windows-lockdown-hardening-v1.md. Populated once (best-
  // effort) alongside the secure-client policy effect below; read inside
  // the onLockdownCapabilityTransition listener closure registered in
  // that same effect, which is why this must be a ref (a plain variable
  // captured by that closure would go stale the moment the info
  // actually arrives, since the listener itself is registered
  // synchronously before the async fetch resolves).
  const lockdownCapabilityInfoRef = useRef<Map<string, LockdownCapabilityInfo>>(new Map());
  // Mid-exam remote-session monitoring v1 — kept as a ref (not a direct
  // closure reference) for the same reason as lockdownCapabilityInfoRef
  // above: the IPC listener that needs it is registered once per
  // submission inside an effect declared earlier in this component than
  // the useScreenShareLifecycle() call that produces
  // captureIntegrityEvidence, and must always see the LATEST function
  // identity, not whatever it closed over at first render.
  const remoteSessionCaptureEvidenceRef = useRef<() => void>(() => {});
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
  // Camera integrity reliability pass — caller-owned bookkeeping for
  // resolveCameraIntegrityState's `wasSustainedNoPersonVisible` input:
  // true from the tick a SUSTAINED_NO_PERSON_VISIBLE episode is first
  // confirmed until CAMERA_VISIBILITY_RESTORED is actually reported for
  // it (not merely reachable — see the tick handler). Survives across
  // ticks the same way the cooldown tracker itself does.
  const wasSustainedNoPersonVisibleRef = useRef(false);
  // Strengthened phone detection — see docs/phone-detection-calibration-v1.md.
  // Owned entirely by refs (not effect-local state) for the same reason
  // detectionSamplingReadyRef is: a restart of the detection effect must
  // never discard in-progress candidate tracking.
  const phoneTrackerRef = useRef(new PhoneCandidateTracker());
  const phoneCropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const phoneCropInferenceTimestampsRef = useRef<number[]>([]);
  const phoneDetectionTickIndexRef = useRef(0);
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

  // Native Display State Bridge (v1.7.6) — see src/lib/displayViolationOverlay.ts.
  // Purely local UI state driven by window.sesLockdown's
  // getDisplayEnforcementStatus()/onDisplayEnforcementStateChanged(),
  // mirroring the AI camera violation overlay's blur+modal PRESENTATION
  // pattern immediately above but with its own state/terminology (never
  // reused/conflated) and, unlike that overlay, never locally
  // dismissible while native state remains BLOCKED. null until the first
  // status arrives (harmless — computeDisplayViolationModal treats null
  // as "nothing to show", exactly like a real OK status would).
  const [displayEnforcementStatus, setDisplayEnforcementStatus] = useState<DisplayEnforcementBridgeStatus | null>(null);
  const displayViolationModal = computeDisplayViolationModal(displayEnforcementStatus);

  const [inLockdownBrowser, setInLockdownBrowser] = useState(false);
  // v1.7.5 P0 — see src/lib/secureExamNativeLockdown.ts. Defaults to
  // PENDING; the effect below (fetching /secure-client/status) resolves
  // it to NOT_APPLICABLE (non-gated exam), CONFIRMED (native lockdown
  // already ACTIVE+READY — the normal Phase 2 handoff), REACTIVATION_REQUIRED
  // (redirecting to tether-launch for a fresh secure-reactivation
  // handshake), UNSUPPORTED_BUILD (installed client predates the
  // required query bridge), or STATUS_UNAVAILABLE (the policy fetch
  // itself failed). shouldBlockExamContentRendering derives the actual
  // render gate from this — see the render-time check near `if (!data)`.
  const [contentGateState, setContentGateState] = useState<ContentGateState>("PENDING");

  // v1.7.5 P0 — REMOVED the old Corrective-pass-v1.2.1/Task-C blind
  // mount-time cover (setSecureClientEnforcementState({active:true,
  // ready:false, ...}), called unconditionally on every mount). That
  // call downgraded an ALREADY ACTIVE+READY native state — set moments
  // earlier by a successful Phase 2 handoff in tether-launch/page.tsx —
  // back to POLICY_NOT_READY, which produced the screen-saver-level,
  // non-closable native overlay ("Preparing your secure exam session")
  // with no Recheck/Exit route, requiring a Windows restart. See
  // docs/tether-preflight-lifecycle-v1.7.5-policy-not-ready.md for the
  // full root-cause writeup.
  //
  // The fail-open gap Task C originally existed to close (a second
  // display connected during the window-creation-to-policy-fetch gap
  // going unblocked) no longer exists for the v1.7.4+ Phase 1/Phase 2
  // architecture: native lockdown is established BEFORE this page is
  // ever navigated to (see tether-launch/page.tsx's ensureSecureActivation),
  // so by the time this page mounts, a genuinely gated attempt's native
  // enforcement is either already ACTIVE+READY (the normal case) or was
  // never established at all (a direct load / reload / Tether restart) —
  // the effect below now queries which of those is true via the new
  // read-only getSecureClientEnforcementState bridge, and routes to a
  // real secure-reactivation handshake in the latter case, rather than
  // asserting a speculative cover flag that (as this P0 proved) can
  // itself become an unrecoverable trap.
  useEffect(() => {
    const detected = isRunningInLockdownBrowser();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInLockdownBrowser(detected);
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

  // Secure-recovery hardening v1, Part B — best-effort, read-only check
  // against the authoritative GET /api/submissions/[id]/recovery-status
  // endpoint. Fails OPEN (returns false) on any network/parse error: on
  // failure this simply falls through to the existing
  // TETHER_SESSION_REQUIRED redirect behaviour, unchanged from before
  // this hardening pass.
  const checkManualReviewRequired = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/submissions/${id}/recovery-status`);
      if (!res.ok) return false;
      const body: { state?: string } = await res.json();
      return body.state === "MANUAL_REVIEW_REQUIRED";
    } catch {
      return false;
    }
  }, [id]);

  const loadSubmission = useCallback(async () => {
    try {
      const res = await fetch(`/api/submissions/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // Tether launch/install flow v1 — see secureClientStartGate.ts.
        // This exam requires a verified Tether Secure Browser session
        // and none exists yet (e.g. the student reached this page
        // directly, outside Tether) — send them to the Tether launch
        // page instead of showing a dead-end access error.
        //
        // v1.7.4 pre-exam readiness, Part 6 — EXAM_NOT_ACTIVATED is the
        // SAME class of redirect: a secure-client-required attempt whose
        // native lockdown was never (or is no longer) confirmed ACTIVE
        // server-side (activatedAt still null — see
        // src/lib/secureClientActivation.ts). This is what closes the
        // direct-load bypass: a student cannot reach question content by
        // navigating straight to /student/exams/[submissionId] (bookmark,
        // browser history, a Tether restart resuming the last route) for
        // an attempt that was created but never activated — this GET
        // itself refuses the content, and the page below sends them back
        // through tether-launch's Phase 2 activation handshake instead of
        // ever rendering exam content from stale/absent `data`.
        if (
          res.status === 403 &&
          (body?.code === "TETHER_SESSION_REQUIRED" || body?.code === "EXAM_NOT_ACTIVATED") &&
          typeof body?.action?.redirectTo === "string"
        ) {
          // Secure-recovery hardening v1, Part B — before bouncing to the
          // tether-launch page (which, for an ordinary session gap, would
          // just relaunch and bounce straight back here), check whether
          // the authoritative recovery state already says this attempt
          // needs manual review. If so, stay here and show the notice
          // instead of entering the redirect loop between this page and
          // tether-launch — this is the other half of that loop (see
          // tether-launch/page.tsx's own checkManualReviewRequired for
          // the first half).
          const requiresManualReview = await checkManualReviewRequired();
          if (requiresManualReview) {
            setManualReviewRequired(true);
            return null;
          }
          router.replace(body.action.redirectTo);
          return null;
        }
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
  }, [id, applySubmissionData, router, checkManualReviewRequired]);

  // One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md. Declared early (ahead of
  // secureSettings/secureModeEnabled below, which are also derived from
  // `data`) since the fetch effect right below needs them.
  const oneQuestionAtATime = data?.exam.secureSettings.oneQuestionAtATime ?? false;
  const allowBackNavigation = data?.exam.secureSettings.allowBackNavigation ?? true;

  // Release-blocking follow-up review — a React render gate alone is NOT
  // sufficient: `loadSubmission()` fetches GET /api/submissions/[id],
  // which returns FULL question text/options the instant this attempt
  // is server-activated (activatedAt != null) — regardless of whether
  // native lockdown has ever been established in THIS Electron process
  // (a direct load, reload, or Tether restart could all reach this page
  // with native lockdown never confirmed here). Calling loadSubmission()
  // unconditionally on mount — even if the JSX render was gated — would
  // still let protected content enter renderer/browser memory before
  // native lockdown is confirmed. This effect is what decides WHETHER
  // AND WHEN loadSubmission() is ever called at all, for a Tether-gated
  // attempt: Tether detection, then the frozen per-attempt policy (via
  // the narrow, no-question-content /secure-client/status endpoint),
  // then — only for a gated attempt — a fresh native-state query, all
  // BEFORE the one fetch that can return question content. See
  // src/lib/secureExamNativeLockdown.ts's resolveNativeLockdownConfirmation.
  //
  // Deliberately a SEPARATE, EARLIER effect from the policy-resolution
  // effect below (which still runs its own independent re-check once
  // `data` exists, keyed on `data?.id`) — that effect cannot run first
  // because it depends on `data`, which does not exist until THIS effect
  // decides it is safe to fetch it. The later effect's redundant re-check
  // is intentional defense in depth, not dead code.
  useEffect(() => {
    let cancelled = false;

    async function resolveAndMaybeLoad() {
      const detected = isRunningInLockdownBrowser();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInLockdownBrowser(detected);

      if (!detected) {
        // Ordinary, non-Tether browser session — no native-lockdown
        // concept applies. Exactly the pre-v1.7.5 behaviour for
        // STANDARD_WEB / ordinary access: no added latency, no extra
        // fetch.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setContentGateState("NOT_APPLICABLE");
        void loadSubmission();
        return;
      }

      type PreLoadStatusResponse = {
        deliveryMode?: unknown;
        displayRequirement?: { status?: unknown } | null;
        examId?: unknown;
      };
      let statusBody: PreLoadStatusResponse | null = null;
      try {
        const res = await fetch(`/api/submissions/${id}/secure-client/status`);
        if (res.ok) statusBody = await res.json().catch(() => null);
      } catch {
        statusBody = null;
      }
      if (cancelled) return;

      if (
        !statusBody ||
        typeof statusBody.deliveryMode !== "string" ||
        typeof statusBody.displayRequirement?.status !== "string" ||
        typeof statusBody.examId !== "string"
      ) {
        // Fail closed WITHOUT ever calling loadSubmission() — content is
        // withheld via contentGateState (see the render-time gate), never
        // via a native cover flag.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setContentGateState("STATUS_UNAVAILABLE");
        return;
      }

      const gated = statusBody.deliveryMode === "TETHER_CLIENT_REQUIRED";
      if (!gated) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setContentGateState("NOT_APPLICABLE");
        void loadSubmission();
        return;
      }

      const requireSingleDisplay = statusBody.displayRequirement?.status === "ENFORCED_BY_SECURE_CLIENT";
      const bridgeAvailable = typeof window.sesLockdown?.getSecureClientEnforcementState === "function";
      let nativeState: { active: boolean; ready: boolean; requireSingleDisplay: boolean } | null = null;
      if (bridgeAvailable) {
        try {
          nativeState = (await window.sesLockdown!.getSecureClientEnforcementState!()) ?? null;
        } catch {
          nativeState = null;
        }
      }
      if (cancelled) return;

      const confirmation = resolveNativeLockdownConfirmation({ gated, bridgeAvailable, nativeState, requireSingleDisplay });
      logClientTetherDiagnostic("native_lockdown_preload_confirmation", { submissionId: id, confirmation, nativeState, requireSingleDisplay });
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContentGateState(confirmation);

      if (confirmation === "CONFIRMED") {
        // Native lockdown verified BEFORE this fetch — safe now.
        void loadSubmission();
        return;
      }
      if (confirmation === "REACTIVATION_REQUIRED") {
        // loadSubmission() is NEVER called on this path — zero
        // question-bearing requests. Route back through tether-launch's
        // own already-tested Phase 1/Phase 2 machinery.
        logClientTetherDiagnostic("NATIVE_REACTIVATION_REDIRECT_PRELOAD", { examId: statusBody.examId, submissionId: id });
        router.replace(buildTetherLaunchPagePath(statusBody.examId));
        return;
      }
      // UNSUPPORTED_BUILD — fail closed, no redirect (an old build would
      // fail this exact check again on return, looping forever), no
      // loadSubmission() call.
    }

    void resolveAndMaybeLoad();
    return () => {
      cancelled = true;
    };
  }, [id, loadSubmission, router]);

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

  // Tether Secure Exam Recovery and Resilient Autosave v1 — see
  // docs/tether-secure-resume-recovery-v1.md. Declared here (rather than
  // inline in saveAnswer/flushAnswerNow below) so its pendingCount can
  // also ride the existing session-heartbeat call (Part 5 — "pending-save
  // count"). `enabled` mirrors shouldRunExamTimer's own IN_PROGRESS gate —
  // never active for a finalized/not-yet-loaded submission.
  const resilientAutosave = useResilientAutosave<OneQuestionPayload>({
    userId: data?.student.id,
    examId: data?.exam.id ?? "",
    submissionId: submissionId ?? "",
    enabled: Boolean(submissionId) && submissionStatus === "IN_PROGRESS",
    // Physical acceptance follow-up ("answer could not be saved" symptom,
    // v1.7.5 physical test) — bounded, answer-content-free diagnostics for
    // a failed autosave attempt, routed onto the SAME AUTOSAVE_FAILED
    // integrity event this page already reports (see reportIntegrityEvent
    // below and its own metadata contract) so a lecturer/investigator
    // reviewing an attempt afterward can see WHY a save failed (timeout /
    // network error / which HTTP status / which short server error code /
    // how long it took) instead of a bare, undiagnosable event. Deliberately
    // referenced by closure rather than useCallback here — reportIntegrityEvent
    // itself is declared further below in this component, and the hook
    // only ever reads this via a ref it re-syncs every render (see
    // onSaveDiagnosticsRef in useResilientAutosave.ts), so a fresh
    // closure each render is the intended usage, not a missed memoization.
    onSaveDiagnostics: (questionId, diagnostics) => {
      if (!secureModeEnabled) return;
      reportIntegrityEvent("AUTOSAVE_FAILED", {
        questionIdPresent: Boolean(questionId),
        category: diagnostics.category,
        httpStatus: diagnostics.httpStatus,
        serverErrorCode: diagnostics.serverErrorCode,
        durationMs: diagnostics.durationMs,
        threw: diagnostics.threw,
        timedOut: diagnostics.timedOut,
        clientRevision: diagnostics.clientRevision,
        retryCount: diagnostics.retryCount,
        queueRetained: diagnostics.queueRetained,
      });
    },
    // Local diagnostic signal only (never sent to the server) — confirms
    // the local IndexedDB-backed queue did its job for a save that
    // initially failed. Deliberately not a new integrity event: this is
    // reassuring, not integrity-relevant, information.
    onRetrySucceeded: (questionId, attemptsBeforeSuccess) => {
      logClientTetherDiagnostic("AUTOSAVE_RETRY_SUCCEEDED", { questionIdPresent: Boolean(questionId), attemptsBeforeSuccess });
    },
  });
  // Ref mirror so the heartbeat closure below (created once per
  // effect run, not re-run on every pendingCount change) always reads the
  // CURRENT count rather than a stale one captured at effect-mount time —
  // same "a ref never goes stale mid-await/mid-closure" convention used
  // throughout this file (see e.g. cameraLifecycleRef).
  const pendingSaveCountRef = useRef(0);
  useEffect(() => {
    pendingSaveCountRef.current = resilientAutosave.pendingCount;
  }, [resilientAutosave.pendingCount]);
  const [offlineNow, setOfflineNow] = useState(false);
  // Tether Secure Exam Recovery and Resilient Autosave v1 — the single
  // authoritative recovery message (Part 1/6/8), fetched from
  // GET /api/submissions/[id]/recovery-status (never computed locally —
  // see that route's own doc comment: "the ONE read path"). Only fetched
  // when there's a real signal something may be wrong (the heartbeat
  // itself failing), not on a tight poll — this is a supplementary
  // check, not the primary connectivity signal (the browser's own
  // online/offline events and the autosave queue's own status already
  // cover the common case).
  const [recoveryStatusMessage, setRecoveryStatusMessage] = useState<string | null>(null);
  const [recoveryRedirectTo, setRecoveryRedirectTo] = useState<string | null>(null);
  const refreshRecoveryStatus = useCallback(async () => {
    if (!submissionId) return;
    try {
      const res = await fetch(`/api/submissions/${submissionId}/recovery-status`);
      if (!res.ok) return;
      const body: { state: string; detail: string; redirectTo: string | null; deadline: string } = await res.json();
      if (body.state === "ACTIVE" || body.state === "TEMPORARILY_DISCONNECTED") {
        setRecoveryStatusMessage(null);
        setRecoveryRedirectTo(null);
        setManualReviewRequired(false);
      } else if (body.state === "MANUAL_REVIEW_REQUIRED") {
        // Secure-recovery hardening v1, Part B — takes over the whole
        // page render (see the early-return branch below); the ordinary
        // banner message/redirect are irrelevant once this is set.
        setManualReviewRequired(true);
      } else if (body.state !== "SUBMITTED" && body.state !== "EXPIRED") {
        setRecoveryStatusMessage(body.detail);
        setRecoveryRedirectTo(body.redirectTo);
      }
      // Timer authority (Part 10) — "resume recalculates remaining time
      // from server time". The deadline itself never actually changes
      // (it's frozen at attempt start — see submissionDeadline in
      // assessmentLifecycle.ts), but re-confirming it from THIS
      // authoritative response after a reconnect/recovery event (rather
      // than only ever trusting the one-time value fetched at page load)
      // means a resumed attempt's displayed countdown is always re-
      // grounded in a fresh server read, never a stale client-held
      // reference from before a long gap.
      setData((prev) => (prev ? { ...prev, deadline: body.deadline } : prev));
    } catch {
      // Best-effort — the local connection banner already covers the
      // common case if this supplementary check itself can't complete.
    }
  }, [submissionId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (typeof navigator !== "undefined") setOfflineNow(navigator.onLine === false);
    const handleOffline = () => setOfflineNow(true);
    const handleOnline = () => setOfflineNow(false);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  // A failing exam-attempt heartbeat is exactly the signal worth an
  // authoritative recovery-status check (Part 1/6) — the ordinary
  // connection/save banner already covers plain network blips on its
  // own; this is specifically for "does the SERVER think something more
  // than a blip is going on" (stale session, device change, expired
  // exam). Re-checked once whenever the connection state actually
  // transitions, not on a tight poll.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (sessionConnectionState === "unconfirmed") void refreshRecoveryStatus();
  }, [sessionConnectionState, refreshRecoveryStatus]);

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
          pendingSaveCount: pendingSaveCountRef.current,
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
          // Question-navigation performance follow-up (Part 2) — this
          // came straight from the server, so it's a genuine
          // acknowledgement: a Next click with no further edits to this
          // question can skip re-saving it entirely.
          resilientAutosave.noteAcknowledged(payload.question.id, payload.existingResponse);
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
    // Tether Secure Exam Recovery and Resilient Autosave v1 — routes
    // through the resilient queue (persists to IndexedDB before
    // attempting the network call) instead of a raw fetch. External
    // contract UNCHANGED: resolves true only once the server has
    // actually acknowledged — a caller here still blocks navigation on
    // false, exactly as before. What's new: on false, the draft is now
    // safely queued and retried automatically, rather than only living
    // in this component's in-memory `responses` state.
    const acknowledged = await resilientAutosave.save(questionId, response);
    if (!acknowledged) {
      if (secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
      return false;
    }
    // Answer-Development Provenance v1 — a navigation-triggered
    // checkpoint, after the ordinary autosave above has already
    // succeeded. Best-effort; never blocks navigation.
    answerDevelopmentCapture.flushNavigation(questionId, response);
    return true;
  }

  // Applies a freshly loaded one-question payload uniformly — shared by
  // every navigation path (single-round-trip save+navigate, navigation-
  // only, and GOTO) so the "seed responses + note server acknowledgement"
  // step can never drift between them.
  function applyOneQuestionPayload(payload: OneQuestionPayload) {
    setOneQuestion({ loading: false, error: null, payload });
    if (payload.existingResponse != null) {
      setResponses((prev) =>
        prev[payload.question.id] !== undefined ? prev : { ...prev, [payload.question.id]: payload.existingResponse! },
      );
      // Question-navigation performance follow-up (Part 2) — this came
      // straight from the server, so it's a genuine acknowledgement: a
      // Next click with no further edits to this (now current) question
      // can skip re-saving it entirely.
      resilientAutosave.noteAcknowledged(payload.question.id, payload.existingResponse);
    }
  }

  // Question-navigation performance follow-up — the "already
  // acknowledged, nothing to save" and "an in-flight save just resolved"
  // cases both end here: a single navigation-only request, reusing the
  // existing POST /question-progress route unchanged.
  //
  // Question Navigator immediate-sync follow-up (Part 8) —
  // previousQuestionId/previousAuthoritativeResponse describe the
  // question being LEFT (never touched when navigation itself failed).
  async function requestNavigationOnly(
    requestedIndex: number,
    navigationStartedAtMs: number,
    previousQuestionId: string,
    previousAuthoritativeResponse: string | null,
    strategy?: "SKIP_SAVE" | "REUSE_IN_FLIGHT_SAVE",
  ) {
    try {
      const questionProgressStartedAtMs = performance.now();
      const res = await fetch(`/api/submissions/${id}/question-progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentIndex: requestedIndex }),
      });
      const questionProgressMs = Math.round(performance.now() - questionProgressStartedAtMs);
      const serverTiming = res.headers.get("Server-Timing");
      if (!res.ok) throw new Error("navigation failed");
      const jsonParseStartedAtMs = performance.now();
      const payload: OneQuestionPayload = await res.json();
      const jsonParseMs = performance.now() - jsonParseStartedAtMs;
      const applyPayloadStartedAtMs = performance.now();
      applyOneQuestionPayload(payload);
      const applyPayloadMs = performance.now() - applyPayloadStartedAtMs;
      // Question Navigator immediate-sync follow-up (Part 8) — updates
      // the CURRENT/ANSWERED/SKIPPED tiles and every tile's
      // locked/canNavigate state immediately from this same response,
      // without waiting for the separate GET question-navigator request
      // the effect below still triggers in the background (Part 8 step 7
      // — reconciles counts/server-only metadata; never the fast path).
      setQuestionNav((prev) =>
        prev
          ? applyLocalNavigatorTransition(prev, {
              previousQuestionId,
              previousAuthoritativeResponse,
              newQuestionId: payload.question.id,
              newIndex: payload.currentIndex,
            })
          : prev,
      );
      logClientTetherDiagnostic("QUESTION_NAVIGATION_TIMING", {
        strategy: strategy ?? null,
        questionProgressMs,
        jsonParseMs: Math.round(jsonParseMs),
        applyPayloadMs: Math.round(applyPayloadMs),
        totalClickToVisibleMs: Math.round(performance.now() - navigationStartedAtMs),
        combinedRequest: false,
        serverTiming,
      });
    } catch {
      setOneQuestion((prev) => ({
        ...prev,
        error: "Could not load the next question. Please try again.",
      }));
    } finally {
      setNavigatingQuestion(false);
    }
  }

  // One-Question-At-A-Time Exam Delivery v1 — the only place the current
  // question index actually changes. Always saves the current answer
  // first (per the navigation rules); never advances if that save fails,
  // so a student is never trapped by a transient autosave failure but
  // also never silently loses an answer by moving on regardless.
  // allowBackNavigation is enforced server-side in the question-progress/
  // save-and-navigate routes regardless of what this sends — this is UX
  // only, not the source of truth.
  //
  // Question-navigation performance follow-up — three cases, exactly one
  // foreground request each:
  //  1. Nothing to save (never touched, or already server-acknowledged
  //     and unchanged) -> navigation-only request.
  //  2. An identical-content save is already in flight (e.g. the
  //     debounced autosave just fired) -> await/reuse it, then
  //     navigation-only (never a duplicate save).
  //  3. A genuinely dirty answer -> ONE combined save-and-navigate
  //     request, replacing the previous PATCH-then-POST sequence.
  // The next question is never rendered before its save (if any) has
  // been server-acknowledged — no optimistic navigation.
  async function navigateQuestion(requestedIndex: number) {
    if (!oneQuestion.payload || navigatingQuestion) return;
    // Latency profiling (physical acceptance follow-up — question
    // navigation latency audit). Bounded, dev-only timing for the whole
    // click-to-next-question-visible path — see
    // logClientTetherDiagnostic's own doc comment (never logs answer/
    // question content, only durations/booleans).
    const navigationStartedAtMs = performance.now();
    setNavigatingQuestion(true);
    setOneQuestion((prev) => ({ ...prev, error: null }));

    const questionId = oneQuestion.payload.question.id;
    clearTimeout(saveTimers.current[questionId]);
    const response = responses[questionId];

    // Physical acceptance follow-up — save/next latency diagnosis. Pure
    // extraction (classifyNavigationSaveStrategy, src/lib/pendingSaveQueue.ts)
    // of the exact same three-way split this inline expression used to
    // compute directly — see that function's own doc comment for why
    // SKIP_SAVE and REUSE_IN_FLIGHT_SAVE are kept distinct rather than
    // collapsed into one "not dirty" boolean.
    const strategy = classifyNavigationSaveStrategy({
      responseIsDefined: response !== undefined,
      isAcknowledged: response !== undefined && resilientAutosave.isAcknowledged(questionId, response),
      hasInFlightSave: response !== undefined && resilientAutosave.getInFlightSave(questionId, response) !== null,
    });

    if (strategy === "COMBINED_SAVE_AND_NAVIGATE") {
      const result = await resilientAutosave.saveAndNavigate(questionId, response, requestedIndex);
      if (!result.ok) {
        if (secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
        setOneQuestion((prev) => ({
          ...prev,
          error: "Your answer could not be saved. Please try again before moving on.",
        }));
        setNavigatingQuestion(false);
        return;
      }
      // PR #25 review fix — a 200 from save-and-navigate does not always
      // mean OUR text won: the server may have safely no-opped a stale
      // revision in favour of an already-newer stored answer. When that
      // happens (acknowledgement === "CONFLICT"), reconcile this
      // question's local draft to the server's own authoritative text —
      // never leave the rejected local text sitting in `responses`,
      // where navigating back to this question later would otherwise
      // show it again as if it had been saved.
      if (result.acknowledgement === "CONFLICT") {
        setResponses((prev) => ({ ...prev, [result.questionId]: result.authoritativeResponse }));
      }
      // Answer-Development Provenance v1 — a navigation-triggered
      // checkpoint, after the save above has already succeeded.
      // Best-effort; never blocks navigation.
      answerDevelopmentCapture.flushNavigation(questionId, response);
      const applyPayloadStartedAtMs = performance.now();
      applyOneQuestionPayload(result.payload);
      const applyPayloadMs = performance.now() - applyPayloadStartedAtMs;
      // Question Navigator immediate-sync follow-up (Part 8) —
      // result.authoritativeResponse is correct on BOTH SAVED and
      // CONFLICT (see resolveSaveAndNavigateAcknowledgement in
      // useResilientAutosave.ts): on SAVED it's the text we just sent, on
      // CONFLICT it's the server's own kept text — never the possibly-
      // rejected local `response` blindly.
      setQuestionNav((prev) =>
        prev
          ? applyLocalNavigatorTransition(prev, {
              previousQuestionId: questionId,
              previousAuthoritativeResponse: result.authoritativeResponse,
              newQuestionId: result.payload.question.id,
              newIndex: result.payload.currentIndex,
            })
          : prev,
      );
      logClientTetherDiagnostic("QUESTION_NAVIGATION_TIMING", {
        strategy,
        totalClickToVisibleMs: Math.round(performance.now() - navigationStartedAtMs),
        applyPayloadMs: Math.round(applyPayloadMs),
        combinedRequest: true,
        acknowledgement: result.acknowledgement,
        serverTiming: result.serverTiming,
      });
      setNavigatingQuestion(false);
      return;
    }

    // SKIP_SAVE (nothing to save) or REUSE_IN_FLIGHT_SAVE (an identical
    // save is already in flight) — flushAnswerNow resolves instantly in
    // the former case and simply awaits the existing in-flight promise in
    // the latter; either way, no NEW save request is issued here.
    const saved = await flushAnswerNow(questionId);
    if (!saved) {
      setOneQuestion((prev) => ({
        ...prev,
        error: "Your answer could not be saved. Please try again before moving on.",
      }));
      setNavigatingQuestion(false);
      return;
    }
    await requestNavigationOnly(requestedIndex, navigationStartedAtMs, questionId, response ?? null, strategy);
  }

  // Question Navigator v1 — see docs/question-navigator-v1.md. Refreshed
  // after every navigation, flag change, or answer save so counts/states
  // never go stale. Silently no-ops on failure (progress display, not the
  // source of truth for anything security-relevant).
  //
  // Question Navigator stale-request guard (Part 9) — this GET has been
  // physically observed taking 2-3s. A student who navigates quickly
  // (Q1->Q2->Q3) can have an OLDER request (started for Q1->Q2) resolve
  // AFTER a newer one (Q2->Q3), which would otherwise regress the
  // displayed navigator back to a stale Q2 snapshot even though the
  // student is already looking at Q3. navigatorRequestGenerationRef is a
  // monotonically increasing token: only the response whose generation
  // still matches the CURRENT value when it resolves is allowed to call
  // setQuestionNav — every older, now-superseded response is silently
  // discarded. A failed/rejected fetch never touches questionNav either,
  // so the locally-updated (Part 8) navigator is never rolled back by a
  // background reconciliation failure, and exam progression is
  // unaffected either way.
  const loadNavigator = useCallback(async () => {
    const generation = ++navigatorRequestGenerationRef.current;
    try {
      const res = await fetch(`/api/submissions/${id}/question-navigator`);
      if (!res.ok) return;
      const data = await res.json();
      if (generation !== navigatorRequestGenerationRef.current) return;
      setQuestionNav(data);
    } catch {
      // Background reconciliation failure — leave the locally-updated
      // navigator (Part 8) in place; never affects exam progression.
    }
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
      applyOneQuestionPayload(payload);
      setNavigatorAnnouncement(`Moved to question ${payload.currentIndex + 1} of ${payload.totalQuestions}.`);
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

  // Tether launch/install flow v1 — see apps/lockdown/src/displayEnforcement.ts.
  // Only relevant inside Tether Secure Browser.
  //
  // v1.7.5 P0 — this effect now ALSO owns the native-lockdown
  // reconciliation gate (see src/lib/secureExamNativeLockdown.ts): for a
  // gated attempt, it queries the Electron main process's own live
  // enforcement state (never a client-held boolean) via the new
  // read-only getSecureClientEnforcementState bridge BEFORE ever
  // confirming content is safe to render. If native lockdown is already
  // ACTIVE+READY (the normal Phase 2 handoff, completed moments earlier
  // by tether-launch/page.tsx), it is preserved — never re-asserted with
  // a downgrading {active:true, ready:false} the way the old removed
  // mount-time cover did. If it is NOT confirmed (a direct load, reload,
  // or Tether restart that never went through Phase 2 in this Electron
  // process), content stays withheld and the student is routed back to
  // the tether-launch page for a fresh secure-reactivation handshake —
  // reusing that page's own already-tested precheck/native-activation
  // machinery rather than inventing a second one here.
  //
  // Depends on data?.id (stable for the lifetime of one attempt) rather
  // than the whole `data` object, so this registers exactly once per
  // submission even if `data` is re-fetched/replaced by polling
  // elsewhere on this page — window.sesLockdown.onDisplayEnforcementEvent
  // has no remove-listener API, so re-registering on every re-fetch
  // would leak duplicate listeners and duplicate event reports.
  useEffect(() => {
    if (!data?.id || !inLockdownBrowser) return;
    const submissionId = data.id;
    const examId = data.exam.id;
    let cancelled = false;
    let sessionId: string | null = null;

    type StatusResponse = {
      deliveryMode?: unknown;
      requireDisplayCheck?: unknown;
      maximumDisplays?: unknown;
      displayRequirement?: { status?: unknown; displayPolicy?: unknown } | null;
      session?: { id: string; verificationStatus?: unknown } | null;
    };

    fetch(`/api/submissions/${submissionId}/secure-client/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then(async (status: StatusResponse | null) => {
        if (cancelled) return;
        // A non-ok response or an unexpectedly shaped body both land
        // here as a rejection, matching the .catch below.
        if (!status || typeof status.deliveryMode !== "string" || typeof status.displayRequirement?.status !== "string") {
          throw new Error("malformed_status_response");
        }
        sessionId = status.session?.id ?? null;
        const gated = status.deliveryMode === "TETHER_CLIENT_REQUIRED";
        // For a gated exam, reaching this point already implies a
        // verified secure-client session: GET /api/submissions/[id] (the
        // route that produced `data` above) 403s with
        // TETHER_SESSION_REQUIRED for a TETHER_CLIENT_REQUIRED exam with
        // no verified session, redirecting to the Tether launch page
        // instead of ever setting `data` — see
        // src/app/api/submissions/[id]/route.ts and this page's
        // loadSubmission redirect handling.
        const verified = !gated || status.session?.verificationStatus === "VERIFIED";
        const enforced = status.displayRequirement?.status === "ENFORCED_BY_SECURE_CLIENT";
        logClientTetherDiagnostic("attempt_policy_loaded", {
          deliveryMode: status.deliveryMode,
          displayPolicy: typeof status.displayRequirement?.displayPolicy === "string" ? status.displayRequirement.displayPolicy : null,
          requireDisplayCheck: typeof status.requireDisplayCheck === "boolean" ? status.requireDisplayCheck : null,
          verified,
        });

        // v1.7.5 P0 — query the FRESH native state before deciding
        // anything; never assume, never trust a stale client-side value.
        const bridgeAvailable = typeof window.sesLockdown?.getSecureClientEnforcementState === "function";
        let nativeState: { active: boolean; ready: boolean; requireSingleDisplay: boolean } | null = null;
        if (gated && bridgeAvailable) {
          try {
            nativeState = (await window.sesLockdown!.getSecureClientEnforcementState!()) ?? null;
          } catch {
            nativeState = null;
          }
        }
        if (cancelled) return;
        const confirmation = resolveNativeLockdownConfirmation({ gated, bridgeAvailable, nativeState, requireSingleDisplay: enforced });
        logClientTetherDiagnostic("native_lockdown_confirmation", { submissionId, confirmation, nativeState });
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setContentGateState(confirmation);

        if (confirmation === "REACTIVATION_REQUIRED") {
          // Content stays withheld (see the render-time gate below) —
          // route back through tether-launch's own Phase 1/Phase 2
          // machinery rather than asserting any native state here. That
          // page's POST /api/exams/[id]/start (idempotent — resumes this
          // SAME IN_PROGRESS submission) and POST /activate (idempotent —
          // already-activated returns ok without moving activatedAt) make
          // this round trip safe to repeat any number of times.
          logClientTetherDiagnostic("NATIVE_REACTIVATION_REDIRECT", { examId, submissionId });
          router.replace(buildTetherLaunchPagePath(examId));
          return;
        }
        if (confirmation === "UNSUPPORTED_BUILD") {
          // Fail closed, no redirect — a build old enough to lack this
          // v1.7.5 query bridge cannot be asked to reconcile, and routing
          // it through tether-launch would only loop (that page's own
          // Phase 2 handshake could genuinely succeed there, but this
          // exact check would fail again on return, forever). See the
          // render-time gate below for the calm, non-looping message
          // shown instead.
          return;
        }

        const nextEnforcementState = { active: gated, ready: !gated || verified, requireSingleDisplay: enforced };
        logClientTetherDiagnostic("ipc_enforcement_state_sent", nextEnforcementState);
        window.sesLockdown?.setSecureClientEnforcementState?.(nextEnforcementState);
        // Tether Windows Lockdown Hardening v1, Part 4 — the during-exam
        // process-detection poll only ever runs for a genuinely gated,
        // verified attempt; a non-Tether (STANDARD_WEB) exam is
        // completely unaffected (Part 16 item 32).
        if (gated && verified) {
          void ensureLockdownBridgeInitialized().then((info) => {
            lockdownCapabilityInfoRef.current = info;
          });
        }
        window.sesLockdown?.setLockdownExamActive?.(gated && verified);
        window.sesLockdown?.reportDiagnosticContext?.({
          submissionIdPresent: true,
          verifiedSecureClientSession: verified,
          deliveryMode: status.deliveryMode,
          displayPolicy: typeof status.displayRequirement?.displayPolicy === "string" ? status.displayRequirement.displayPolicy : null,
          requireDisplayCheck: typeof status.requireDisplayCheck === "boolean" ? status.requireDisplayCheck : null,
          maximumDisplays: typeof status.maximumDisplays === "number" ? status.maximumDisplays : null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        // v1.7.5 P0 — fail closed WITHOUT asserting a native cover flag:
        // the old {active:true, ready:false} re-assertion here is exactly
        // the anti-pattern this whole pass removes (see the removed
        // mount-time-cover doc comment above `inLockdownBrowser`).
        // Content-side withholding (STATUS_UNAVAILABLE, via the
        // render-time gate below — a plain in-page message, never a
        // native overlay) is now the ONLY enforcement for "the policy
        // fetch itself failed"; native state is left untouched.
        logClientTetherDiagnostic("attempt_policy_load_failed", {});
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setContentGateState("STATUS_UNAVAILABLE");
        window.sesLockdown?.setLockdownExamActive?.(false);
        window.sesLockdown?.reportDiagnosticContext?.({
          submissionIdPresent: true,
          verifiedSecureClientSession: false,
          deliveryMode: null,
          displayPolicy: null,
          requireDisplayCheck: null,
          maximumDisplays: null,
        });
      });

    window.sesLockdown?.onDisplayEnforcementEvent?.((payload) => {
      if (cancelled || !sessionId) return;
      // Bounded evidence only — displayCount, event type, timestamp
      // (server-assigned) — never display names, serials, EDID or
      // device paths, matching the existing displayMetadataSchema in
      // src/lib/secureClient/secureClientEvents.ts.
      //
      // v1.7.4 pre-exam readiness — DISPLAY_CHECK_TECHNICAL_FAILURE (the
      // native topology query being inconclusive/ERROR/UNKNOWN) is NOT a
      // display-presence claim and must never be recorded under
      // ADDITIONAL_DISPLAY_PRESENT/DISPLAY_CONFIGURATION_CHANGED's
      // displayMetadataSchema — it maps to the existing, generic
      // CLIENT_TECHNICAL_FAILURE event type instead, exactly like any
      // other technical (non-integrity) client failure.
      const body =
        payload.eventType === "DISPLAY_CHECK_TECHNICAL_FAILURE"
          ? { eventType: "CLIENT_TECHNICAL_FAILURE", metadata: { reasonCode: "TOPOLOGY_CHECK_UNAVAILABLE" } }
          : { eventType: payload.eventType, metadata: { displayCount: payload.displayCount } };
      fetch(`/api/secure-client/sessions/${sessionId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    });

    // Native Display State Bridge (v1.7.6) — pre-commit audit fix. The
    // live listener is registered FIRST, then the read-only initial query
    // is issued — never the other way around — so a native transition
    // that occurs during the query's own IPC round trip is never missed
    // (the listener is already active by the time that round trip even
    // starts). This must safely handle both directions: initial OK with
    // a display connected mid-mount (BLOCKED must win), and initial
    // BLOCKED with the display disconnected mid-mount (OK must win).
    //
    // liveDisplayUpdateReceived guards the INVERSE race: a live push
    // arriving WHILE the initial query is still in flight, followed by
    // that query's now-stale snapshot resolving afterward and clobbering
    // the newer live state. Once any live push has been observed, the
    // initial query's own result is discarded outright — the live
    // listener is authoritative from that point on. A plain local
    // variable (not a ref) is deliberately sufficient here: it is
    // captured once per effect run by both closures below and never
    // needs to survive a re-render, only the lifetime of this one
    // registration.
    let liveDisplayUpdateReceived = false;

    const unsubscribeDisplayEnforcementState = window.sesLockdown?.onDisplayEnforcementStateChanged?.((status) => {
      if (cancelled) return;
      liveDisplayUpdateReceived = true;
      setDisplayEnforcementStatus(status);
    });

    // Purely local UI state (drives the blur+modal below only) — never
    // affects the native decision, the existing integrity-event reporting
    // above, or the render-time content gate. Catches an already-active
    // violation on a fresh mount/reload, since the listener above only
    // ever fires on the NEXT transition.
    //
    // Pre-commit audit fix (PR #26) — a REJECTED query must not be
    // silently ignored: native state could already be BLOCKED before
    // this renderer mounted, and because live pushes are deduplicated
    // against the last status, an unchanged BLOCKED state may never fire
    // another push to recover from — doing nothing here would be a
    // fail-OPEN presentation gap. On rejection, fail closed with the same
    // bounded, neutral status TOPOLOGY_CHECK_UNAVAILABLE already uses
    // (never a fabricated "additional display detected" claim). Still
    // respects both guards above: a cancelled/unmounted effect, and a
    // live push that has already superseded this query.
    window.sesLockdown
      ?.getDisplayEnforcementStatus?.()
      .then((status) => {
        if (cancelled || !status || liveDisplayUpdateReceived) return;
        setDisplayEnforcementStatus(status);
      })
      .catch(() => {
        if (cancelled || liveDisplayUpdateReceived) return;
        setDisplayEnforcementStatus(displayStatusOnInitialQueryFailure());
      });

    // Tether Windows Lockdown Hardening v1, Part 4/11 — see
    // lockdownClient.ts's own doc comments for exactly what each
    // transition becomes (a reviewable IntegrityEvent, an informational
    // one, or nothing at all for WARN_AND_REQUIRE_CLOSE). Registered once
    // per submission, mirroring onDisplayEnforcementEvent's own "no
    // remove-listener API" constraint further above (NOT the Native
    // Display State Bridge's onDisplayEnforcementStateChanged
    // immediately above, which — unlike this one — DOES return an
    // unsubscribe function and IS cleaned up, in this effect's own
    // return() below).
    window.sesLockdown?.onLockdownCapabilityTransition?.((payload) => {
      if (cancelled) return;
      void reportLockdownCapabilityTransition({
        submissionId,
        capabilityId: payload.capabilityId,
        effectiveAction: payload.effectiveAction,
        phase: payload.phase,
        detectedAtMsForClear: payload.detectedAtMsForClear,
        capabilityInfo: lockdownCapabilityInfoRef.current,
      });
    });
    window.sesLockdown?.onLockdownScanUnavailable?.((payload) => {
      if (cancelled) return;
      reportLockdownScanUnavailable(payload.reason);
    });

    // Mid-exam remote-session monitoring v1 — one call per de-duplicated
    // transition (see remoteSessionMonitor.ts); registered once per
    // submission, mirroring every other onLockdown*/onDisplay* listener
    // above. secureClientSessionId reads the SAME `sessionId` this effect
    // already resolved from GET .../secure-client/status above — null
    // only for the (non-Tether-gated) case where no secure-client session
    // exists at all, in which case this listener never fires in the first
    // place (the monitor itself never starts — see setLockdownExamActive
    // above, gated on the same `gated && verified`).
    window.sesLockdown?.onRemoteSessionMonitorEvent?.((payload) => {
      if (cancelled) return;
      void reportRemoteSessionMonitorTransition({
        submissionId,
        kind: payload.kind,
        effectiveAction: payload.effectiveAction,
        previousState: payload.previousState,
        currentState: payload.currentState,
        detectedAtMsForClear: payload.detectedAtMsForClear,
        classification: payload.classification,
        tetherVersion: window.sesLockdown?.version ?? "unknown",
        secureClientSessionId: sessionId,
      });
      // Required behaviour #7 — an event-triggered evidence frame when the
      // remote-session state becomes active, only ever when screen
      // evidence capture is actually enabled/active (gated inside
      // useScreenShareLifecycle.captureIntegrityEvidence itself — this
      // call is a harmless no-op otherwise, and any capture/upload
      // failure is already non-fatal there, matching PERIODIC/RESTORATION
      // captures).
      if (payload.kind === "BECAME_ACTIVE") {
        remoteSessionCaptureEvidenceRef.current();
      }
    });

    return () => {
      cancelled = true;
      // Native Display State Bridge (v1.7.6) — pre-commit audit fix.
      // Removes EXACTLY the one listener this effect run registered
      // above, unlike onDisplayEnforcementEvent/onLockdownCapabilityTransition/
      // onRemoteSessionMonitorEvent (which have no removal mechanism at
      // all, by existing precedent, and instead rely on this effect's own
      // stable dependency array to avoid re-registering). Without this, a
      // remount/reload would leave the old callback listening forever
      // alongside the new one — a stale closure referencing an unmounted
      // render's setState, and duplicate handling of every future push.
      unsubscribeDisplayEnforcementState?.();
      // Part 10 — leaving this page (submission finalized, navigation
      // away) is one of the explicit restoration triggers; safe to call
      // even if lockdown enforcement never actually activated this
      // attempt (STANDARD_WEB exams, or a status fetch that failed
      // before ever activating it) — see lockdownLifecycle.ts.
      window.sesLockdown?.setLockdownExamActive?.(false);
      window.sesLockdown?.restoreLockdownControls?.("exam-page-unmount");
    };
  }, [data?.id, inLockdownBrowser]);

  const secureSettings = data?.exam.secureSettings;
  const secureModeEnabled = secureSettings?.secureModeEnabled ?? false;

  // Screen-share Evidence Mode v1 — see docs/screen-share-evidence-v1.md.
  // Called unconditionally on every render (Rules of Hooks) — this
  // component has no early return before this point. `enabled` gates all
  // actual monitoring/capture behind the gate screen being acknowledged
  // AND the attempt still being IN_PROGRESS; policy defaults to OFF
  // before `data` has loaded, which is always safe (nothing starts on
  // its own — see useScreenShareLifecycle.ts).
  const screenShare = useScreenShareLifecycle({
    submissionId: id,
    policy: {
      mode: secureSettings?.screenShareMode ?? "OFF",
      captureEvidence: secureSettings?.screenShareCaptureEvidence ?? false,
      evidenceIntervalSeconds: secureSettings?.screenShareEvidenceIntervalSeconds ?? 60,
      maxEvidenceFrames: secureSettings?.screenShareMaxEvidenceFrames ?? 20,
    },
    enabled: gateAcknowledged && data?.status === "IN_PROGRESS",
  });
  remoteSessionCaptureEvidenceRef.current = screenShare.captureIntegrityEvidence;
  const requireScreenShare = secureSettings?.screenShareMode === "REQUIRED";
  const screenShareGateSatisfied = !requireScreenShare || screenShare.state === "ACTIVE";

  // Answer-Development Provenance v1 — see
  // docs/answer-development-provenance-v1.md. Called unconditionally
  // (Rules of Hooks); `enabled` gates all actual capture behind the
  // policy being on AND the attempt still being IN_PROGRESS. THIS IS
  // PROCESS EVIDENCE, NOT A MISCONDUCT DETECTOR — see that hook for what
  // is (and, just as importantly, is not) ever sent to the server.
  const answerProvenanceMode = secureSettings?.answerProvenanceMode ?? "OFF";
  const answerDevelopmentCapture = useAnswerDevelopmentCapture({
    submissionId: id,
    enabled: answerProvenanceMode !== "OFF" && data?.status === "IN_PROGRESS",
    intervalSeconds: secureSettings?.answerVersionIntervalSeconds ?? 60,
  });

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

    // Tether Secure Exam Recovery and Resilient Autosave v1 — routes
    // through the resilient queue so a flush-before-submit that fails to
    // reach the server (Part 4/9) is safely queued/retried rather than
    // simply dropped, exactly like every other autosave path.
    await Promise.allSettled(
      Object.entries(responses).map(([questionId, response]) => resilientAutosave.save(questionId, response)),
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

    // Final submission idempotency (Part 9) — a fresh id per attempt; the
    // server's own advisory-lock + conditional-status-update idempotency
    // (already in place) is the real correctness guarantee regardless of
    // whether a retry happens to reuse this id — this is primarily for
    // audit/reconciliation ("was my specific request the one accepted").
    const submissionRequestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

    const res = await fetch(`/api/submissions/${id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemAutoSubmit: options.systemAutoSubmit === true, submissionRequestId }),
    }).catch(() => null);
    setSubmitting(false);

    if (!res) {
      // Final submission idempotency (Part 9) — a network failure here
      // does NOT necessarily mean the server never received/committed
      // the request (it may have committed and the response was simply
      // lost). "Checking submission status" resolves that ambiguity by
      // querying the authoritative GET route rather than assuming
      // failure.
      setSubmitMessage("Checking submission status...");
      const latest = await loadSubmission().catch(() => null);
      if (latest && isFinalizedSubmissionStatus(latest.status)) {
        terminalSubmitRef.current = true;
        setTimerStopped(true);
        setAutoSubmitLocked(false);
        stopCamera();
        stopAiDetection();
        screenShare.stop();
        await resilientAutosave.clearAll();
        setSubmitMessage(
          options.systemAutoSubmit
            ? "Time is up. Your exam has been submitted."
            : "Submission received.",
        );
        router.refresh();
        return;
      }
      if (options.systemAutoSubmit) setAutoSubmitLocked(false);
      setSubmitMessage(
        options.systemAutoSubmit
          ? "Time is up. Automatic submission could not be confirmed. Contact your lecturer or exam support if this continues."
          : "Save could not yet be confirmed. Please try submitting again.",
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
        screenShare.stop();
        // Pending local drafts are cleared only after CONFIRMED server
        // submission (Part 9/15) — this branch just confirmed exactly
        // that via the authoritative GET.
        await resilientAutosave.clearAll();
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
      screenShare.stop();
      const updated = await res.json();
      terminalSubmitRef.current = true;
      setTimerStopped(true);
      setAutoSubmitLocked(false);
      setData((prev) => (prev ? { ...prev, status: updated.status, totalScore: updated.totalScore } : prev));
      // Pending local drafts are cleared only after CONFIRMED server
      // submission (Part 9/15) — res.ok here means the server actually
      // finalized the submission (a fresh submit or an idempotent
      // ALREADY_FINALIZED replay both return 200 — see the submit route).
      await resilientAutosave.clearAll();
      // Tether Windows Lockdown Hardening v1, Part 10 — "normal exam
      // submission" is an explicit restoration trigger; stop the
      // during-exam poll and tear down any active overlay/state
      // immediately, rather than waiting for this page to eventually
      // unmount (the student may linger here reading the confirmation
      // message).
      window.sesLockdown?.setLockdownExamActive?.(false);
      window.sesLockdown?.restoreLockdownControls?.("submission-completed");
      if (options.systemAutoSubmit) {
        setSubmitMessage("Time is up. Your exam has been submitted automatically.");
      } else {
        setSubmitMessage("Submission received.");
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
    // Strengthened phone detection — a camera restart is a genuinely new
    // stream; stale candidate tracks from the previous stream must never
    // carry over (Part 6, phone-detection-calibration-v1.md).
    phoneTrackerRef.current.reset();
    phoneCropInferenceTimestampsRef.current = [];
    phoneDetectionTickIndexRef.current = 0;
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
      // Physical acceptance follow-up — phone-detection calibration
      // observability. Purely observational: only ever read to build a
      // bounded summary attached to an ALREADY-emitted POSSIBLE_PHONE_VISIBLE
      // event (see the calibration block below) — never affects scheduling,
      // detection, or emission itself.
      const tickStartMs = performance.now();
      const video = detectionVideoRef.current;
      const cooldown = detectionCooldown.current;
      const now = Date.now();
      let inferenceMs: number | null = null;

      logAiCameraDebug("tick: start", { tickTimestamp: now, cadenceMs: currentDetectionDelayMs });

      try {
        if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

        // Corrective pass v1.2.2, Task 8 — a camera resource/capture
        // failure (e.g. Windows Media Foundation "Failed to reserve
        // output capture buffer", commonly caused by another app such as
        // Microsoft Teams holding the camera) must never be classified
        // as face absence. The <video> element's readyState/dimensions
        // checked just above can stay stale at their last good values
        // even once the underlying track has stopped delivering frames,
        // so this checks the MediaStreamTrack itself — the same signal
        // the existing camera heartbeat already relies on — BEFORE any
        // pixel data from this (possibly frozen) frame is drawn or fed
        // into person/phone/frame-quality detection.
        const activeTrack = cameraStreamRef.current?.getVideoTracks()[0];
        const streamHealth = classifyCameraStreamHealth(
          activeTrack ? { readyState: activeTrack.readyState, muted: activeTrack.muted } : null,
        );
        const streamUnavailableCount = cooldown.recordObservation("streamUnavailable", streamHealth === "unavailable");
        const streamDecision = decideCameraStreamEmission(
          streamHealth,
          streamUnavailableCount,
          cooldown.canEmit("CAMERA_STREAM_UNAVAILABLE", now, 60_000),
        );
        if (streamDecision.shouldEmit) {
          cooldown.markEmitted("CAMERA_STREAM_UNAVAILABLE", now);
          reportIntegrityEvent("CAMERA_STREAM_UNAVAILABLE", {
            source: "on_device_camera_ai",
            confidenceBand: "high",
            trackReadyState: activeTrack?.readyState ?? "absent",
          });
        }
        if (streamHealth === "unavailable") {
          // Never draw/classify this frame at all — every downstream
          // signal (blocked, dark, no-person, phone, second-person) is
          // skipped this tick, which also freezes their consecutive-tick
          // counters exactly as if the tick had not run (see
          // decideNoPersonEmission's frameQuality gate for the same
          // hysteresis pattern).
          logAiCameraDebug("tick: skipped — camera stream unavailable", {
            trackReadyState: activeTrack?.readyState ?? "absent",
            trackMuted: activeTrack?.muted ?? null,
          });
          return;
        }

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
          bestPersonScore: 0,
        };
        let phoneDecision = decidePhoneEmission({ detected: false, confidence: 0 }, true);
        let secondPersonDecision = decideSecondPersonEmission(noFreshPersonData, 0, true);
        let noPersonDecision = decideNoPersonEmission(noFreshPersonData, quality, 0, 0, true);

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

            const phoneCooldownOk = cooldown.canEmit("POSSIBLE_PHONE_VISIBLE", now, 45_000);
            const secondPersonCount = cooldown.recordObservation("secondPerson", person.multiplePersons);
            const secondPersonCooldownOk = cooldown.canEmit("POSSIBLE_SECOND_PERSON_VISIBLE", now, 45_000);
            // Face-visibility false-positive fix (Part 4): the no-person
            // streak FREEZES (neither increments nor resets — hysteresis)
            // on a tick where the frame quality isn't "ok" (dark/blocked —
            // CAMERA_TOO_DARK/CAMERA_VIEW_BLOCKED already report that
            // separately) or where the detector is merely "uncertain"
            // (a near-threshold person-class score) — recordObservation is
            // simply not called for those ticks, so the existing streak is
            // read back unchanged via getConsecutiveCount instead.
            const isNoPersonStreakFrozen =
              quality !== "ok" || (person.noPersonDetected && person.bestPersonScore >= UNCERTAIN_PERSON_CONFIDENCE_LOWER_BOUND);
            const noPersonCount = isNoPersonStreakFrozen
              ? cooldown.getConsecutiveCount("noPerson")
              : cooldown.recordObservation("noPerson", person.noPersonDetected, now);
            const noPersonStreakDurationMs = cooldown.getStreakDurationMs("noPerson", now);
            const noPersonCooldownOk = cooldown.canEmit("NO_PERSON_VISIBLE", now, 45_000);
            // Camera integrity reliability pass — Task 6 hysteresis: the
            // mirror-image counter of noPersonCount, frozen the same way
            // on the same ticks (bad quality / uncertain), so a single
            // ambiguous frame during recovery neither advances nor resets
            // recovery progress any more than it does for confirming
            // absence in the first place.
            const visibleCount = isNoPersonStreakFrozen
              ? cooldown.getConsecutiveCount("personVisible")
              : cooldown.recordObservation("personVisible", !person.noPersonDetected, now);
            const cameraIntegrityState = suppressStartup
              ? "CAMERA_VISIBLE"
              : resolveCameraIntegrityState({
                  streamHealth: "ok", // stream health is decided earlier this tick (see the early-return above) — reaching here already implies "ok".
                  frameQuality: quality,
                  person,
                  noPersonConsecutiveCount: noPersonCount,
                  noPersonStreakDurationMs,
                  visibleConsecutiveCount: visibleCount,
                  wasSustainedNoPersonVisible: wasSustainedNoPersonVisibleRef.current,
                });
            const visibilityRestoredCooldownOk = cooldown.canEmit("CAMERA_VISIBILITY_RESTORED", now, 60_000);
            const restoredDecision = suppressStartup
              ? { shouldEmit: false }
              : decideVisibilityRestoredEmission(
                  wasSustainedNoPersonVisibleRef.current,
                  cameraIntegrityState === "CAMERA_VISIBILITY_RESTORED",
                  visibilityRestoredCooldownOk,
                );

            // Camera Startup Readiness v1 — counters above keep tracking
            // consecutive observations even during warm-up (so a signal
            // that's still true once warm-up ends can confirm quickly),
            // but the decisions themselves are forced to "nothing
            // detected" while suppressStartup is true — never emits an
            // event or shows the local overlay for a warm-up frame.
            secondPersonDecision = suppressStartup
              ? { conditionMet: false, shouldEmit: false, confidenceBand: null }
              : decideSecondPersonEmission(person, secondPersonCount, secondPersonCooldownOk);
            noPersonDecision = suppressStartup
              ? { conditionMet: false, shouldEmit: false, qualifier: null }
              : decideNoPersonEmission(person, quality, noPersonCount, noPersonStreakDurationMs, noPersonCooldownOk);

            // Task 6 hysteresis bookkeeping: latch on the tick a sustained
            // absence is first CONFIRMED (independent of the backend
            // cooldown, which must never suppress this internal state
            // tracking), clear once CAMERA_VISIBILITY_RESTORED has
            // actually been reported for it — reported below, alongside
            // NO_PERSON_VISIBLE.
            if (noPersonDecision.qualifier === "CONFIRMED") {
              wasSustainedNoPersonVisibleRef.current = true;
            }
            if (restoredDecision.shouldEmit) {
              cooldown.markEmitted("CAMERA_VISIBILITY_RESTORED", now);
              reportIntegrityEvent("CAMERA_VISIBILITY_RESTORED", { source: "on_device_camera_ai" });
              wasSustainedNoPersonVisibleRef.current = false;
            }

            // Strengthened phone detection (multi-scale + temporal
            // tracking) — see docs/phone-detection-calibration-v1.md.
            // Runs alongside (not instead of) the person/no-person/
            // frame-quality logic above/below. Full-frame phone-class
            // detections from the inference pass already run this tick
            // feed the tracker first; additional lower/edge crops run on
            // their own bounded, adaptive schedule so a small, angled or
            // edge-of-frame phone gets a second, zoomed-in look without
            // running every crop on every tick.
            const tracker = phoneTrackerRef.current;
            const tickIndex = phoneDetectionTickIndexRef.current;
            phoneDetectionTickIndexRef.current += 1;

            const runPhoneCropPass = async (
              box: NormalizedBox,
              videoEl: HTMLVideoElement,
              detectorInstance: CameraObjectDetector,
            ): Promise<DetectedObject[]> => {
              phoneCropInferenceTimestampsRef.current = prunedCropInferenceTimestamps(
                phoneCropInferenceTimestampsRef.current,
                now,
              );
              if (!withinCropInferenceBudget(phoneCropInferenceTimestampsRef.current, now)) return [];
              if (!phoneCropCanvasRef.current) phoneCropCanvasRef.current = document.createElement("canvas");
              const cropCanvas = phoneCropCanvasRef.current;
              const srcX = Math.round(box.x * videoEl.videoWidth);
              const srcY = Math.round(box.y * videoEl.videoHeight);
              const srcW = Math.max(1, Math.round(box.width * videoEl.videoWidth));
              const srcH = Math.max(1, Math.round(box.height * videoEl.videoHeight));
              cropCanvas.width = PHONE_CROP_INPUT_SIZE;
              cropCanvas.height = PHONE_CROP_INPUT_SIZE;
              const cropCtx = cropCanvas.getContext("2d");
              if (!cropCtx) return [];
              // Resizing the crop up to the model's normal input scale
              // (Part 4) — a small phone near the bottom/edge occupies far
              // more model pixels here than it would in the full,
              // uniformly-downscaled frame.
              cropCtx.drawImage(videoEl, srcX, srcY, srcW, srcH, 0, 0, PHONE_CROP_INPUT_SIZE, PHONE_CROP_INPUT_SIZE);
              phoneCropInferenceTimestampsRef.current.push(now);
              try {
                return await detectorInstance.detect(cropCanvas);
              } catch {
                return [];
              }
            };

            // Physical acceptance follow-up (phone-detection calibration) —
            // populated only by phoneObservationsFromDetections's optional
            // geometry-rejection sink; empty (and free) whenever calibration
            // logging isn't consumed below.
            const geometryRejectedPhoneCandidates: GeometryRejectedPhoneCandidate[] = [];

            let phoneObservations = phoneObservationsFromDetections(
              detections,
              video.videoWidth,
              video.videoHeight,
              "full_frame",
              undefined,
              geometryRejectedPhoneCandidates,
            );

            // Physical acceptance follow-up — phone-detection calibration
            // observability. Purely observational counters, read only by
            // the calibration summary below (attached to an event only
            // when isPhoneCalibrationEnabled() is true) — never consulted
            // by any scheduling, budget, or detection decision above.
            let cropInferenceCount = 0;
            let verificationInferenceCount = 0;

            if (!suppressStartup) {
              const schedule = computeCropSchedule(tickIndex);
              cropInferenceCount = schedule.cropsToRun.length;
              for (const regionName of schedule.cropsToRun) {
                const region = PHONE_CROP_REGIONS.find((r) => r.name === regionName);
                if (!region) continue;
                const cropDetections = await runPhoneCropPass(region.box, video, detector);
                if (cropDetections.length === 0) continue;
                const cropSource: PhoneDetectionSource =
                  regionName === "left_edge" || regionName === "right_edge" ? "edge_crop" : "lower_crop";
                phoneObservations = phoneObservations.concat(
                  phoneObservationsFromDetections(
                    cropDetections,
                    PHONE_CROP_INPUT_SIZE,
                    PHONE_CROP_INPUT_SIZE,
                    cropSource,
                    region.box,
                    geometryRejectedPhoneCandidates,
                  ),
                );
              }
            }

            const dedupedPhoneObservations = dedupeObservations(phoneObservations);
            const phoneTrackerResult = suppressStartup
              ? { tracks: tracker.getTracks(), newlyConfirmed: [] as ReturnType<typeof tracker.getTracks> }
              : tracker.update(dedupedPhoneObservations, now);

            // Second-stage verification (Part 10) — bounded to at most
            // MAX_VERIFICATION_ATTEMPTS_PER_TICK candidates per tick, only
            // for MODERATE candidates (a strong candidate already confirms
            // instantly; a weak one never confirms alone, so spending a
            // verification pass on it isn't worthwhile). Strengthens or
            // weakens the candidate's band — never an irreversible
            // decision from a single frame.
            if (!suppressStartup) {
              for (const track of phoneTrackerResult.tracks) {
                if (verificationInferenceCount >= MAX_VERIFICATION_ATTEMPTS_PER_TICK) break;
                if (!shouldRunSecondStageVerification(track.latestBand)) continue;
                verificationInferenceCount += 1;
                const verifyDetections = await runPhoneCropPass(
                  expandCandidateBoxForVerification(track.box),
                  video,
                  detector,
                );
                const verifyPhone = verifyDetections
                  .filter((d) => PHONE_CLASS_NAMES.has(d.className.toLowerCase().trim()))
                  .reduce<DetectedObject | null>((max, d) => (!max || d.score > max.score ? d : max), null);
                tracker.applyVerification(track.id, verifyPhone != null, verifyPhone?.score ?? 0);
                logAiCameraDebug("tick: phone second-stage verification", {
                  trackId: track.id,
                  outcome: verifyPhone ? "raised" : "lowered",
                  verificationScore: verifyPhone?.score ?? null,
                });
              }
            }

            // Physical acceptance follow-up — bounded, metadata-only
            // calibration log (see buildPhoneCalibrationCandidates's own
            // doc comment), positioned AFTER second-stage verification so
            // a candidate's rejectedReason can correctly reflect a
            // "verification" demotion, not just "confidence"/"tracking".
            // Gated behind the same sesAiCameraDebug opt-in flag as every
            // other on-device AI debug log — logAiCameraDebug itself
            // no-ops entirely outside that, so this is free in every other
            // build.
            logAiCameraDebug("tick: phone calibration candidates", {
              candidates: buildPhoneCalibrationCandidates({
                nowMs: now,
                inferenceMs,
                observations: phoneObservations,
                dedupedObservations: dedupedPhoneObservations,
                geometryRejected: geometryRejectedPhoneCandidates,
                tracks: phoneTrackerResult.tracks,
              }),
            });

            const bestConfirmedPhoneTrack = phoneTrackerResult.tracks
              .filter((t) => t.confirmedLocalWarning)
              .reduce<(typeof phoneTrackerResult.tracks)[number] | null>(
                (max, t) => (!max || t.latestScore > max.latestScore ? t : max),
                null,
              );

            phoneDecision =
              suppressStartup || !bestConfirmedPhoneTrack
                ? { conditionMet: false, shouldEmit: false, confidenceBand: null }
                : {
                    conditionMet: true,
                    shouldEmit: phoneCooldownOk,
                    confidenceBand: bestConfirmedPhoneTrack.latestBand === "strong" ? "high" : "medium",
                  };

            const debugPhoneTier = bestConfirmedPhoneTrack
              ? phoneEvidenceTier(bestConfirmedPhoneTrack, false, secureSettings?.captureAiViolationEvidence ?? false, true, true)
              : phoneTrackerResult.tracks.length > 0
                ? "OBSERVED_CANDIDATE"
                : null;

            logAiCameraDebug("tick: phone decision", {
              phoneDetected: phone.detected,
              phoneConfidence: phone.confidence,
              phoneThreshold,
              algorithmVersion: PHONE_DETECTION_ALGORITHM_VERSION,
              observationCount: dedupedPhoneObservations.length,
              activeTrackCount: phoneTrackerResult.tracks.length,
              bestTrackBand: bestConfirmedPhoneTrack?.latestBand ?? null,
              bestTrackScore: bestConfirmedPhoneTrack?.latestScore ?? null,
              bestTrackSource: bestConfirmedPhoneTrack?.latestSource ?? null,
              bestTrackEdgeContact: bestConfirmedPhoneTrack?.touchesEdge ?? null,
              evidenceTier: debugPhoneTier,
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

            if (phoneDecision.shouldEmit && bestConfirmedPhoneTrack) {
              cooldown.markEmitted("POSSIBLE_PHONE_VISIBLE", now);
              // Physical acceptance follow-up — phone-detection calibration
              // observability. Attached ONLY when isPhoneCalibrationEnabled()
              // is true (default: false, everywhere including production —
              // see that function's own doc comment) — piggybacks on THIS
              // already-firing request, never a new one. Every field is a
              // plain number/boolean/short enum string; see
              // buildPhoneCalibrationEventSummary's own doc comment for the
              // exact bounds and the deliberate "event-only, not per-tick"
              // limitation this implies.
              const calibrationEnabled = isPhoneCalibrationEnabled(process.env.NEXT_PUBLIC_TETHER_PHONE_CALIBRATION_ENABLED);
              const calibration = calibrationEnabled
                ? buildPhoneCalibrationEventSummary({
                    bestTrack: bestConfirmedPhoneTrack,
                    activeTrackCount: phoneTrackerResult.tracks.length,
                    shouldEmit: phoneDecision.shouldEmit,
                    primaryInferenceMs: inferenceMs,
                    cropInferenceCount,
                    verificationInferenceCount,
                    tickElapsedMsAtEmission: performance.now() - tickStartMs,
                    nextDelayMs: computeNextDetectionDelayMs(inferenceMs),
                  })
                : undefined;
              // Safe metadata only (Part 13) — no image/pixel data, ever.
              // Keys deliberately avoid the substring "frame" (see
              // FORBIDDEN_METADATA_KEY_PATTERN in cameraIntegrityDetection.ts
              // / the server-side check in the integrity-events route) —
              // "confirmingObservationCount"/"edgeContact", not
              // "confirmationFrameCount"/"touchesFrameEdge".
              reportIntegrityEvent("POSSIBLE_PHONE_VISIBLE", {
                source: "on_device_camera_ai",
                confidence: Math.round(bestConfirmedPhoneTrack.latestScore * 100) / 100,
                confidenceBand: phoneDecision.confidenceBand,
                modelName: detector.modelName,
                modelVersion: detector.modelVersion,
                detectionIntervalSeconds: currentDetectionDelayMs / 1000,
                algorithmVersion: PHONE_DETECTION_ALGORITHM_VERSION,
                confirmingObservationCount: bestConfirmedPhoneTrack.recentEligibleWindow.filter(Boolean).length,
                observationWindowLength: bestConfirmedPhoneTrack.recentEligibleWindow.length,
                detectionSource: bestConfirmedPhoneTrack.latestSource,
                edgeContact: bestConfirmedPhoneTrack.touchesEdge,
                ...(calibration ? { calibration } : {}),
                boundingBox: {
                  x: Math.round(bestConfirmedPhoneTrack.box.x * 1000) / 1000,
                  y: Math.round(bestConfirmedPhoneTrack.box.y * 1000) / 1000,
                  width: Math.round(bestConfirmedPhoneTrack.box.width * 1000) / 1000,
                  height: Math.round(bestConfirmedPhoneTrack.box.height * 1000) / 1000,
                },
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
        // Tether Secure Exam Recovery and Resilient Autosave v1 — routes
        // through the resilient queue (see flushAnswerNow's own comment
        // for the full rationale). Fire-and-forget here, exactly like the
        // raw fetch it replaces — this debounced path never blocks
        // typing.
        resilientAutosave
          .save(questionId, response)
          .then((acknowledged) => {
            if (!acknowledged && secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
            // Question Navigator v1 — Part 12: progress counts must
            // update after every answer save, not only after
            // navigation. Best-effort; never blocks/delays the save.
            else if (acknowledged && oneQuestionAtATime && secureSettings?.showQuestionNavigator) loadNavigator();
          })
          .catch(() => {
            if (secureModeEnabled) reportIntegrityEvent("AUTOSAVE_FAILED");
          });
      }, 600);
    },
    [secureModeEnabled, reportIntegrityEvent, oneQuestionAtATime, secureSettings?.showQuestionNavigator, loadNavigator, resilientAutosave.save],
  );

  function handleChange(questionId: string, value: string) {
    if (submitting || autoSubmitLocked || timerStopped) return;
    setResponses((prev) => ({ ...prev, [questionId]: value }));
    saveAnswer(questionId, value);
    // Answer-Development Provenance v1 — tracks the latest text and
    // triggers an immediate checkpoint only for a large single-step
    // insertion (paste-like); otherwise the periodic timer in the hook
    // covers it. No-ops entirely when provenance is OFF.
    answerDevelopmentCapture.notifyTextChange(questionId, value);
  }

  // Secure-recovery hardening v1, Part B — takes priority over every
  // other render branch below, including stale `data` from before this
  // was set (e.g. a mid-session recovery-status poll discovering the
  // device mismatch after the exam content had already loaded): exam
  // content must stay blocked, and the generic TETHER_SESSION_REQUIRED
  // redirect loop must never re-enter from here either.
  if (manualReviewRequired) {
    return <ManualReviewNotice pendingCount={resilientAutosave.pendingCount} />;
  }

  // v1.7.5 P0 / release-blocking follow-up review — checked BEFORE the
  // `!data` checks below, on purpose: for a gated attempt whose native
  // lockdown is not yet confirmed, `data` may legitimately stay null
  // indefinitely (loadSubmission() is never called at all — see the
  // pre-fetch gate effect above) — falling through to the generic
  // "Loading..." `!data` branch would still be harmless, but would mask
  // the specific, actionable STATUS_UNAVAILABLE/UNSUPPORTED_BUILD
  // messages below. See src/lib/secureExamNativeLockdown.ts. Question
  // content is never even FETCHED, let alone rendered, for a gated
  // attempt until native lockdown is confirmed ACTIVE+READY and
  // policy-compatible in THIS Electron process — a plain in-page
  // message, never a native overlay, covers every non-confirmed state.
  if (shouldBlockExamContentRendering(inLockdownBrowser, contentGateState)) {
    if (contentGateState === "UNSUPPORTED_BUILD") {
      return (
        <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
          <h1 className="text-lg font-medium">Update required</h1>
          <p className="mt-3 text-sm text-gray-700">
            This version of Tether Secure Browser does not support a required security verification step. Please update Tether Secure Browser to
            continue.
          </p>
        </div>
      );
    }
    if (contentGateState === "STATUS_UNAVAILABLE") {
      return (
        <div className="mx-auto mt-16 max-w-md rounded border border-gray-200 p-6 text-center">
          <h1 className="text-lg font-medium">Tether could not verify this examination&apos;s secure policy</h1>
          <p className="mt-3 text-sm text-gray-700">Select Try again to retry.</p>
          <button onClick={() => window.location.reload()} className="mt-4 rounded bg-black px-4 py-2 text-sm text-white">
            Try again
          </button>
        </div>
      );
    }
    // PENDING (still determining) or REACTIVATION_REQUIRED (a redirect to
    // tether-launch is already in flight, issued by the effect above) —
    // both are brief, ordinary loading states; no overlay, no content,
    // and (for REACTIVATION_REQUIRED) no question-bearing request was
    // ever made in the first place.
    return <p className="text-gray-500">Loading...</p>;
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
            {requireScreenShare && (
              <li>This exam requires sharing your entire screen. Audio is not captured.</li>
            )}
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

          {/* Screen-share Evidence Mode v1 — see
              docs/screen-share-evidence-v1.md. Explains what is
              collected BEFORE requesting permission, and requires an
              explicit student action (a real button click, so
              getDisplayMedia() is always called from a user gesture) —
              never called automatically. */}
          {requireScreenShare && (
            <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3">
              <p className="text-sm font-medium">This exam requires sharing your entire screen.</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-700">
                <li>You must choose to share your ENTIRE screen, not a window or browser tab.</li>
                <li>Audio is not captured.</li>
                <li>Continuous screen video is never recorded or uploaded.</li>
                {secureSettings?.screenShareCaptureEvidence ? (
                  <li>
                    Occasional low-resolution evidence frames and sharing lifecycle events (started,
                    stopped, restored) may be stored for lecturer review.
                  </li>
                ) : (
                  <li>Sharing lifecycle events (started, stopped, restored) may be recorded for lecturer review.</li>
                )}
                <li>These are review signals, not automatic misconduct findings.</li>
              </ul>

              {screenShare.state !== "ACTIVE" && (
                <>
                  <button
                    onClick={screenShare.start}
                    className="mt-3 rounded border border-gray-300 bg-white px-3 py-1.5 text-sm"
                  >
                    {screenShare.state === "REQUESTING" ? "Starting…" : "Share entire screen"}
                  </button>
                  {screenShare.errorMessage && (
                    <p className="mt-2 text-sm text-red-600">{screenShare.errorMessage}</p>
                  )}
                </>
              )}

              <video
                ref={screenShare.videoRef}
                autoPlay
                muted
                playsInline
                className={screenShare.state === "ACTIVE" ? "mt-2 w-48 rounded border border-gray-300" : "sr-only"}
              />
              {screenShare.state === "ACTIVE" && (
                <p className="mt-1 text-xs text-gray-500">
                  Your screen-share preview — only you can see this
                </p>
              )}
              {screenShare.state === "ACTIVE" && screenShare.surfaceUnverifiable && (
                <p className="mt-2 text-xs text-amber-700">
                  Your browser cannot confirm which screen/window was shared. Please double-check
                  you selected your entire screen.
                </p>
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
            disabled={!cameraGateSatisfied || !screenShareGateSatisfied}
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
          {/* Screen-share Evidence Mode v1 — compact status only, never a
              large distracting panel (see docs/screen-share-evidence-v1.md).
              Colour is never the only signal — the text itself always
              states the status. */}
          {requireScreenShare && (
            <span
              className={
                screenShare.state === "ACTIVE"
                  ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-700"
                  : screenShare.state === "INTERRUPTED"
                    ? "rounded bg-red-100 px-2 py-0.5 text-xs text-red-700"
                    : "rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700"
              }
            >
              {screenShare.state === "ACTIVE"
                ? "Screen sharing active"
                : screenShare.state === "INTERRUPTED"
                  ? "Screen sharing stopped"
                  : "Screen sharing needs attention"}
            </span>
          )}
          <a href="/privacy/student-exam-notice" target="_blank" rel="noreferrer" className="text-xs underline">
            What does this record?
          </a>
        </div>
      )}

      {/* Screen-share Evidence Mode v1 — calm blocking recovery overlay.
          Shown only while sharing is required AND actually interrupted;
          never auto-submits, never auto-accuses, and always preserves
          autosaved answers (nothing here touches responses/timers other
          than the existing, unrelated timer behaviour already in
          effect). See docs/screen-share-evidence-v1.md. */}
      {requireScreenShare && (screenShare.state === "INTERRUPTED" || screenShare.state === "REQUESTING") && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="screen-share-overlay-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="max-w-md rounded bg-white p-5 shadow-lg">
            <h2 id="screen-share-overlay-title" className="text-lg font-semibold">
              Screen sharing has stopped
            </h2>
            <p className="mt-2 text-sm text-gray-700">
              This exam requires sharing your entire screen. Sharing stopped — this has been
              recorded as a review signal, not an automatic misconduct finding. Please resume
              screen sharing to continue.
            </p>
            <p className="mt-2 text-sm text-gray-700">
              Your answers are saved automatically and have not been lost. The exam has not been
              submitted, and the timer continues to run as normal.
            </p>
            <button
              onClick={screenShare.resume}
              className="mt-4 rounded bg-black px-4 py-2 text-sm text-white"
            >
              {screenShare.state === "REQUESTING" ? "Starting…" : "Resume screen sharing"}
            </button>
            {screenShare.errorMessage && (
              <p className="mt-2 text-sm text-red-600">{screenShare.errorMessage}</p>
            )}
            <p className="mt-3 text-xs text-gray-500">
              If you cannot resume screen sharing, contact your institution&apos;s exam support for
              guidance — your progress is not at risk while you do.
            </p>
          </div>
        </div>
      )}

      {banner && (
        <div className="mt-3 rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          {banner}
        </div>
      )}

      {/* Tether Secure Exam Recovery and Resilient Autosave v1 — see
          docs/tether-secure-resume-recovery-v1.md, Part 4/16. Exam
          workspace stability pass — RecoveryStatusBanner now renders
          EITHER a screen-reader-only region (ordinary save activity,
          never visible) OR a `position: fixed` overlay (exceptional
          states only) — see its own doc comment. Neither ever occupies
          normal document flow, so no wrapper margin/spacing is needed
          here, and nothing about this call site can reintroduce the
          question/MCQ-row movement bug: do not wrap this in a div that
          participates in layout, and do not gate rendering on
          pendingCount/connectionStatus — the component itself decides
          silent-vs-visible now. */}
      {submissionStatus === "IN_PROGRESS" && (
        <RecoveryStatusBanner
          connectionStatus={resilientAutosave.status}
          pendingCount={resilientAutosave.pendingCount}
          offline={offlineNow}
          recoveryMessage={recoveryStatusMessage}
          onRetryNow={() => {
            if (recoveryRedirectTo) {
              router.push(recoveryRedirectTo);
              return;
            }
            void resilientAutosave.flushNow();
            void refreshRecoveryStatus();
          }}
        />
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
            non-interactive while an AI camera violation overlay OR the
            v1.7.6 Native Display State Bridge's display-violation modal
            is active; each modal is a sibling (not a descendant) of this
            wrapper, so it stays sharp and clickable. See
            src/lib/aiCameraViolationOverlay.ts and
            src/lib/displayViolationOverlay.ts. */}
        <div
          className={aiCameraViolationOverlay || displayViolationModal ? "pointer-events-none select-none blur-sm" : undefined}
          aria-hidden={aiCameraViolationOverlay || displayViolationModal ? true : undefined}
        >
          {oneQuestionAtATime ? (
            // One-Question-At-A-Time Exam Delivery v1 — see
            // docs/one-question-delivery-v1.md. Renders only
            // oneQuestion.payload.question (from GET/POST
            // .../question(-progress)) — data.exam.questions is empty in
            // this mode, the server never sends the full paper.
            // Exam workspace stability pass — desktop two-column layout:
            // navigator LEFT (stable, bounded width), active question
            // RIGHT (flexible width). Below `lg:` this stays exactly the
            // existing single stacked column (navigator above question,
            // using its own open/close toggle) — grid-only classes never
            // apply there, so mobile/tablet behaviour is unchanged.
            // `lg:items-start` is required: without it, CSS grid stretches
            // both columns to match the taller one's height, which would
            // make the navigator (or the question card) grow/shrink with
            // its sibling — exactly the instability this pass removes.
            <div className="mt-6 lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-6">
              {/* Question Navigator v1 — see docs/question-navigator-v1.md.
                  An aria-live region so screen-reader users hear
                  confirmation after a successful navigation or
                  flag/unflag, without needing to find focus themselves. */}
              <div aria-live="polite" className="sr-only">
                {navigatorAnnouncement}
              </div>
              {secureSettings?.showQuestionNavigator && questionNav && (
                // Sticky only at lg: and above — keeps the navigator
                // reachable while a long essay question scrolls, without
                // introducing a second competing scroll container
                // (`position: sticky` scrolls with the page itself, it
                // does not create its own scrollable region).
                <div className="mb-4 lg:sticky lg:top-4 lg:mb-0">
                  <QuestionNavigatorPanel
                    navigator={questionNav}
                    open={navigatorPanelOpen}
                    onToggleOpen={() => setNavigatorPanelOpen((v) => !v)}
                    disabled={submitting || autoSubmitLocked || timerStopped || navigatingQuestion}
                    onSelectQuestion={navigateQuestionDirect}
                  />
                </div>
              )}
              {/* min-w-0 is required on a grid item that must be allowed
                  to shrink below its content's natural width — without
                  it, a long unbroken question/answer string can force
                  this column (and therefore the whole grid) wider than
                  the viewport instead of wrapping. */}
              <div className="min-w-0">
              {oneQuestion.loading && <p className="text-gray-500">Loading question...</p>}
              {!oneQuestion.loading && oneQuestion.payload && (
                // Exam layout stability follow-up — a floor, not a ceiling:
                // short-answer/MCQ questions are otherwise much shorter than
                // an essay question's 5-row textarea, and this card sits in
                // a single stacked column (navigator above, Previous/Next
                // below), so that natural per-question height difference
                // visibly pushed everything below it up/down on every
                // Next/Previous. min-h only raises the floor for shorter
                // content — genuinely long question text/options still grow
                // past it exactly as before.
                <div className="min-h-[280px] rounded border border-gray-200 p-4">
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

                  {secureSettings?.aiAssistanceMode === "BRAINSTORM_ONLY" && (
                    <AiBrainstormPanel
                      submissionId={id}
                      questionId={oneQuestion.payload.question.id}
                      currentResponseText={responses[oneQuestion.payload.question.id] ?? null}
                    />
                  )}

                  {answerProvenanceMode !== "OFF" && (
                    <AnswerDevelopmentPanel
                      submissionId={id}
                      questionId={oneQuestion.payload.question.id}
                      mode={answerProvenanceMode}
                      enableOutlineWorkspace={secureSettings?.enableOutlineWorkspace ?? false}
                      enableCalculationWorkspace={secureSettings?.enableCalculationWorkspace ?? false}
                      enableCodeWorkspace={secureSettings?.enableCodeWorkspace ?? false}
                      requireAiSourceDeclaration={secureSettings?.requireAiSourceDeclaration ?? false}
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

                  {secureSettings?.aiAssistanceMode === "BRAINSTORM_ONLY" && (
                    <AiBrainstormPanel
                      submissionId={id}
                      questionId={q.id}
                      currentResponseText={responses[q.id] ?? null}
                    />
                  )}

                  {answerProvenanceMode !== "OFF" && (
                    <AnswerDevelopmentPanel
                      submissionId={id}
                      questionId={q.id}
                      mode={answerProvenanceMode}
                      enableOutlineWorkspace={secureSettings?.enableOutlineWorkspace ?? false}
                      enableCalculationWorkspace={secureSettings?.enableCalculationWorkspace ?? false}
                      enableCodeWorkspace={secureSettings?.enableCodeWorkspace ?? false}
                      requireAiSourceDeclaration={secureSettings?.requireAiSourceDeclaration ?? false}
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

        {/* Native Display State Bridge (v1.7.6) — see
            src/lib/displayViolationOverlay.ts. Deliberately no dismiss/
            continue button: unlike the AI camera overlay above, this
            reflects a native, verifiable fact (not a probabilistic
            on-device inference), so it is never locally dismissible while
            native state remains BLOCKED — it clears itself automatically,
            with no reload/restart/timer-reset/answer loss, the instant
            window.sesLockdown reports state:"OK" again. */}
        {displayViolationModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="display-violation-heading"
          >
            <div className="w-full max-w-sm rounded border border-gray-300 bg-white p-5 shadow-lg">
              <p id="display-violation-heading" className="text-base font-semibold">
                {displayViolationModal.title}
              </p>
              <p className="mt-2 text-sm text-gray-700">{displayViolationModal.message}</p>
              <p className="mt-2 text-sm text-gray-600">{displayViolationModal.note}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
