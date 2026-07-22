/**
 * Screen-share Evidence Mode v1 — evidence-frame helpers. See
 * docs/screen-share-evidence-v1.md.
 *
 * Pure, dependency-free helpers mirroring src/lib/aiCameraEvidenceFrame.ts's
 * conventions closely (storage-key generation, upload validation, source
 * labelling) — kept as a SEPARATE module rather than extending that one,
 * so screen-share evidence can never accidentally regress camera
 * evidence behaviour by sharing code paths; both ultimately write to the
 * same IntegrityEvidenceAsset table and the same
 * src/lib/evidenceStorage.ts adapter, distinguished by `kind`.
 */

/** The IntegrityEvidenceAsset.kind value for every screen-share evidence frame — distinguishes it from "AI_CAMERA_EVIDENCE_FRAME" (see aiCameraEvidenceFrame.ts) on the same shared table. */
export const SCREEN_SHARE_EVIDENCE_KIND = "SCREEN_SHARE_EVIDENCE_FRAME";
export const SCREEN_SHARE_EVIDENCE_REDACTION_MODE = "DOWNSCALED_FULL_FRAME";

/** The only IntegrityEventType a screen-share evidence asset is ever attached to — created by the upload route itself, not pre-existing (unlike camera evidence, which attaches to an already-logged detection event). */
export const SCREEN_SHARE_EVIDENCE_EVENT_TYPE = "SCREEN_SHARE_EVIDENCE_CAPTURED";

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Content types the upload endpoint accepts. Deliberately excludes SVG, HTML, and any non-raster-image type. */
export const ALLOWED_SCREEN_EVIDENCE_CONTENT_TYPES = Object.keys(CONTENT_TYPE_EXTENSIONS);

/**
 * Hard upload size ceiling. Somewhat higher than the camera evidence
 * frame's 300KB (src/lib/aiCameraEvidenceFrame.ts) — a downscaled screen
 * capture typically needs more pixels to stay legible for review than a
 * downscaled webcam frame does — but still comfortably bounded, well
 * below anything resembling a full-resolution, uncompressed screenshot.
 */
export const MAX_SCREEN_EVIDENCE_BYTES = 500 * 1024;

export type ScreenEvidenceUploadValidationResult = { ok: true } | { ok: false; error: string };

export type ScreenEvidenceUploadCandidate = {
  contentType: string;
  byteSize: number;
};

/**
 * Validates an uploaded screen evidence frame BEFORE it is ever written
 * to storage: content type must be an allowed raster image type, and
 * size must be within MAX_SCREEN_EVIDENCE_BYTES. Pure — does not inspect
 * file bytes/magic numbers (the caller is expected to have already
 * re-encoded the image via canvas, which this validates the OUTPUT of).
 */
export function validateScreenEvidenceUpload(
  candidate: ScreenEvidenceUploadCandidate,
): ScreenEvidenceUploadValidationResult {
  if (!ALLOWED_SCREEN_EVIDENCE_CONTENT_TYPES.includes(candidate.contentType)) {
    return {
      ok: false,
      error: `Unsupported content type "${candidate.contentType}" — only image/jpeg or image/webp are accepted`,
    };
  }
  if (candidate.byteSize <= 0) {
    return { ok: false, error: "Empty file" };
  }
  if (candidate.byteSize > MAX_SCREEN_EVIDENCE_BYTES) {
    return {
      ok: false,
      error: `File exceeds the ${MAX_SCREEN_EVIDENCE_BYTES} byte limit for a screen evidence frame`,
    };
  }
  return { ok: true };
}

export type ScreenEvidenceKeyParams = {
  submissionId: string;
  contentType: string;
};

/**
 * Builds an opaque storage key from IDs the system already generates
 * (cuids) plus a caller-supplied random suffix — never from anything
 * identity-revealing. A single flat folder,
 * `screen-share-evidence/{submissionId}-{random}.{ext}`, matching the
 * flat-folder convention `generateEvidenceFrameStorageKey` in
 * aiCameraEvidenceFrame.ts already uses (a prior nested-path attempt was
 * rejected by Supabase Storage — see that file's comment). Deliberately
 * does NOT include an integrityEventId in the key (unlike the camera
 * version) since the event is created by the SAME request as the upload,
 * not beforehand — the server generates both together.
 */
export function generateScreenEvidenceStorageKey(params: ScreenEvidenceKeyParams, randomSuffix: string): string {
  const ext = CONTENT_TYPE_EXTENSIONS[params.contentType] ?? "bin";
  return `screen-share-evidence/${params.submissionId}-${randomSuffix}.${ext}`;
}

/** Source label shown in the lecturer evidence review UI — distinguishes this from a camera evidence frame's "Camera evidence" label. Never "screenshot," "capture of prohibited content," or anything implying interpretation of what's shown. */
export function evidenceFrameSourceLabel(kind: string): string {
  if (kind === SCREEN_SHARE_EVIDENCE_KIND) return "Screen-share evidence";
  return "Camera evidence";
}

/**
 * Neutral, non-accusatory privacy note for the lecturer review UI —
 * mirrors EVIDENCE_FRAME_PRIVACY_NOTE in aiCameraEvidenceFrame.ts. Never
 * "cheating," "misconduct," "proof," or "caught," and explicitly notes
 * the entire-display nature of this evidence (distinct from a webcam
 * frame) so a reviewer understands its scope and limitations at a
 * glance.
 */
export const SCREEN_EVIDENCE_PRIVACY_NOTE =
  "This is a single, downscaled screen-share evidence frame captured for review. It reflects the " +
  "student's entire display at the moment of capture and may contain personal or unrelated " +
  "information. It is a review signal, not proof of misconduct — no continuous screen recording " +
  "was made, and no audio was captured.";

/** Builds the upload URL for a screen evidence frame — the single source of truth so client/server/tests agree. Matches src/app/api/submissions/[id]/screen-evidence/route.ts. */
export function buildScreenEvidenceUploadPath(submissionId: string): string {
  return `/api/submissions/${submissionId}/screen-evidence`;
}
