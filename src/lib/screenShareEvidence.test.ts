/**
 * Screen-share Evidence Mode v1 — pure evidence-frame helper tests. See
 * docs/screen-share-evidence-v1.md.
 */
import { describe, expect, it } from "vitest";
import {
  validateScreenEvidenceUpload,
  generateScreenEvidenceStorageKey,
  evidenceFrameSourceLabel,
  buildScreenEvidenceUploadPath,
  SCREEN_SHARE_EVIDENCE_KIND,
  MAX_SCREEN_EVIDENCE_BYTES,
  ALLOWED_SCREEN_EVIDENCE_CONTENT_TYPES,
} from "./screenShareEvidence";

describe("MIME and size rejection", () => {
  it("accepts allowed content types within the size limit", () => {
    expect(validateScreenEvidenceUpload({ contentType: "image/jpeg", byteSize: 1_000 })).toEqual({ ok: true });
    expect(validateScreenEvidenceUpload({ contentType: "image/webp", byteSize: 1_000 })).toEqual({ ok: true });
  });

  it("rejects a disallowed content type (e.g. SVG/HTML)", () => {
    const result = validateScreenEvidenceUpload({ contentType: "image/svg+xml", byteSize: 1_000 });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty file", () => {
    expect(validateScreenEvidenceUpload({ contentType: "image/jpeg", byteSize: 0 }).ok).toBe(false);
  });

  it("rejects a file over the size limit", () => {
    const result = validateScreenEvidenceUpload({ contentType: "image/jpeg", byteSize: MAX_SCREEN_EVIDENCE_BYTES + 1 });
    expect(result.ok).toBe(false);
  });

  it("accepts a file exactly at the size limit", () => {
    expect(validateScreenEvidenceUpload({ contentType: "image/jpeg", byteSize: MAX_SCREEN_EVIDENCE_BYTES }).ok).toBe(true);
  });

  it("only image/jpeg and image/webp are allowed", () => {
    expect([...ALLOWED_SCREEN_EVIDENCE_CONTENT_TYPES].sort()).toEqual(["image/jpeg", "image/webp"].sort());
  });
});

describe("storage key generation", () => {
  it("is deterministic for the same inputs, and never contains identity-revealing info", () => {
    const key = generateScreenEvidenceStorageKey({ submissionId: "sub123", contentType: "image/jpeg" }, "abc123");
    expect(key).toBe("screen-share-evidence/sub123-abc123.jpg");
    expect(key).not.toMatch(/@/); // no email
  });

  it("uses the correct extension per content type", () => {
    expect(generateScreenEvidenceStorageKey({ submissionId: "s", contentType: "image/webp" }, "r")).toMatch(/\.webp$/);
  });

  it("never contains a leading slash or path traversal", () => {
    const key = generateScreenEvidenceStorageKey({ submissionId: "sub123", contentType: "image/jpeg" }, "abc");
    expect(key.startsWith("/")).toBe(false);
    expect(key).not.toContain("..");
  });
});

describe("frame source labelling", () => {
  it("distinguishes screen-share evidence from camera evidence", () => {
    expect(evidenceFrameSourceLabel(SCREEN_SHARE_EVIDENCE_KIND)).toBe("Screen-share evidence");
    expect(evidenceFrameSourceLabel("AI_CAMERA_EVIDENCE_FRAME")).toBe("Camera evidence");
  });
});

describe("upload path", () => {
  it("matches the actual route file path shape", () => {
    expect(buildScreenEvidenceUploadPath("sub123")).toBe("/api/submissions/sub123/screen-evidence");
  });
});
