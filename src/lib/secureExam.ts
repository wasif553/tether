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

  // --- Camera Monitoring v1 (additive, see docs/secure-exam-threat-model.md) ---
  requireCamera: z.boolean().default(false),
  showCameraPreview: z.boolean().default(true),
  cameraHeartbeatEnabled: z.boolean().default(false),
  cameraHeartbeatIntervalSeconds: z.number().int().min(10).max(300).default(30),
  recordCameraUnavailableEvents: z.boolean().default(true),

  // --- Browser-Level Friction v1 (additive) ---
  // blockCopyPaste/blockRightClick above are reused for friction blocking
  // (not just logging severity) — see severityFor() and the student exam
  // page's event handlers.
  blockKeyboardShortcuts: z.boolean().default(true),
  disableQuestionTextSelection: z.boolean().default(true),
  enforceFullscreenReturn: z.boolean().default(false),

  // --- Optional Student Verification + On-Device AI Camera Integrity
  // Detection v1 (additive) — see
  // docs/on-device-ai-integrity-detection-v1.md. Both default to off;
  // neither weakens or replaces requireCamera/showCameraPreview above.
  // This is NOT live proctoring — nothing here streams, records, or
  // stores video/images. requireStudentVerification only shows a
  // one-time confirmation step before the exam starts;
  // enableAiCameraIntegrityChecks only runs local, on-device checks
  // against the same camera stream already used for the preview.
  requireStudentVerification: z.boolean().default(false),
  enableAiCameraIntegrityChecks: z.boolean().default(false),

  // --- On-Device AI Camera Integrity Detection v1 — Evidence Frames
  // (additive, opt-in) — see docs/on-device-ai-integrity-detection-v1.md.
  // Defaults to false — never silently enabled for existing exams. When
  // true, a single low-resolution webcam still frame is captured only for
  // a backend-logged POSSIBLE_PHONE_VISIBLE or
  // POSSIBLE_SECOND_PERSON_VISIBLE event (never for no-person/blocked/
  // dark/unavailable in v1, never a video, never the exam screen). Has no
  // effect at all unless enableAiCameraIntegrityChecks is also true.
  captureAiViolationEvidence: z.boolean().default(false),

  // --- Exam Watermark v1 (additive, opt-in) — see
  // docs/exam-watermark-v1.md. A visible, low-opacity, non-disruptive
  // deterrent overlay on the question content area (student identifier +
  // attempt id + timestamp + AI-aware wording) to discourage screenshots/
  // photos/sharing and discourage AI tools from answering shared exam
  // content. Deliberately defaults to false uniformly, exactly like
  // captureAiViolationEvidence/enableAiCameraIntegrityChecks above —
  // parseSecureSettings() merges this same default in for both a
  // brand-new exam and a pre-existing exam saved before this setting
  // existed, so there is no way to distinguish "new" from "old" at parse
  // time; forcing it on for new exams only would require exam-creation-
  // specific logic this schema/merge pattern doesn't have. A lecturer
  // must explicitly opt in either way. Has no effect unless
  // secureModeEnabled is also true (see the student exam page, which
  // never renders the watermark outside Secure Exam Mode).
  enableExamWatermark: z.boolean().default(false),

  // --- One-Question-At-A-Time Exam Delivery v1 (additive, opt-in) — see
  // docs/one-question-delivery-v1.md. When oneQuestionAtATime is true, the
  // student receives only the current question from the server, not the
  // full exam paper — see src/lib/questionDelivery.ts and the
  // GET/POST /api/submissions/[id]/question(-progress) routes. The three
  // fields below only take effect when oneQuestionAtATime is true.
  // Defaults to false — this is a delivery-mode change, not a passive
  // logging feature, so it must never silently change how an existing
  // exam is presented to students.
  oneQuestionAtATime: z.boolean().default(false),
  // Defaults to true: most lecturers expect students to be able to
  // review/change earlier answers, exactly like the existing (non-
  // one-question) exam experience already allows. A lecturer who wants
  // forward-only navigation must explicitly turn this off.
  allowBackNavigation: z.boolean().default(true),
  // A stable (not re-shuffled on refresh) per-submission question order,
  // generated once at attempt start and persisted in
  // Submission.questionOrderJson.
  randomiseQuestionOrder: z.boolean().default(false),
  // A stable per-submission, per-question MCQ option display order.
  // Safe to randomise independently of grading: the stored Answer.response
  // is always the option's text value (see the submit route's
  // case-insensitive string comparison against Question.correctAnswer),
  // never a positional index, so shuffling display order never affects
  // scoring.
  randomiseMcqOptionOrder: z.boolean().default(false),

  // --- Question Pools v1 (additive, opt-in) — see
  // docs/question-pools-v1.md. When enabled with
  // questionPoolSelectionMode "DRAW_FROM_POOLS", each student attempt
  // draws a random, per-submission-stable subset of questions from each
  // QuestionPool (plus every unpooled question) at attempt start — see
  // buildSelectedQuestionIds() in src/lib/questionDelivery.ts. Defaults
  // to false/"ALL_QUESTIONS" — never silently changes which questions an
  // existing exam shows.
  enableQuestionPools: z.boolean().default(false),
  // A string enum rather than a second boolean: "has pools" and "is
  // actually drawing a subset" are different questions (a lecturer may
  // want to define pools without turning on drawing yet), and this keeps
  // the two independently toggleable without a confusing
  // enableQuestionPools-implies-nothing-until-a-second-flag-is-also-true
  // relationship.
  questionPoolSelectionMode: z.enum(["ALL_QUESTIONS", "DRAW_FROM_POOLS"]).default("ALL_QUESTIONS"),

  // --- Exam Design Policy v1 (additive) — see docs/exam-design-policy-v1.md.
  // Kept inside this same JSON structure rather than new Exam columns —
  // these are settings, exactly like everything else here. Defaults to
  // CUSTOM + everything disallowed so an EXISTING exam's behaviour never
  // changes and is never retroactively assumed to be closed-book (see
  // parseSecureSettings' merge-with-defaults behaviour below, and
  // docs/exam-design-policy-v1.md "Legacy-attempt behaviour").
  examMode: z.enum(["CLOSED_BOOK", "OPEN_BOOK", "CUSTOM"]).default("CUSTOM"),
  calculatorAllowed: z.boolean().default(false),
  notesAllowed: z.boolean().default(false),
  internetAllowed: z.boolean().default(false),
  aiToolsAllowed: z.boolean().default(false),

  // --- Question Navigator v1 (additive, opt-in) — see
  // docs/question-navigator-v1.md. Defaults preserve the exact existing
  // interface/behaviour for every current exam: no navigator shown, no
  // direct jumping (only sequential Next/Previous, as today), flagging
  // defaults ON since it is purely a student workflow convenience with
  // no navigation-security implications.
  showQuestionNavigator: z.boolean().default(false),
  allowQuestionJumping: z.boolean().default(false),
  allowFlagForReview: z.boolean().default(true),

  // --- Controlled AI Brainstorming Assistance v1 (additive, opt-in) —
  // see docs/controlled-ai-brainstorming-assistance-v1.md. An ALLOWED
  // assessment resource, not an integrity violation — see
  // src/lib/aiAssistancePolicy.ts for the full policy/limit logic and
  // src/lib/aiAssistanceRunner.ts for the generator/verifier pipeline
  // that actually enforces it. Defaults are conservative and disabled:
  // no existing exam's behaviour changes unless a lecturer explicitly
  // opts in. All later assistance decisions for an in-progress attempt
  // must use the immutable Submission.aiAssistancePolicySnapshotJson
  // taken at attempt start, never these live settings directly.
  aiAssistanceMode: z.enum(["DISABLED", "BRAINSTORM_ONLY"]).default("DISABLED"),
  aiAssistanceMaxPromptsPerQuestion: z.number().int().min(1).max(20).default(3),
  aiAssistanceMaxPromptsPerAttempt: z.number().int().min(1).max(100).default(10),
  aiAssistanceMaxResponseCharacters: z.number().int().min(200).max(4000).default(800),
  aiAssistanceAllowConceptExplanations: z.boolean().default(true),
  aiAssistanceAllowAnswerPlanning: z.boolean().default(true),
  aiAssistanceAllowReasoningFeedback: z.boolean().default(true),
  aiAssistanceAllowProgrammingConceptHelp: z.boolean().default(true),
});

