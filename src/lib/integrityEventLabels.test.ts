/**
 * Surface evidence frames in lecturer report — see
 * docs/on-device-ai-integrity-detection-v1.md and
 * src/lib/integrityEventLabels.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser.
 */
import { describe, expect, it } from "vitest";
import {
  categoryForEventType,
  INTEGRITY_EVENT_CATEGORY_LABELS,
  labelForEventType,
} from "./integrityEventLabels";

describe("categoryForEventType", () => {
  it("categorizes POSSIBLE_PHONE_VISIBLE and POSSIBLE_SECOND_PERSON_VISIBLE as 'evidence'", () => {
    expect(categoryForEventType("POSSIBLE_PHONE_VISIBLE")).toBe("evidence");
    expect(categoryForEventType("POSSIBLE_SECOND_PERSON_VISIBLE")).toBe("evidence");
  });

  it("categorizes camera-related, evidence-ineligible types as 'camera'", () => {
    expect(categoryForEventType("NO_PERSON_VISIBLE")).toBe("camera");
    expect(categoryForEventType("CAMERA_VIEW_BLOCKED")).toBe("camera");
    expect(categoryForEventType("CAMERA_TOO_DARK")).toBe("camera");
    expect(categoryForEventType("AI_CAMERA_CHECK_UNAVAILABLE")).toBe("camera");
    expect(categoryForEventType("CAMERA_STARTED")).toBe("camera");
    expect(categoryForEventType("CAMERA_HEARTBEAT_MISSED")).toBe("camera");
  });

  it("categorizes window/focus/fullscreen types as 'window'", () => {
    expect(categoryForEventType("WINDOW_BLUR")).toBe("window");
    expect(categoryForEventType("WINDOW_FOCUS_RETURN")).toBe("window");
    expect(categoryForEventType("FULLSCREEN_EXIT")).toBe("window");
    expect(categoryForEventType("FULLSCREEN_FORCED_RETURN")).toBe("window");
  });

  it("falls back to 'info' for everything else", () => {
    expect(categoryForEventType("COPY_ATTEMPT")).toBe("info");
    expect(categoryForEventType("STUDENT_VERIFICATION_CONFIRMED")).toBe("info");
    expect(categoryForEventType("TIMER_EXPIRED")).toBe("info");
    expect(categoryForEventType("SOMETHING_UNKNOWN")).toBe("info");
  });
});

describe("INTEGRITY_EVENT_CATEGORY_LABELS", () => {
  it("has a label for every category", () => {
    expect(INTEGRITY_EVENT_CATEGORY_LABELS.evidence).toBe("Evidence events");
    expect(INTEGRITY_EVENT_CATEGORY_LABELS.camera).toBe("Camera events");
    expect(INTEGRITY_EVENT_CATEGORY_LABELS.window).toBe("Window/focus events");
    expect(INTEGRITY_EVENT_CATEGORY_LABELS.info).toBe("Info events");
  });
});

describe("labelForEventType (unchanged)", () => {
  it("still returns the existing neutral wording for AI camera events", () => {
    expect(labelForEventType("POSSIBLE_PHONE_VISIBLE")).toContain("Possible");
    expect(labelForEventType("POSSIBLE_PHONE_VISIBLE").toLowerCase()).not.toContain("cheating");
    expect(labelForEventType("POSSIBLE_PHONE_VISIBLE").toLowerCase()).not.toContain("caught");
    expect(labelForEventType("POSSIBLE_PHONE_VISIBLE").toLowerCase()).not.toContain("proof");
  });

  it("falls back to the raw event type for unknown types", () => {
    expect(labelForEventType("SOME_UNLISTED_TYPE")).toBe("SOME_UNLISTED_TYPE");
  });
});
