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

  // Secure Exam Evidence Review audit v1 — these five event types are the
  // only lockdown signals that ever reach IntegrityEvent (see
  // docs/tether-windows-lockdown-hardening-v1.md). Before this fix they
  // fell into the generic "info" bucket alongside truly informational
  // signals, despite being MEDIUM-severity reviewable detections.
  it("categorizes lockdown detection event types as 'lockdown', not 'info'", () => {
    expect(categoryForEventType("REMOTE_CONTROL_SOFTWARE_DETECTED")).toBe("lockdown");
    expect(categoryForEventType("SCREEN_CAPTURE_SOFTWARE_DETECTED")).toBe("lockdown");
    expect(categoryForEventType("DEBUGGING_TOOL_DETECTED")).toBe("lockdown");
    expect(categoryForEventType("PROHIBITED_APPLICATION_DETECTED")).toBe("lockdown");
    expect(categoryForEventType("PROHIBITED_APPLICATION_CLOSED")).toBe("lockdown");
  });
});

describe("INTEGRITY_EVENT_CATEGORY_LABELS", () => {
  it("has a label for every category", () => {
    expect(INTEGRITY_EVENT_CATEGORY_LABELS.evidence).toBe("Evidence events");
    expect(INTEGRITY_EVENT_CATEGORY_LABELS.camera).toBe("Camera events");
    expect(INTEGRITY_EVENT_CATEGORY_LABELS.lockdown).toBe("Lockdown detection events");
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

  // Secure Exam Evidence Review audit v1 — a lecturer previously saw the
  // raw enum string (e.g. "REMOTE_CONTROL_SOFTWARE_DETECTED") for these
  // five types; now a calm, neutral label, and never a "confirmed"/
  // "caught"/"proof"-style word (a detection is a signal, not a finding).
  it("has a neutral, non-raw label for every lockdown detection event type", () => {
    for (const eventType of [
      "REMOTE_CONTROL_SOFTWARE_DETECTED",
      "SCREEN_CAPTURE_SOFTWARE_DETECTED",
      "DEBUGGING_TOOL_DETECTED",
      "PROHIBITED_APPLICATION_DETECTED",
      "PROHIBITED_APPLICATION_CLOSED",
    ]) {
      const label = labelForEventType(eventType);
      expect(label).not.toBe(eventType);
      expect(label.toLowerCase()).not.toContain("confirmed");
      expect(label.toLowerCase()).not.toContain("caught");
      expect(label.toLowerCase()).not.toContain("proof");
      expect(label.toLowerCase()).not.toContain("cheating");
    }
  });
});

describe("labelForEventType — mid-exam remote-session monitoring v1 metadata-specific wording", () => {
  it('shows "Remote session ended" for PROHIBITED_APPLICATION_CLOSED when metadata identifies REMOTE_DESKTOP_SESSION', () => {
    expect(labelForEventType("PROHIBITED_APPLICATION_CLOSED", { capabilityId: "REMOTE_DESKTOP_SESSION" })).toBe(
      "Remote session ended",
    );
  });

  it("still shows the generic label for PROHIBITED_APPLICATION_CLOSED from any other capability", () => {
    expect(labelForEventType("PROHIBITED_APPLICATION_CLOSED", { capabilityId: "TEAMVIEWER" })).toBe(
      "Prohibited application closed",
    );
    expect(labelForEventType("PROHIBITED_APPLICATION_CLOSED", null)).toBe("Prohibited application closed");
    expect(labelForEventType("PROHIBITED_APPLICATION_CLOSED")).toBe("Prohibited application closed");
  });

  it("never overrides any OTHER event type, even one that happens to carry a REMOTE_DESKTOP_SESSION capabilityId (e.g. the DETECTED phase)", () => {
    expect(labelForEventType("REMOTE_CONTROL_SOFTWARE_DETECTED", { capabilityId: "REMOTE_DESKTOP_SESSION" })).toBe(
      "Remote-control software detected — needs review",
    );
  });

  it("the override wording is calm and never implies misconduct", () => {
    const label = labelForEventType("PROHIBITED_APPLICATION_CLOSED", { capabilityId: "REMOTE_DESKTOP_SESSION" });
    expect(label.toLowerCase()).not.toContain("confirmed");
    expect(label.toLowerCase()).not.toContain("caught");
    expect(label.toLowerCase()).not.toContain("cheating");
  });
});