export type SecureExamSettings = z.infer<typeof secureExamSettingsSchema>;

/** Controlled AI Brainstorming Assistance v1 — see docs/controlled-ai-brainstorming-assistance-v1.md. */
export type AiAssistanceMode = SecureExamSettings["aiAssistanceMode"];

/**
 * Single source of truth for "is question-pool drawing actually active"
 * — used by every server route that needs to decide whether to resolve a
 * submission's question set via the pool-selection path
 * (resolveSelectedQuestionIds) or the plain path (resolveQuestionOrder).
 * See docs/question-pools-v1.md.
 */
export function questionPoolsActive(
  settings: Pick<SecureExamSettings, "enableQuestionPools" | "questionPoolSelectionMode">,
): boolean {
  return settings.enableQuestionPools && settings.questionPoolSelectionMode === "DRAW_FROM_POOLS";
}

export const DEFAULT_SECURE_SETTINGS: SecureExamSettings = secureExamSettingsSchema.parse({});

/** Merges stored settings (possibly partial/legacy) with current defaults. */
export function parseSecureSettings(raw: unknown): SecureExamSettings {
  if (raw == null || typeof raw !== "object") return { ...DEFAULT_SECURE_SETTINGS };
  const merged = { ...DEFAULT_SECURE_SETTINGS, ...(raw as Record<string, unknown>) };
  const result = secureExamSettingsSchema.safeParse(merged);
  return result.success ? result.data : { ...DEFAULT_SECURE_SETTINGS };
}

