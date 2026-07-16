/**
 * Add privacy-minimised AI camera evidence frames — see
 * docs/on-device-ai-integrity-detection-v1.md and
 * src/lib/aiCameraEvidenceFrame.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser, no webcam.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_EVIDENCE_FRAME_CONTENT_TYPES,
  EVIDENCE_CAPTURE_EVENT_TYPES,
  MAX_EVIDENCE_FRAME_BYTES,
  buildEvidenceFrameUploadPath,
  evidenceUploadSkipReason,
  generateEvidenceFrameStorageKey,
  isEvidenceCaptureEligibleEventType,
  isEvidenceFrameSourceReady,
  shouldAttemptEvidenceUpload,
  shouldCaptureEvidenceFrame,
  shouldLogEvidenceUploadDebug,
  validateEvidenceFrameUpload,
} from "./aiCameraEvidenceFrame";

const captureOn = { enableAiCameraIntegrityChecks: true, captureAiViolationEvidence: true };
const captureOffSetting = { enableAiCameraIntegrityChecks: true, captureAiViolationEvidence: false };
const aiChecksOff = { enableAiCameraIntegrityChecks: false, captureAiViolationEvidence: true };

describe("isEvidenceCaptureEligibleEventType", () => {
  it("1. allows only POSSIBLE_PHONE_VISIBLE and POSSIBLE_SECOND_PERSON_VISIBLE", () => {
    expect(isEvidenceCaptureEligibleEventType("POSSIBLE_PHONE_VISIBLE")).toBe(true);
    expect(isEvidenceCaptureEligibleEventType("POSSIBLE_SECOND_PERSON_VISIBLE")).toBe(true);
  });

  it("1. rejects NO_PERSON_VISIBLE, CAMERA_VIEW_BLOCKED, CAMERA_TOO_DARK, and AI_CAMERA_CHECK_UNAVAILABLE in v1", () => {
    expect(isEvidenceCaptureEligibleEventType("NO_PERSON_VISIBLE")).toBe(false);
    expect(isEvidenceCaptureEligibleEventType("CAMERA_VIEW_BLOCKED")).toBe(false);
    expect(isEvidenceCaptureEligibleEventType("CAMERA_TOO_DARK")).toBe(false);
    expect(isEvidenceCaptureEligibleEventType("AI_CAMERA_CHECK_UNAVAILABLE")).toBe(false);
  });

  it("rejects unrelated event types", () => {
    expect(isEvidenceCaptureEligibleEventType("WINDOW_BLUR")).toBe(false);
    expect(isEvidenceCaptureEligibleEventType("STUDENT_VERIFICATION_CONFIRMED")).toBe(false);
  });

  it("EVIDENCE_CAPTURE_EVENT_TYPES contains exactly the two v1 event types", () => {
    expect([...EVIDENCE_CAPTURE_EVENT_TYPES].sort()).toEqual(
      ["POSSIBLE_PHONE_VISIBLE", "POSSIBLE_SECOND_PERSON_VISIBLE"].sort(),
    );
  });
});

describe("shouldCaptureEvidenceFrame", () => {
  it("2. is disabled by default — false when captureAiViolationEvidence is false, even for an eligible event type with AI checks on", () => {
    const enabled = shouldCaptureEvidenceFrame("POSSIBLE_PHONE_VISIBLE", {
      enableAiCameraIntegrityChecks: true,
      captureAiViolationEvidence: false,
    });
    expect(enabled).toBe(false);
  });

  it("3. requires captureAiViolationEvidence === true before a capture is attempted", () => {
    const enabled = shouldCaptureEvidenceFrame("POSSIBLE_SECOND_PERSON_VISIBLE", {
      enableAiCameraIntegrityChecks: true,
      captureAiViolationEvidence: true,
    });
    expect(enabled).toBe(true);
  });

  it("has no effect if AI camera checks are off, even if captureAiViolationEvidence is somehow true", () => {
    const enabled = shouldCaptureEvidenceFrame("POSSIBLE_PHONE_VISIBLE", {
      enableAiCameraIntegrityChecks: false,
      captureAiViolationEvidence: true,
    });
    expect(enabled).toBe(false);
  });

  it("never captures for an ineligible event type, regardless of settings", () => {
    const enabled = shouldCaptureEvidenceFrame("NO_PERSON_VISIBLE", {
      enableAiCameraIntegrityChecks: true,
      captureAiViolationEvidence: true,
    });
    expect(enabled).toBe(false);
  });
});

describe("shouldAttemptEvidenceUpload", () => {
  it("1. returns true for POSSIBLE_PHONE_VISIBLE with an event id and captureAiViolationEvidence true", () => {
    expect(shouldAttemptEvidenceUpload("POSSIBLE_PHONE_VISIBLE", captureOn, "evt_123")).toBe(true);
  });

  it("2. returns true for POSSIBLE_SECOND_PERSON_VISIBLE with an event id and captureAiViolationEvidence true", () => {
    expect(shouldAttemptEvidenceUpload("POSSIBLE_SECOND_PERSON_VISIBLE", captureOn, "evt_123")).toBe(true);
  });

  it("3. returns false for NO_PERSON_VISIBLE", () => {
    expect(shouldAttemptEvidenceUpload("NO_PERSON_VISIBLE", captureOn, "evt_123")).toBe(false);
  });

  it("returns false for CAMERA_TOO_DARK, CAMERA_VIEW_BLOCKED, AI_CAMERA_CHECK_UNAVAILABLE, and WINDOW_BLUR", () => {
    expect(shouldAttemptEvidenceUpload("CAMERA_TOO_DARK", captureOn, "evt_123")).toBe(false);
    expect(shouldAttemptEvidenceUpload("CAMERA_VIEW_BLOCKED", captureOn, "evt_123")).toBe(false);
    expect(shouldAttemptEvidenceUpload("AI_CAMERA_CHECK_UNAVAILABLE", captureOn, "evt_123")).toBe(false);
    expect(shouldAttemptEvidenceUpload("WINDOW_BLUR", captureOn, "evt_123")).toBe(false);
  });

  it("4. returns false when captureAiViolationEvidence is false", () => {
    expect(shouldAttemptEvidenceUpload("POSSIBLE_PHONE_VISIBLE", captureOffSetting, "evt_123")).toBe(false);
  });

  it("returns false when enableAiCameraIntegrityChecks is false, even if captureAiViolationEvidence is true", () => {
    expect(shouldAttemptEvidenceUpload("POSSIBLE_PHONE_VISIBLE", aiChecksOff, "evt_123")).toBe(false);
  });

  it("5. returns false when the event id is missing (e.g. response body didn't parse)", () => {
    expect(shouldAttemptEvidenceUpload("POSSIBLE_PHONE_VISIBLE", captureOn, undefined)).toBe(false);
    expect(shouldAttemptEvidenceUpload("POSSIBLE_PHONE_VISIBLE", captureOn, null)).toBe(false);
    expect(shouldAttemptEvidenceUpload("POSSIBLE_PHONE_VISIBLE", captureOn, "")).toBe(false);
  });
});

describe("evidenceUploadSkipReason", () => {
  it("returns null (proceed) when everything is eligible and an id was returned", () => {
    expect(evidenceUploadSkipReason("POSSIBLE_PHONE_VISIBLE", captureOn, "evt_123")).toBeNull();
  });

  it("returns 'ineligible-event-type' for an event type evidence is never captured for", () => {
    expect(evidenceUploadSkipReason("NO_PERSON_VISIBLE", captureOn, "evt_123")).toBe("ineligible-event-type");
    expect(evidenceUploadSkipReason("WINDOW_BLUR", captureOn, "evt_123")).toBe("ineligible-event-type");
  });

  it("returns 'setting-disabled' when the event type is eligible but a setting is off", () => {
    expect(evidenceUploadSkipReason("POSSIBLE_PHONE_VISIBLE", captureOffSetting, "evt_123")).toBe(
      "setting-disabled",
    );
    expect(evidenceUploadSkipReason("POSSIBLE_PHONE_VISIBLE", aiChecksOff, "evt_123")).toBe("setting-disabled");
  });

  it("returns 'missing-event-id' when everything else is eligible but no id was returned", () => {
    expect(evidenceUploadSkipReason("POSSIBLE_PHONE_VISIBLE", captureOn, undefined)).toBe("missing-event-id");
    expect(evidenceUploadSkipReason("POSSIBLE_PHONE_VISIBLE", captureOn, null)).toBe("missing-event-id");
  });
});

describe("buildEvidenceFrameUploadPath", () => {
  it("6. returns /api/submissions/{submissionId}/integrity-events/{eventId}/evidence-frame", () => {
    expect(buildEvidenceFrameUploadPath("sub_123", "evt_456")).toBe(
      "/api/submissions/sub_123/integrity-events/evt_456/evidence-frame",
    );
  });

  it("never uses a stale /evidence path or the eventType in place of the event id", () => {
    const path = buildEvidenceFrameUploadPath("sub_123", "evt_456");
    expect(path.endsWith("/evidence-frame")).toBe(true);
    expect(path).not.toMatch(/\/evidence$/);
  });
});

describe("shouldLogEvidenceUploadDebug", () => {
  it("8. is enabled only by the exact opt-in flag value, independent of NODE_ENV (Preview-safe)", () => {
    expect(shouldLogEvidenceUploadDebug("true")).toBe(true);
  });

  it("is disabled for any other flag value, including falsy/unset", () => {
    expect(shouldLogEvidenceUploadDebug("false")).toBe(false);
    expect(shouldLogEvidenceUploadDebug(null)).toBe(false);
    expect(shouldLogEvidenceUploadDebug(undefined)).toBe(false);
    expect(shouldLogEvidenceUploadDebug("1")).toBe(false);
  });
});

describe("isEvidenceFrameSourceReady", () => {
  it("is ready when readyState >= 2 (HAVE_CURRENT_DATA) and videoWidth is non-zero", () => {
    expect(isEvidenceFrameSourceReady({ readyState: 2, videoWidth: 320 })).toBe(true);
    expect(isEvidenceFrameSourceReady({ readyState: 4, videoWidth: 640 })).toBe(true);
  });

  it("is not ready when videoWidth is zero (metadata not loaded yet)", () => {
    expect(isEvidenceFrameSourceReady({ readyState: 4, videoWidth: 0 })).toBe(false);
  });

  it("is not ready when readyState is below HAVE_CURRENT_DATA", () => {
    expect(isEvidenceFrameSourceReady({ readyState: 1, videoWidth: 320 })).toBe(false);
    expect(isEvidenceFrameSourceReady({ readyState: 0, videoWidth: 320 })).toBe(false);
  });

  it("is not ready when there is no video element at all", () => {
    expect(isEvidenceFrameSourceReady(null)).toBe(false);
    expect(isEvidenceFrameSourceReady(undefined)).toBe(false);
  });
});

describe("generateEvidenceFrameStorageKey", () => {
  it("1. returns the simplified ai-camera-evidence/{submissionId}-{integrityEventId}-{random}.jpg format", () => {
    const key = generateEvidenceFrameStorageKey(
      { submissionId: "sub_def456", integrityEventId: "evt_ghi789", contentType: "image/jpeg" },
      "randomsuffix1",
    );
    expect(key).toBe("ai-camera-evidence/sub_def456-evt_ghi789-randomsuffix1.jpg");
  });

  it("2. the generated key never contains a student name or email — only opaque IDs", () => {
    const key = generateEvidenceFrameStorageKey(
      { submissionId: "sub_def456", integrityEventId: "evt_ghi789", contentType: "image/jpeg" },
      "randomsuffix1",
    );
    expect(key).not.toMatch(/@/); // no email
    expect(key).not.toContain(" "); // no "Firstname Lastname"-style name
    expect(key).toContain("sub_def456");
    expect(key).toContain("evt_ghi789");
    expect(key.toLowerCase()).not.toContain("student");
  });

  it("3. has no leading slash", () => {
    const key = generateEvidenceFrameStorageKey(
      { submissionId: "s1", integrityEventId: "ev1", contentType: "image/jpeg" },
      "x",
    );
    expect(key.startsWith("/")).toBe(false);
  });

  it("4. has no double slash", () => {
    const key = generateEvidenceFrameStorageKey(
      { submissionId: "s1", integrityEventId: "ev1", contentType: "image/jpeg" },
      "x",
    );
    expect(key).not.toContain("//");
  });

  it("5. has only one folder prefix (a single '/')", () => {
    const key = generateEvidenceFrameStorageKey(
      { submissionId: "s1", integrityEventId: "ev1", contentType: "image/jpeg" },
      "x",
    );
    expect(key.split("/").length).toBe(2);
    expect(key.startsWith("ai-camera-evidence/")).toBe(true);
  });

  it("6. uses the correct extension per content type (jpg and webp)", () => {
    const base = { submissionId: "s1", integrityEventId: "ev1" };
    expect(generateEvidenceFrameStorageKey({ ...base, contentType: "image/jpeg" }, "x")).toMatch(/\.jpg$/);
    expect(generateEvidenceFrameStorageKey({ ...base, contentType: "image/webp" }, "x")).toMatch(/\.webp$/);
  });

  it("only contains lowercase letters, digits, hyphens, one slash, and a dot before the extension (real cuid-shaped ids)", () => {
    const key = generateEvidenceFrameStorageKey(
      {
        submissionId: "cmrng95oq000104jvaw8dnnma",
        integrityEventId: "cmrngigkw000j04jrjpwjcvft",
        contentType: "image/jpeg",
      },
      "154b0679500bcb3e",
    );
    expect(key).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+\.(jpg|webp)$/);
  });
});

describe("validateEvidenceFrameUpload", () => {
  it("accepts image/jpeg within the size limit", () => {
    const result = validateEvidenceFrameUpload({ contentType: "image/jpeg", byteSize: 50_000 });
    expect(result.ok).toBe(true);
  });

  it("accepts image/webp within the size limit", () => {
    const result = validateEvidenceFrameUpload({ contentType: "image/webp", byteSize: 50_000 });
    expect(result.ok).toBe(true);
  });

  it("rejects image/svg+xml", () => {
    const result = validateEvidenceFrameUpload({ contentType: "image/svg+xml", byteSize: 1_000 });
    expect(result.ok).toBe(false);
  });

  it("rejects text/html", () => {
    const result = validateEvidenceFrameUpload({ contentType: "text/html", byteSize: 1_000 });
    expect(result.ok).toBe(false);
  });

  it("rejects application/octet-stream / executable-looking content", () => {
    const result = validateEvidenceFrameUpload({ contentType: "application/octet-stream", byteSize: 1_000 });
    expect(result.ok).toBe(false);
  });

  it("rejects a file over MAX_EVIDENCE_FRAME_BYTES", () => {
    const result = validateEvidenceFrameUpload({
      contentType: "image/jpeg",
      byteSize: MAX_EVIDENCE_FRAME_BYTES + 1,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a file exactly at MAX_EVIDENCE_FRAME_BYTES", () => {
    const result = validateEvidenceFrameUpload({
      contentType: "image/jpeg",
      byteSize: MAX_EVIDENCE_FRAME_BYTES,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty file", () => {
    const result = validateEvidenceFrameUpload({ contentType: "image/jpeg", byteSize: 0 });
    expect(result.ok).toBe(false);
  });

  it("ALLOWED_EVIDENCE_FRAME_CONTENT_TYPES contains exactly jpeg and webp", () => {
    expect([...ALLOWED_EVIDENCE_FRAME_CONTENT_TYPES].sort()).toEqual(["image/jpeg", "image/webp"].sort());
  });
});
