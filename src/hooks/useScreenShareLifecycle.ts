"use client";

/**
 * Screen-share Evidence Mode v1 — client lifecycle controller. See
 * docs/screen-share-evidence-v1.md.
 *
 * A dedicated hook rather than logic embedded in the exam page, per the
 * task's explicit requirement. Owns: the MediaStream/track lifecycle,
 * getDisplayMedia() gesture handling, display-surface validation,
 * periodic + restoration-triggered evidence capture, and reporting
 * lifecycle events to the existing generic integrity-events route. All
 * state-machine DECISIONS are delegated to the pure
 * src/lib/screenShareLifecycle.ts module — this hook is the thin,
 * DOM-touching adapter over real browser events.
 *
 * Hard rules this hook enforces:
 * - getDisplayMedia() is only ever called from start()/resume(), which
 *   the caller must only invoke from a real user gesture (a button
 *   onClick) — browsers enforce this natively; this hook never calls it
 *   automatically on mount, on a timer, or in response to any
 *   non-gesture event.
 * - Video only — { video: true, audio: false }. Never requests system or
 *   microphone audio.
 * - No continuous frame upload — only discrete, downscaled evidence
 *   stills, at most every `policy.evidenceIntervalSeconds`, capped at
 *   `policy.maxEvidenceFrames` (the server independently re-enforces
 *   both — see POST /api/submissions/[id]/screen-evidence).
 * - All tracks are stopped on unmount, on stop(), and whenever `enabled`
 *   flips to false (submission finalized / attempt invalid / user
 *   changed) — never left running past the exam.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  nextScreenShareLifecycleState,
  shouldEmitLifecycleEvent,
  integrityEventTypeForState,
  isRestorationTransition,
  classifyGetDisplayMediaError,
  evaluateDisplaySurface,
  isScreenShareApiSupported,
  type ScreenShareLifecycleState,
  type DisplaySurfaceCheckResult,
} from "@/lib/screenShareLifecycle";
import { isEvidenceCaptureDue, type ScreenSharePolicy } from "@/lib/screenSharePolicy";
import { buildScreenEvidenceUploadPath } from "@/lib/screenShareEvidence";

export type UseScreenShareLifecycleParams = {
  submissionId: string;
  policy: Pick<ScreenSharePolicy, "mode" | "captureEvidence" | "evidenceIntervalSeconds" | "maxEvidenceFrames">;
  /** Only actively monitors/captures while true (e.g. gate acknowledged AND attempt IN_PROGRESS) — flipping to false stops all tracks. */
  enabled: boolean;
};

export type UseScreenShareLifecycleResult = {
  state: ScreenShareLifecycleState;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  errorMessage: string | null;
  /** True once a share was accepted despite the browser not exposing displaySurface at all — a known limitation notice should be shown, never silently treated as confirmed-monitor. */
  surfaceUnverifiable: boolean;
  evidenceFramesCaptured: number;
  evidenceCaptureError: string | null;
  start: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => void;
};

const EVIDENCE_CAPTURE_MAX_WIDTH = 960;