export const secureSettingsInputSchema = secureExamSettingsSchema.partial();

export function safeExamModeStatusLabel(settings: Pick<SecureExamSettings, "secureModeEnabled">): string {
  return settings.secureModeEnabled ? "Safe Exam Mode: Enabled" : "Safe Exam Mode: Disabled";
}

export function activeSafeExamControlLabels(
  settings: Pick<
    SecureExamSettings,
    | "secureModeEnabled"
    | "requireCamera"
    | "requireFullscreen"
    | "requireStudentVerification"
    | "enableAiCameraIntegrityChecks"
    | "enableExamWatermark"
    | "oneQuestionAtATime"
  >,
): string[] {
  if (!settings.secureModeEnabled) return [];
  return [
    settings.requireCamera ? "Camera required" : null,
    settings.requireFullscreen ? "Full screen required" : null,
    settings.requireStudentVerification ? "Student verification required" : null,
    settings.enableAiCameraIntegrityChecks ? "AI camera checks enabled" : null,
    settings.enableExamWatermark ? "Exam watermark enabled" : null,
    settings.oneQuestionAtATime ? "One question at a time" : null,
  ].filter((label): label is string => label != null);
}

export function secureSettingsChanged(
  saved: unknown,
  draft: unknown,
): boolean {
  return JSON.stringify(saved) !== JSON.stringify(draft);
}

export type IntegritySeverityLevel = "INFO" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Settings-driven severity defaults (Part 4 of Secure Exam Mode v1).
 * Mirrors the event types already defined on IntegrityEventType.
 */
export type IntegrityEventTypeName =
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
  | "SUBMIT_AFTER_DEADLINE"
  | "CAMERA_PERMISSION_GRANTED"
  | "CAMERA_PERMISSION_DENIED"
  | "CAMERA_STARTED"
  | "CAMERA_STOPPED"
  | "CAMERA_UNAVAILABLE"
  | "CAMERA_HEARTBEAT_MISSED"
  | "CAMERA_PRECHECK_FAILED"
  | "KEYBOARD_SHORTCUT_BLOCKED"
  | "FULLSCREEN_FORCED_RETURN"
  | "STUDENT_VERIFICATION_CONFIRMED"
  | "POSSIBLE_PHONE_VISIBLE"
  | "POSSIBLE_SECOND_PERSON_VISIBLE"
  | "NO_PERSON_VISIBLE"
  | "CAMERA_VIEW_BLOCKED"
  | "CAMERA_TOO_DARK"
  | "AI_CAMERA_CHECK_UNAVAILABLE"
  // --- One-Question-At-A-Time Exam Delivery v1 — see
  // docs/one-question-delivery-v1.md.
  | "QUESTION_NAVIGATED_NEXT"
  | "QUESTION_NAVIGATED_PREVIOUS"
  | "QUESTION_BACK_NAVIGATION_BLOCKED"
  // --- Question Navigator v1 — see docs/question-navigator-v1.md.
  | "QUESTION_NAVIGATED_DIRECT"
  | "QUESTION_DIRECT_NAVIGATION_BLOCKED"
  // --- Controlled AI Brainstorming Assistance v1 — see
  // docs/controlled-ai-brainstorming-assistance-v1.md.
  | "AI_ASSISTANCE_USED"
  | "AI_ASSISTANCE_REQUEST_BLOCKED"
  | "AI_ASSISTANCE_LIMIT_REACHED"
  | "AI_ASSISTANCE_RESPONSE_REGENERATED";

