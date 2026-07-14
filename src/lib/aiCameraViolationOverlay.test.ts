/**
 * Local exam-content blur/overlay for AI camera violation events. See
 * docs/on-device-ai-integrity-detection-v1.md and
 * src/lib/aiCameraViolationOverlay.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser, no webcam, no
 * TensorFlow, no React rendering.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AI_CAMERA_VIOLATION_OVERLAY_TITLE,
  clearAiCameraViolationOverlay,
  createAiCameraViolationOverlay,
  handleAiCameraIntegrityReport,
  isAiCameraViolationEvent,
  reasonForAiCameraViolation,
} from "./aiCameraViolationOverlay";

describe("createAiCameraViolationOverlay", () => {
  it("1. a second-person event creates an active overlay", () => {
    const overlay = createAiCameraViolationOverlay("POSSIBLE_SECOND_PERSON_VISIBLE");
    expect(overlay).not.toBeNull();
    expect(overlay?.active).toBe(true);
    expect(overlay?.title).toBe(AI_CAMERA_VIOLATION_OVERLAY_TITLE);
    expect(overlay?.reason).toBe("Possible second person visible");
  });

  it("2. a no-person event creates an active overlay", () => {
    const overlay = createAiCameraViolationOverlay("NO_PERSON_VISIBLE");
    expect(overlay?.active).toBe(true);
    expect(overlay?.reason).toBe("No person visible");
  });

  it("3. a phone event creates an active overlay", () => {
    const overlay = createAiCameraViolationOverlay("POSSIBLE_PHONE_VISIBLE");
    expect(overlay?.active).toBe(true);
    expect(overlay?.reason).toBe("Possible phone visible");
  });

  it("4. a camera-blocked event creates an active overlay", () => {
    const overlay = createAiCameraViolationOverlay("CAMERA_VIEW_BLOCKED");
    expect(overlay?.active).toBe(true);
    expect(overlay?.reason).toBe("Camera view may be blocked");
  });

  it("5. a dark-camera event creates an active overlay", () => {
    const overlay = createAiCameraViolationOverlay("CAMERA_TOO_DARK");
    expect(overlay?.active).toBe(true);
    expect(overlay?.reason).toBe("Camera view is too dark");
  });

  it("6. a non-AI event does not create an overlay", () => {
    expect(createAiCameraViolationOverlay("WINDOW_BLUR")).toBeNull();
    expect(createAiCameraViolationOverlay("COPY_ATTEMPT")).toBeNull();
    expect(createAiCameraViolationOverlay("CAMERA_HEARTBEAT_MISSED")).toBeNull();
    expect(createAiCameraViolationOverlay("STUDENT_VERIFICATION_CONFIRMED")).toBeNull();
    expect(createAiCameraViolationOverlay("AI_CAMERA_CHECK_UNAVAILABLE")).toBeNull();
  });

  it("7. wording is neutral and non-accusatory across all AI camera violation reasons", () => {
    const eventTypes = [
      "POSSIBLE_SECOND_PERSON_VISIBLE",
      "NO_PERSON_VISIBLE",
      "POSSIBLE_PHONE_VISIBLE",
      "CAMERA_VIEW_BLOCKED",
      "CAMERA_TOO_DARK",
    ];
    const bannedWords = ["cheat", "misconduct", "caught", "proven", "confirmed violation"];
    for (const eventType of eventTypes) {
      const overlay = createAiCameraViolationOverlay(eventType);
      const allText = `${overlay?.title} ${overlay?.reason}`.toLowerCase();
      for (const banned of bannedWords) {
        expect(allText).not.toContain(banned);
      }
    }
    expect(AI_CAMERA_VIOLATION_OVERLAY_TITLE.toLowerCase()).not.toContain("cheat");
  });
});

describe("isAiCameraViolationEvent", () => {
  it("recognizes all five AI camera signal event types", () => {
    expect(isAiCameraViolationEvent("POSSIBLE_SECOND_PERSON_VISIBLE")).toBe(true);
    expect(isAiCameraViolationEvent("NO_PERSON_VISIBLE")).toBe(true);
    expect(isAiCameraViolationEvent("POSSIBLE_PHONE_VISIBLE")).toBe(true);
    expect(isAiCameraViolationEvent("CAMERA_VIEW_BLOCKED")).toBe(true);
    expect(isAiCameraViolationEvent("CAMERA_TOO_DARK")).toBe(true);
  });

  it("rejects non-AI-camera event types", () => {
    expect(isAiCameraViolationEvent("WINDOW_BLUR")).toBe(false);
    expect(isAiCameraViolationEvent("FULLSCREEN_EXIT")).toBe(false);
    expect(isAiCameraViolationEvent("AI_CAMERA_CHECK_UNAVAILABLE")).toBe(false);
  });
});

describe("reasonForAiCameraViolation", () => {
  it("returns null for a non-AI-camera event type", () => {
    expect(reasonForAiCameraViolation("TIMER_EXPIRED")).toBeNull();
  });
});

describe("clearAiCameraViolationOverlay", () => {
  it("always returns null", () => {
    expect(clearAiCameraViolationOverlay()).toBeNull();
  });
});

describe("handleAiCameraIntegrityReport", () => {
  it("1. sets local overlay state before the backend logging promise resolves", async () => {
    let resolveBackend!: () => void;
    const backendPromise = new Promise<void>((resolve) => {
      resolveBackend = resolve;
    });
    const setOverlay = vi.fn();
    const sendToBackend = vi.fn(() => backendPromise);

    const reportPromise = handleAiCameraIntegrityReport("POSSIBLE_PHONE_VISIBLE", {
      setOverlay,
      sendToBackend,
    });

    // The overlay must already be set synchronously, before the backend
    // promise has had any chance to resolve.
    expect(setOverlay).toHaveBeenCalledTimes(1);
    expect(setOverlay).toHaveBeenCalledWith({
      active: true,
      title: AI_CAMERA_VIOLATION_OVERLAY_TITLE,
      reason: "Possible phone visible",
    });
    expect(sendToBackend).toHaveBeenCalledTimes(1);

    resolveBackend();
    await reportPromise;
    // Still only ever called once — resolution does not re-trigger or
    // otherwise touch the overlay.
    expect(setOverlay).toHaveBeenCalledTimes(1);
  });

  it("2. a backend logging failure does not prevent or clear the overlay", async () => {
    const setOverlay = vi.fn();
    const sendToBackend = vi.fn(() => Promise.reject(new Error("network error")));

    await expect(
      handleAiCameraIntegrityReport("NO_PERSON_VISIBLE", { setOverlay, sendToBackend }),
    ).resolves.toBeUndefined();

    expect(setOverlay).toHaveBeenCalledTimes(1);
    expect(setOverlay).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, reason: "No person visible" }),
    );
  });

  it("10/11. POSSIBLE_PHONE_VISIBLE gets an immediate overlay, and a backend failure does not prevent it", async () => {
    const setOverlay = vi.fn();
    const sendToBackend = vi.fn(() => Promise.reject(new Error("network error")));

    await expect(
      handleAiCameraIntegrityReport("POSSIBLE_PHONE_VISIBLE", { setOverlay, sendToBackend }),
    ).resolves.toBeUndefined();

    // Overlay set synchronously (verified more fully in test "1" above);
    // here the important part is that a rejected sendToBackend does not
    // change that outcome for the phone signal specifically.
    expect(setOverlay).toHaveBeenCalledTimes(1);
    expect(setOverlay).toHaveBeenCalledWith({
      active: true,
      title: AI_CAMERA_VIOLATION_OVERLAY_TITLE,
      reason: "Possible phone visible",
    });
  });

  it("does not set overlay state for non-AI-camera event types, but still calls sendToBackend", async () => {
    const setOverlay = vi.fn();
    const sendToBackend = vi.fn(() => Promise.resolve());

    await handleAiCameraIntegrityReport("WINDOW_BLUR", { setOverlay, sendToBackend });

    expect(setOverlay).not.toHaveBeenCalled();
    expect(sendToBackend).toHaveBeenCalledTimes(1);
  });

  it("3. acknowledgement clears overlay (simulated via clearAiCameraViolationOverlay)", () => {
    // Mirrors the component's acknowledge handler:
    // setAiCameraViolationOverlay(clearAiCameraViolationOverlay())
    let overlayState: ReturnType<typeof createAiCameraViolationOverlay> = createAiCameraViolationOverlay(
      "POSSIBLE_SECOND_PERSON_VISIBLE",
    );
    expect(overlayState?.active).toBe(true);

    overlayState = clearAiCameraViolationOverlay();
    expect(overlayState).toBeNull();
  });
});
