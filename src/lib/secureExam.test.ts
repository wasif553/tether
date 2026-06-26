import { describe, expect, it } from "vitest";
import { DEFAULT_SECURE_SETTINGS, parseSecureSettings, severityFor } from "./secureExam";

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
});