export function useScreenShareLifecycle(params: UseScreenShareLifecycleParams): UseScreenShareLifecycleResult {
  const { submissionId, policy, enabled } = params;

  const [state, setState] = useState<ScreenShareLifecycleState>("IDLE");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [surfaceUnverifiable, setSurfaceUnverifiable] = useState(false);
  const [evidenceFramesCaptured, setEvidenceFramesCaptured] = useState(0);
  const [evidenceCaptureError, setEvidenceCaptureError] = useState<string | null>(null);

  const stateRef = useRef<ScreenShareLifecycleState>("IDLE");
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const evidenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastCapturedAtRef = useRef<number | null>(null);
  const framesCapturedRef = useRef(0);
  const generationRef = useRef(0);

  const reportEvent = useCallback(
    (eventType: string, severity: "INFO" | "LOW" | "MEDIUM" | "HIGH", message: string) => {
      fetch(`/api/submissions/${submissionId}/integrity-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType, severity, message, occurredAt: new Date().toISOString() }),
      }).catch(() => {
        // Best-effort — a failed lifecycle-event report never blocks the student.
      });
    },
    [submissionId],
  );

  const transition = useCallback(
    (action: Parameters<typeof nextScreenShareLifecycleState>[1]) => {
      const previous = stateRef.current;
      const next = nextScreenShareLifecycleState(previous, action);
      stateRef.current = next;
      setState(next);

      if (!shouldEmitLifecycleEvent(previous, next)) return;

      if (isRestorationTransition(previous, next)) {
        reportEvent("SCREEN_SHARE_RESTORED", "INFO", "Screen sharing was restored.");
        return;
      }
      const eventType = integrityEventTypeForState(next);
      if (!eventType) return;
      const severity =
        eventType === "SCREEN_SHARE_STARTED"
          ? "INFO"
          : eventType === "SCREEN_SHARE_INTERRUPTED"
            ? "MEDIUM"
            : "LOW";
      const message =
        eventType === "SCREEN_SHARE_STARTED"
          ? "Screen sharing started (entire display)."
          : eventType === "SCREEN_SHARE_INTERRUPTED"
            ? "Screen sharing was interrupted — needs review."
            : eventType === "SCREEN_SHARE_PERMISSION_DENIED"
              ? "Screen-share permission was denied."
              : eventType === "SCREEN_SHARE_SURFACE_REJECTED"
                ? "A non-monitor screen-share surface was selected and rejected."
                : "Screen sharing is unavailable in this browser/session.";
      reportEvent(eventType, severity, message);
    },
    [reportEvent],
  );

  const stopAllTracks = useCallback((markStopped: boolean) => {
    if (evidenceTimerRef.current) {
      clearInterval(evidenceTimerRef.current);
      evidenceTimerRef.current = null;
    }
    if (trackRef.current) {
      trackRef.current.onended = null;
      trackRef.current.onmute = null;
      trackRef.current.onunmute = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    trackRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (markStopped) transition({ type: "STOPPED_CLEANLY" });
  }, [transition]);

  const stop = useCallback(() => {
    generationRef.current += 1; // invalidate any in-flight async work
    stopAllTracks(true);
  }, [stopAllTracks]);

  const captureEvidenceFrame = useCallback(
    async (trigger: "PERIODIC" | "RESTORATION") => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;
      if (!policy.captureEvidence) return;
      if (framesCapturedRef.current >= policy.maxEvidenceFrames) return;
      if (!isEvidenceCaptureDue(lastCapturedAtRef.current, Date.now(), policy)) return;

      const generation = generationRef.current;
      if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
      const canvas = canvasRef.current;
      const scale = Math.min(1, EVIDENCE_CAPTURE_MAX_WIDTH / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      lastCapturedAtRef.current = Date.now();

      try {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.6));
        if (!blob) throw new Error("blob encode failed");
        if (generation !== generationRef.current) return; // stream changed/stopped mid-capture

        const formData = new FormData();
        formData.append("file", blob, "evidence.jpg");
        formData.append("clientRequestId", crypto.randomUUID());
        formData.append("trigger", trigger);

        const res = await fetch(buildScreenEvidenceUploadPath(submissionId), { method: "POST", body: formData });
        if (generation !== generationRef.current) return;
        if (res.ok) {
          framesCapturedRef.current += 1;
          setEvidenceFramesCaptured(framesCapturedRef.current);
          setEvidenceCaptureError(null);
        } else if (res.status !== 409) {
          // 409 (max reached / too soon) is expected steady-state, not a
          // failure worth surfacing — anything else is.
          setEvidenceCaptureError("A screen evidence frame could not be saved.");
          reportEvent("SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED", "INFO", "A screen evidence frame upload failed.");
        }
      } catch {
        if (generation !== generationRef.current) return;
        setEvidenceCaptureError("A screen evidence frame could not be captured.");
        reportEvent("SCREEN_SHARE_EVIDENCE_CAPTURE_FAILED", "INFO", "A screen evidence frame capture failed.");
      }
    },
    [policy, submissionId, reportEvent],
  );

  const attachStream = useCallback(
    (stream: MediaStream) => {
      const generation = ++generationRef.current;
      streamRef.current = stream;
      const [track] = stream.getVideoTracks();
      trackRef.current = track ?? null;
      if (videoRef.current) videoRef.current.srcObject = stream;

      const settings = track?.getSettings?.() ?? {};
      const displaySurface = (settings as { displaySurface?: string }).displaySurface;
      const surfaceResult: DisplaySurfaceCheckResult = evaluateDisplaySurface(displaySurface, policy.mode);
      setSurfaceUnverifiable(surfaceResult === "UNVERIFIABLE_ACCEPTED" && displaySurface === undefined);

      if (surfaceResult === "NOT_MONITOR_REJECTED") {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        trackRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setErrorMessage(
          "The selected share was not your entire screen. Please share your ENTIRE screen, not a window or browser tab.",
        );
        transition({ type: "STREAM_ACQUIRED", surfaceResult });
        return;
      }

      setErrorMessage(null);
      transition({ type: "STREAM_ACQUIRED", surfaceResult });

      if (track) {
        track.onended = () => {
          if (generation !== generationRef.current) return;
          transition({ type: "TRACK_ENDED" });
        };
        track.onmute = () => {
          if (generation !== generationRef.current) return;
          transition({ type: "TRACK_MUTED" });
        };
        track.onunmute = () => {
          if (generation !== generationRef.current) return;
          transition({ type: "TRACK_UNMUTED" });
          // An unmute alone doesn't restore (see screenShareLifecycle.ts)
          // — but if the track is genuinely live again, treat it as
          // restoration. `readyState === "live"` is the authoritative
          // signal here, not the mute event itself.
          if (track.readyState === "live" && stateRef.current === "INTERRUPTED") {
            transition({ type: "RESTORED" });
            void captureEvidenceFrame("RESTORATION");
          }
        };
      }

      if (policy.captureEvidence) {
        if (evidenceTimerRef.current) clearInterval(evidenceTimerRef.current);
        evidenceTimerRef.current = setInterval(() => {
          if (stateRef.current === "ACTIVE") void captureEvidenceFrame("PERIODIC");
        }, Math.min(policy.evidenceIntervalSeconds * 1000, 5_000) /* poll frequently; isEvidenceCaptureDue enforces the real interval */);
      }
    },
    [policy, transition, captureEvidenceFrame],
  );

  const requestShare = useCallback(async () => {
    setErrorMessage(null);
    if (!isScreenShareApiSupported(typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia))) {
      transition({ type: "API_UNSUPPORTED" });
      setErrorMessage("Screen sharing is not supported in this browser.");
      return;
    }
    transition({ type: "START_REQUESTED" });
    try {
      // Video only — never system/microphone audio.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      attachStream(stream);
    } catch (err) {
      const reason = classifyGetDisplayMediaError((err as DOMException)?.name);
      transition({ type: "REQUEST_FAILED", reason });
      setErrorMessage(
        reason === "PERMISSION_DENIED"
          ? "Screen-share permission was not granted. Please allow screen sharing to continue."
          : "Screen sharing could not be started. Please try again.",
      );
    }
  }, [transition, attachStream]);

  // Public start()/resume() are the same underlying action — both must
  // only ever be invoked from a real user gesture (a button onClick);
  // this hook never calls getDisplayMedia() on its own.
  const start = requestShare;
  const resume = requestShare;

  // Stop all tracks whenever monitoring is disabled (submission
  // finalized, attempt invalid/expired, authenticated user changed) —
  // never leaves capture active past the exam.
  useEffect(() => {
    if (!enabled) stopAllTracks(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      if (evidenceTimerRef.current) clearInterval(evidenceTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return {
    state,
    videoRef,
    errorMessage,
    surfaceUnverifiable,
    evidenceFramesCaptured,
    evidenceCaptureError,
    start,
    resume,
    stop,
  };
}
