import { describe, expect, it } from "vitest";
import {
  activeSafeExamControlLabels,
  DEFAULT_SECURE_SETTINGS,
  parseSecureSettings,
  safeExamModeStatusLabel,
  secureSettingsChanged,
  severityFor,
} from "./secureExam";

describe("parseSecureSettings", () => {
  it("returns defaults for null/undefined input", () => {
    expect(parseSecureSettings(null)).toEqual(DEFAULT_SECURE_SETTINGS);
    expect(parseSecureSettings(undefined)).toEqual(DEFAULT_SECURE_SETTINGS);
  });

  it("merges partial settings with defaults", () => {
    const result = parseSecureSettings({ secureModeEnabled: true, requireFullscreen: true });
    expect(result.secureModeEnabled).toBe(true);
    expect(result.requireFullscreen).toBe(true);
    expect(result.blockCopyPaste).toBe(DEFAULT_SECURE_SETTINGS.blockCopyPaste);
  });

  it("falls back to defaults on invalid input", () => {
    expect(parseSecureSettings({ maxAttempts: -5 })).toEqual(DEFAULT_SECURE_SETTINGS);
  });
});

describe("severityFor", () => {
  it("raises FULLSCREEN_EXIT to HIGH when fullscreen is required", () => {
    const settings = { ...DEFAULT_SECURE_SETTINGS, requireFullscreen: true };
    expect(severityFor("FULLSCREEN_EXIT", settings)).toBe("HIGH");
    expect(severityFor("FULLSCREEN_EXIT", DEFAULT_SECURE_SETTINGS)).toBe("MEDIUM");
  });

  it("lowers COPY_ATTEMPT/PASTE_ATTEMPT severity when blocking is disabled", () => {
    const settings = { ...DEFAULT_SECURE_SETTINGS, blockCopyPaste: false };
    expect(severityFor("COPY_ATTEMPT", settings)).toBe("LOW");
    expect(severityFor("PASTE_ATTEMPT", settings)).toBe("LOW");
    expect(severityFor("COPY_ATTEMPT", DEFAULT_SECURE_SETTINGS)).toBe("MEDIUM");
  });

  it("lowers RIGHT_CLICK_ATTEMPT severity when blocking is disabled", () => {
    const settings = { ...DEFAULT_SECURE_SETTINGS, blockRightClick: false };
    expect(severityFor("RIGHT_CLICK_ATTEMPT", settings)).toBe("LOW");
    expect(severityFor("RIGHT_CLICK_ATTEMPT", DEFAULT_SECURE_SETTINGS)).toBe("MEDIUM");
  });

  it("keeps fixed severities for INFO-level events", () => {
    expect(severityFor("WINDOW_FOCUS_RETURN", DEFAULT_SECURE_SETTINGS)).toBe("INFO");
    expect(severityFor("NETWORK_ONLINE", DEFAULT_SECURE_SETTINGS)).toBe("INFO");
  });

  it("always treats TIMER_EXPIRED and SUBMIT_AFTER_DEADLINE as HIGH", () => {
    expect(severityFor("TIMER_EXPIRED", DEFAULT_SECURE_SETTINGS)).toBe("HIGH");
    expect(severityFor("SUBMIT_AFTER_DEADLINE", DEFAULT_SECURE_SETTINGS)).toBe("HIGH");
  });

  it("raises CAMERA_PERMISSION_DENIED/STOPPED/PRECHECK_FAILED/UNAVAILABLE to HIGH when requireCamera is true", () => {
    const settings = { ...DEFAULT_SECURE_SETTINGS, requireCamera: true };
    expect(severityFor("CAMERA_PERMISSION_DENIED", settings)).toBe("HIGH");
    expect(severityFor("CAMERA_STOPPED", settings)).toBe("HIGH");
    expect(severityFor("CAMERA_PRECHECK_FAILED", settings)).toBe("HIGH");
    expect(severityFor("CAMERA_UNAVAILABLE", settings)).toBe("HIGH");
  });

  it("lowers CAMERA_PERMISSION_DENIED to MEDIUM when requireCamera is false", () => {
    expect(severityFor("CAMERA_PERMISSION_DENIED", DEFAULT_SECURE_SETTINGS)).toBe("MEDIUM");
    expect(DEFAULT_SECURE_SETTINGS.requireCamera).toBe(false);
  });

  it("treats CAMERA_PERMISSION_GRANTED and CAMERA_STARTED as INFO", () => {
    expect(severityFor("CAMERA_PERMISSION_GRANTED", DEFAULT_SECURE_SETTINGS)).toBe("INFO");
    expect(severityFor("CAMERA_STARTED", DEFAULT_SECURE_SETTINGS)).toBe("INFO");
  });

  it("treats CAMERA_HEARTBEAT_MISSED as MEDIUM regardless of requireCamera", () => {
    expect(severityFor("CAMERA_HEARTBEAT_MISSED", DEFAULT_SECURE_SETTINGS)).toBe("MEDIUM");
    expect(
      severityFor("CAMERA_HEARTBEAT_MISSED", { ...DEFAULT_SECURE_SETTINGS, requireCamera: true }),
    ).toBe("MEDIUM");
  });

  it("treats KEYBOARD_SHORTCUT_BLOCKED as INFO and FULLSCREEN_FORCED_RETURN as LOW", () => {
    expect(severityFor("KEYBOARD_SHORTCUT_BLOCKED", DEFAULT_SECURE_SETTINGS)).toBe("INFO");
    expect(severityFor("FULLSCREEN_FORCED_RETURN", DEFAULT_SECURE_SETTINGS)).toBe("LOW");
  });
});

