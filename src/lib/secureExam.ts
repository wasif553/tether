import { z } from "zod";

export const secureExamSettingsSchema = z.object({
  secureModeEnabled: z.boolean().default(false),
  requireFullscreen: z.boolean().default(false),
  blockCopyPaste: z.boolean().default(true),
  blockRightClick: z.boolean().default(true),
  trackWindowBlur: z.boolean().default(true),
  maxBlurEvents: z.number().int().positive().nullable().default(null),
  maxFullscreenExits: z.number().int().positive().nullable().default(null),
  autoSubmitOnTimerEnd: z.boolean().default(true),
  allowLateSubmit: z.boolean().default(false),
  // v1 only enforces a value of 1 — see docs/secure-exam-threat-model.md
  // ("Known v1 limitation: attempt limits"). The field exists so the
  // schema/UI are forward-compatible with multi-attempt support later.
  maxAttempts: z.number().int().positive().default(1),
  showIntegrityWarningToStudent: z.boolean().default(true),
});

export type SecureExamSettings = z.infer<typeof secureExamSettingsSchema>;

export const DEFAULT_SECURE_SETTINGS: SecureExamSettings = secureExamSettingsSchema.parse({});

/** Merges stored settings (possibly partial/legacy) with current defaults. */
export function parseSecureSettings(raw: unknown): SecureExamSettings {
  if (raw == null || typeof raw !== "object") return { ...DEFAULT_SECURE_SETTINGS };
  const merged = { ...DEFAULT_SECURE_SETTINGS, ...(raw as Record<string, unknown>) };
  const result = secureExamSettingsSchema.safeParse(merged);
  return result.success ? result.data : { ...DEFAULT_SECURE_SETTINGS };
}

export const secureSettingsInputSchema = secureExamSettingsSchema.partial();

export type IntegritySeverityLevel = "INFO" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Settings-driven severity defaults (Part 4 of Secure Exam Mode v1).
 * Mirrors the event types already defined on IntegrityEventType.
 */
export function severityFor(
  eventType:
    | "FULLSCREEN_EXIT"
    | "WINDOW_BLUR"
    | "WINDOW_FOCUS_RETURN"
    | "COPY_ATTEMPT"
    | "PASTE_ATTEMPT"
    | "RIGHT_CLICK_ATTEMPT"
    | "NETWORK_OFFLINE"
    | "NETWORK_ONLINE"
    | "AUTOSAVE_FAILED"
    | "TIMER_EXPIRED"
    | "SUBMIT_AFTER_DEADLINE",
  settings: SecureExamSettings,
): IntegritySeverityLevel {
  switch (eventType) {
    case "FULLSCREEN_EXIT":
      return settings.requireFullscreen ? "HIGH" : "MEDIUM";
    case "WINDOW_BLUR":
      return "MEDIUM";
    case "WINDOW_FOCUS_RETURN":
      return "INFO";
    case "COPY_ATTEMPT":
    case "PASTE_ATTEMPT":
      return settings.blockCopyPaste ? "MEDIUM" : "LOW";
    case "RIGHT_CLICK_ATTEMPT":
      return settings.blockRightClick ? "MEDIUM" : "LOW";
    case "NETWORK_OFFLINE":
      return "MEDIUM";
    case "NETWORK_ONLINE":
      return "INFO";
    case "AUTOSAVE_FAILED":
      return "MEDIUM";
    case "TIMER_EXPIRED":
    case "SUBMIT_AFTER_DEADLINE":
      return "HIGH";
  }
}