export function severityFor(
  eventType: IntegrityEventTypeName,
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
    // --- Camera Monitoring v1 ---
    case "CAMERA_PERMISSION_GRANTED":
    case "CAMERA_STARTED":
      return "INFO";
    case "CAMERA_PERMISSION_DENIED":
    case "CAMERA_STOPPED":
    case "CAMERA_PRECHECK_FAILED":
      return settings.requireCamera ? "HIGH" : "MEDIUM";
    case "CAMERA_UNAVAILABLE":
      return settings.requireCamera ? "HIGH" : "MEDIUM";
    case "CAMERA_HEARTBEAT_MISSED":
      return "MEDIUM";
    // --- Browser-Level Friction v1 ---
    case "KEYBOARD_SHORTCUT_BLOCKED":
      // INFO so the risk-weight table (src/lib/integrityRisk.ts) gives it
      // a weight of 0 — these can fire often and must never dominate risk.
      return "INFO";
    case "FULLSCREEN_FORCED_RETURN":
      // LOW so it contributes the minimum non-zero weight (1).
      return "LOW";
    // --- Optional Student Verification + On-Device AI Camera Integrity
    // Detection v1 — see docs/on-device-ai-integrity-detection-v1.md.
    // Confirmation and "unavailable" states must never increase risk;
    // repeated occurrences of the same signal already accumulate risk
    // naturally through src/lib/integrityRisk.ts summing severity
    // weights across events, so no per-type escalation logic is added
    // here — keeps the model simple and conservative by construction.
    case "STUDENT_VERIFICATION_CONFIRMED":
      return "INFO";
    case "POSSIBLE_PHONE_VISIBLE":
      return "MEDIUM";
    case "POSSIBLE_SECOND_PERSON_VISIBLE":
      return "MEDIUM";
    case "NO_PERSON_VISIBLE":
      return "MEDIUM";
    case "CAMERA_VIEW_BLOCKED":
      return "MEDIUM";
    case "CAMERA_TOO_DARK":
      // Deliberately lower weight than phone/second-person signals —
      // a dark room is far more likely to be an innocent lighting issue.
      return "LOW";
    case "AI_CAMERA_CHECK_UNAVAILABLE":
      return "INFO";
    // --- One-Question-At-A-Time Exam Delivery v1 — see
    // docs/one-question-delivery-v1.md. Routine, expected navigation
    // never raises risk; a blocked back-navigation attempt is a mild,
    // non-zero signal (mirrors FULLSCREEN_FORCED_RETURN's LOW) but must
    // never dominate risk on its own — a student clicking a disabled
    // control is not itself suspicious.
    case "QUESTION_NAVIGATED_NEXT":
    case "QUESTION_NAVIGATED_PREVIOUS":
      return "INFO";
    case "QUESTION_BACK_NAVIGATION_BLOCKED":
      return "LOW";
    // --- Question Navigator v1 — see docs/question-navigator-v1.md.
    // Direct navigation is never itself suspicious when the exam's
    // settings permit it — same INFO/LOW pattern as the sequential
    // events above. A blocked attempt is a mild, non-zero signal
    // (a student clicking/requesting a disallowed jump is not itself
    // suspicious — it may just be an unfamiliar UI).
    case "QUESTION_NAVIGATED_DIRECT":
      return "INFO";
    case "QUESTION_DIRECT_NAVIGATION_BLOCKED":
      return "LOW";
    // --- Controlled AI Brainstorming Assistance v1 — see
    // docs/controlled-ai-brainstorming-assistance-v1.md. This is an
    // ALLOWED assessment resource, not an integrity violation — every
    // event here is INFO (weight 0, see src/lib/integrityRisk.ts) so
    // permitted use, blocked requests, limit-reached notices and
    // stricter-regeneration outcomes can NEVER increase a student's
    // integrity risk score, no matter how often they occur.
    case "AI_ASSISTANCE_USED":
    case "AI_ASSISTANCE_REQUEST_BLOCKED":
    case "AI_ASSISTANCE_LIMIT_REACHED":
    case "AI_ASSISTANCE_RESPONSE_REGENERATED":
      return "INFO";
  }
}