describe("secure settings additions (camera + browser-friction)", () => {
  it("includes camera setting fields with the documented defaults", () => {
    expect(DEFAULT_SECURE_SETTINGS.requireCamera).toBe(false);
    expect(DEFAULT_SECURE_SETTINGS.showCameraPreview).toBe(true);
    expect(DEFAULT_SECURE_SETTINGS.cameraHeartbeatEnabled).toBe(false);
    expect(DEFAULT_SECURE_SETTINGS.cameraHeartbeatIntervalSeconds).toBe(30);
    expect(DEFAULT_SECURE_SETTINGS.recordCameraUnavailableEvents).toBe(true);
  });

  it("includes browser-friction setting fields with the documented defaults", () => {
    expect(DEFAULT_SECURE_SETTINGS.blockKeyboardShortcuts).toBe(true);
    expect(DEFAULT_SECURE_SETTINGS.disableQuestionTextSelection).toBe(true);
    expect(DEFAULT_SECURE_SETTINGS.enforceFullscreenReturn).toBe(false);
  });

  it("parses camera settings supplied by a lecturer", () => {
    const result = parseSecureSettings({
      requireCamera: true,
      cameraHeartbeatEnabled: true,
      cameraHeartbeatIntervalSeconds: 45,
    });
    expect(result.requireCamera).toBe(true);
    expect(result.cameraHeartbeatEnabled).toBe(true);
    expect(result.cameraHeartbeatIntervalSeconds).toBe(45);
  });

  it("parses browser-friction settings supplied by a lecturer", () => {
    const result = parseSecureSettings({
      blockKeyboardShortcuts: false,
      disableQuestionTextSelection: false,
      enforceFullscreenReturn: true,
    });
    expect(result.blockKeyboardShortcuts).toBe(false);
    expect(result.disableQuestionTextSelection).toBe(false);
    expect(result.enforceFullscreenReturn).toBe(true);
  });

  it("rejects an out-of-range camera heartbeat interval and falls back to defaults", () => {
    expect(parseSecureSettings({ cameraHeartbeatIntervalSeconds: 5 })).toEqual(
      DEFAULT_SECURE_SETTINGS,
    );
    expect(parseSecureSettings({ cameraHeartbeatIntervalSeconds: 1000 })).toEqual(
      DEFAULT_SECURE_SETTINGS,
    );
  });

  it("does not require Canvas or AI configuration for any secure setting default", () => {
    const keys = Object.keys(DEFAULT_SECURE_SETTINGS);
    expect(keys.some((k) => /canvas|lti|anthropic|^ai/i.test(k))).toBe(false);
  });
});

