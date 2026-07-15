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
  generateEvidenceFrameStorageKey,
  isEvidenceCaptureEligibleEventType,
  shouldCaptureEvidenceFrame,
  validateEvidenceFrameUpload,
} from "./aiCameraEvidenceFrame";

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

describe("generateEvidenceFrameStorageKey", () => {
  it("5. the generated key never contains a student name or email — only opaque IDs", () => {
    const key = generateEvidenceFrameStorageKey(
      {
        institutionId: "inst_xyz000",
        examId: "exam_abc123",
        submissionId: "sub_def456",
        integrityEventId: "evt_ghi789",
        contentType: "image/jpeg",
      },
      "randomsuffix1",
    );
    expect(key).not.toMatch(/@/); // no email
    expect(key).not.toContain(" "); // no "Firstname Lastname"-style name
    expect(key).toContain("inst_xyz000");
    expect(key).toContain("exam_abc123");
    expect(key).toContain("sub_def456");
    expect(key).toContain("evt_ghi789");
    expect(key.toLowerCase()).not.toContain("student");
  });

  it("uses the correct extension per content type", () => {
    const base = { institutionId: "i1", examId: "e1", submissionId: "s1", integrityEventId: "ev1" };
    expect(generateEvidenceFrameStorageKey({ ...base, contentType: "image/jpeg" }, "x")).toMatch(/\.jpg$/);
    expect(generateEvidenceFrameStorageKey({ ...base, contentType: "image/webp" }, "x")).toMatch(/\.webp$/);
  });

  it("is namespaced institution/{id}/exam/{id}/submission/{id}/event/{id}/...", () => {
    const key = generateEvidenceFrameStorageKey(
      { institutionId: "i1", examId: "e1", submissionId: "s1", integrityEventId: "ev1", contentType: "image/jpeg" },
      "x",
    );
    expect(key).toBe("institution/i1/exam/e1/submission/s1/event/ev1/x.jpg");
    expect(key.startsWith("institution/")).toBe(true);
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
