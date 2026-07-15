/**
 * On-Device AI Camera Integrity Detection v1 — Evidence Frames. See
 * docs/on-device-ai-integrity-detection-v1.md.
 *
 * Pure, dependency-free helpers: which event types may ever get an
 * evidence frame, whether a specific event/settings combination should
 * trigger a capture, storage-key generation (opaque — never contains a
 * student's name or email), and upload validation. No DOM, no Prisma, no
 * network — everything here is unit-testable without a browser, camera,
 * or database.
 *
 * v1 captures evidence for exactly two signals — the two an institution
 * is most likely to need a human-reviewable frame for: a possible phone
 * and a possible second person. NO_PERSON_VISIBLE, CAMERA_VIEW_BLOCKED,
 * CAMERA_TOO_DARK, and AI_CAMERA_CHECK_UNAVAILABLE are deliberately
 * excluded in v1 — capturing evidence for "no person"/"blocked"/"dark"
 * would either capture nothing useful or capture more broadly than the
 * urgent cases actually need. A future version could add these
 * deliberately, not by accident.
 */

export const EVIDENCE_CAPTURE_EVENT_TYPES = [
  "POSSIBLE_PHONE_VISIBLE",
  "POSSIBLE_SECOND_PERSON_VISIBLE",
] as const;

export type EvidenceCaptureEventType = (typeof EVIDENCE_CAPTURE_EVENT_TYPES)[number];

/** True only for the two event types evidence frames may ever be captured for in v1. */
export function isEvidenceCaptureEligibleEventType(eventType: string): eventType is EvidenceCaptureEventType {
  return (EVIDENCE_CAPTURE_EVENT_TYPES as readonly string[]).includes(eventType);
}

export type EvidenceCaptureSettings = {
  /** Master on/off for AI camera checks at all — evidence capture has no effect if this is off. */
  enableAiCameraIntegrityChecks: boolean;
  /** Per docs/on-device-ai-integrity-detection-v1.md — off by default; must be explicitly enabled by the lecturer/institution. */
  captureAiViolationEvidence: boolean;
};

/**
 * Whether an evidence frame should be captured for this event, given the
 * exam's secureSettings. Requires ALL of:
 *  - the event type is eligible (phone/second-person only, v1);
 *  - AI camera checks are enabled at all;
 *  - evidence capture is explicitly enabled (defaults to false — privacy
 *    by design, never silently on for an existing exam).
 */
export function shouldCaptureEvidenceFrame(
  eventType: string,
  settings: EvidenceCaptureSettings,
): boolean {
  if (!isEvidenceCaptureEligibleEventType(eventType)) return false;
  if (!settings.enableAiCameraIntegrityChecks) return false;
  return settings.captureAiViolationEvidence === true;
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Content types the upload endpoint accepts. Deliberately excludes SVG, HTML, and any non-raster-image type. */
export const ALLOWED_EVIDENCE_FRAME_CONTENT_TYPES = Object.keys(CONTENT_TYPE_EXTENSIONS);

/** Hard upload size ceiling — comfortably above a well-compressed 640x360 JPEG/WebP, well below anything resembling a full-res photo or multi-frame payload. */
export const MAX_EVIDENCE_FRAME_BYTES = 300 * 1024;

export type EvidenceFrameKeyParams = {
  examId: string;
  submissionId: string;
  integrityEventId: string;
  contentType: string;
};

/**
 * Builds an opaque storage key from IDs the system already generates
 * (cuids) — never from anything identity-revealing like the student's
 * name or email. Namespaced by exam/submission only so a reviewer
 * inspecting the storage layout directly (e.g. an ops engineer debugging
 * the storage bucket) cannot infer who a frame belongs to without
 * cross-referencing the database. `randomSuffix` is caller-supplied
 * (e.g. `randomStorageSuffix()` from evidenceStorage.ts) so this stays a
 * pure function — the same inputs always produce the same key.
 */
export function generateEvidenceFrameStorageKey(params: EvidenceFrameKeyParams, randomSuffix: string): string {
  const ext = CONTENT_TYPE_EXTENSIONS[params.contentType] ?? "bin";
  return `ai-camera-evidence/${params.examId}/${params.submissionId}/${params.integrityEventId}-${randomSuffix}.${ext}`;
}

export type EvidenceFrameUploadValidationResult = { ok: true } | { ok: false; error: string };

export type EvidenceFrameUploadCandidate = {
  contentType: string;
  byteSize: number;
};

/**
 * Validates an uploaded evidence frame BEFORE it is ever written to
 * storage: content type must be an allowed raster image type (never SVG,
 * HTML, or anything executable), and size must be within
 * MAX_EVIDENCE_FRAME_BYTES. Pure — does not inspect file bytes/magic
 * numbers (the caller is expected to have already re-encoded the image
 * via canvas, which this validates the OUTPUT of).
 */
export function validateEvidenceFrameUpload(
  candidate: EvidenceFrameUploadCandidate,
): EvidenceFrameUploadValidationResult {
  if (!ALLOWED_EVIDENCE_FRAME_CONTENT_TYPES.includes(candidate.contentType)) {
    return {
      ok: false,
      error: `Unsupported content type "${candidate.contentType}" — only image/jpeg or image/webp are accepted`,
    };
  }
  if (candidate.byteSize <= 0) {
    return { ok: false, error: "Empty file" };
  }
  if (candidate.byteSize > MAX_EVIDENCE_FRAME_BYTES) {
    return {
      ok: false,
      error: `File exceeds the ${MAX_EVIDENCE_FRAME_BYTES} byte limit for an evidence frame`,
    };
  }
  return { ok: true };
}

export const EVIDENCE_FRAME_KIND = "AI_CAMERA_EVIDENCE_FRAME";
export const EVIDENCE_FRAME_REDACTION_MODE = "LOW_RES_FULL_FRAME";

/**
 * Neutral, non-accusatory wording for the lecturer/marker review UI —
 * never "cheating," "misconduct," "proof," or "caught." Mirrors the
 * convention already enforced in integrityEventLabels.ts and
 * aiCameraViolationOverlay.ts.
 */
export const EVIDENCE_FRAME_PRIVACY_NOTE =
  "This is a single, low-resolution camera evidence frame captured automatically when this signal " +
  "was detected. It is a review signal, not proof of misconduct — no video was recorded.";