describe("Exam Watermark v1 (enableExamWatermark)", () => {
  it("1/2. parses enableExamWatermark and defaults to false", () => {
    expect(DEFAULT_SECURE_SETTINGS.enableExamWatermark).toBe(false);
    expect(parseSecureSettings(null).enableExamWatermark).toBe(false);
    expect(parseSecureSettings({}).enableExamWatermark).toBe(false);
  });

  it("2. defaults to false uniformly for both a brand-new exam and a pre-existing exam missing the key", () => {
    // Simulates an exam saved before this setting existed — the raw JSON
    // simply has no enableExamWatermark key at all.
    const legacySettings = { secureModeEnabled: true, requireCamera: true };
    expect(parseSecureSettings(legacySettings).enableExamWatermark).toBe(false);
  });

  it("3. a lecturer can explicitly enable it via parseSecureSettings", () => {
    const result = parseSecureSettings({ secureModeEnabled: true, enableExamWatermark: true });
    expect(result.enableExamWatermark).toBe(true);
  });

  it("has no effect on other settings when toggled", () => {
    const result = parseSecureSettings({ enableExamWatermark: true });
    expect(result.blockCopyPaste).toBe(DEFAULT_SECURE_SETTINGS.blockCopyPaste);
    expect(result.requireCamera).toBe(DEFAULT_SECURE_SETTINGS.requireCamera);
  });

  it("appears in activeSafeExamControlLabels only when both secureModeEnabled and enableExamWatermark are true", () => {
    expect(
      activeSafeExamControlLabels({
        ...DEFAULT_SECURE_SETTINGS,
        secureModeEnabled: true,
        enableExamWatermark: true,
      }),
    ).toContain("Exam watermark enabled");
    expect(
      activeSafeExamControlLabels({
        ...DEFAULT_SECURE_SETTINGS,
        secureModeEnabled: false,
        enableExamWatermark: true,
      }),
    ).not.toContain("Exam watermark enabled");
    expect(
      activeSafeExamControlLabels({
        ...DEFAULT_SECURE_SETTINGS,
        secureModeEnabled: true,
        enableExamWatermark: false,
      }),
    ).not.toContain("Exam watermark enabled");
  });
});

describe("safe exam mode UI helpers", () => {
  it("labels safe mode status clearly as enabled or disabled", () => {
    expect(safeExamModeStatusLabel({ ...DEFAULT_SECURE_SETTINGS, secureModeEnabled: true })).toBe(
      "Safe Exam Mode: Enabled",
    );
    expect(safeExamModeStatusLabel({ ...DEFAULT_SECURE_SETTINGS, secureModeEnabled: false })).toBe(
      "Safe Exam Mode: Disabled",
    );
  });

  it("lists active safe mode controls only when safe mode is enabled", () => {
    expect(
      activeSafeExamControlLabels({
        ...DEFAULT_SECURE_SETTINGS,
        secureModeEnabled: true,
        requireCamera: true,
        requireFullscreen: true,
        requireStudentVerification: true,
        enableAiCameraIntegrityChecks: true,
      }),
    ).toEqual([
      "Camera required",
      "Full screen required",
      "Student verification required",
      "AI camera checks enabled",
    ]);
    expect(
      activeSafeExamControlLabels({
        ...DEFAULT_SECURE_SETTINGS,
        secureModeEnabled: false,
        requireCamera: true,
        requireFullscreen: true,
      }),
    ).toEqual([]);
  });

  it("detects unsaved safe exam changes independently of question saves", () => {
    const saved = { ...DEFAULT_SECURE_SETTINGS, secureModeEnabled: false };
    const draft = { ...saved, secureModeEnabled: true };
    expect(secureSettingsChanged(saved, draft)).toBe(true);
    expect(secureSettingsChanged(saved, { ...saved })).toBe(false);
  });
});
