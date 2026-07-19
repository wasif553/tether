/**
 * Exam Design Policy v1 — pure exam-policy module. See
 * docs/exam-design-policy-v1.md.
 *
 * Pure, dependency-free, deterministic: no Prisma, no Next.js, no
 * browser APIs, no environment variables, no external services.
 * Everything here is either a derived, explainable profile for a
 * lecturer/student to read, or an explainable per-signal POLICY
 * INTERPRETATION for a human lecturer to weigh — never an automatic
 * misconduct determination. "Activity was permitted under this exam
 * policy" / "Activity was inconsistent with this exam policy" are review
 * observations, never proof.
 */

export const EXAM_POLICY_VERSION = "v1.0";
/** Bumped only if the snapshot's shape changes in a way old snapshots can't be read as. */
export const EXAM_POLICY_SNAPSHOT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Core policy types
// ---------------------------------------------------------------------------

export const EXAM_MODES = ["CLOSED_BOOK", "OPEN_BOOK", "CUSTOM"] as const;
export type ExamMode = (typeof EXAM_MODES)[number];

export const EXAM_MODE_LABELS: Record<ExamMode, string> = {
  CLOSED_BOOK: "Closed-book",
  OPEN_BOOK: "Open-book",
  CUSTOM: "Custom",
};

export type PermittedResources = {
  calculatorAllowed: boolean;
  notesAllowed: boolean;
  internetAllowed: boolean;
  aiToolsAllowed: boolean;
};

export type ExamPolicy = { examMode: ExamMode } & PermittedResources;

export const DEFAULT_EXAM_POLICY: ExamPolicy = {
  examMode: "CUSTOM",
  calculatorAllowed: false,
  notesAllowed: false,
  internetAllowed: false,
  aiToolsAllowed: false,
};

/** Only the secure-settings fields the policy engine actually reasons about. */
export type RelevantSecureSettings = {
  secureModeEnabled: boolean;
  requireFullscreen: boolean;
  blockCopyPaste: boolean;
  trackWindowBlur: boolean;
  requireCamera: boolean;
  enableAiCameraIntegrityChecks: boolean;
};

// ---------------------------------------------------------------------------
// Part 4 — Policy profiles / presets
// ---------------------------------------------------------------------------

export type ExamModePreset = {
  resources: PermittedResources;
  /** Only the fields this preset has an opinion on — never forces every secure-control field. */
  recommendedSecureControls: Partial<RelevantSecureSettings>;
  description: string;
};

/**
 * CLOSED_BOOK proposes every resource OFF and recommends (never forces)
 * stronger secure controls. OPEN_BOOK proposes notes/calculator ON but
 * deliberately leaves internet/AI tools OFF — open-book must never
 * automatically imply internet or AI tools are allowed. CUSTOM has no
 * preset at all — every field stays exactly as the lecturer set it.
 */
export function getExamModePreset(mode: ExamMode): ExamModePreset | null {
  switch (mode) {
    case "CLOSED_BOOK":
      return {
        resources: { calculatorAllowed: false, notesAllowed: false, internetAllowed: false, aiToolsAllowed: false },
        recommendedSecureControls: { requireFullscreen: true, blockCopyPaste: true, trackWindowBlur: true },
        description:
          "Students must complete the assessment without unauthorised external resources. Stronger secure-exam controls are recommended.",
      };
    case "OPEN_BOOK":
      return {
        resources: { calculatorAllowed: true, notesAllowed: true, internetAllowed: false, aiToolsAllowed: false },
        recommendedSecureControls: {},
        description:
          "Students may use only the resources explicitly permitted below. Answer originality and application remain subject to review.",
      };
    case "CUSTOM":
      return null;
  }
}

/**
 * True when the current resources contradict what CLOSED_BOOK/OPEN_BOOK
 * would normally mean, in which case the UI/derived profile should treat
 * the policy as effectively CUSTOM (Part 5: "This combination is treated
 * as a custom policy because internet access is enabled."). Never
 * silently rewrites the lecturer's stored examMode — this only affects
 * how the profile/interpretation logic below reasons about it.
 */
export function effectiveExamMode(policy: ExamPolicy): ExamMode {
  if (policy.examMode === "CLOSED_BOOK" && policy.internetAllowed) return "CUSTOM";
  return policy.examMode;
}

// ---------------------------------------------------------------------------
// Part 5 — Policy consistency warnings (advisory only, never blocking)
// ---------------------------------------------------------------------------

export const POLICY_WARNING_CODES = [
  "CLOSED_BOOK_WITH_INTERNET",
  "CLOSED_BOOK_WITH_AI_TOOLS",
  "INTERNET_WITH_STRICT_FULLSCREEN",
  "AI_TOOLS_WITHOUT_INTERNET",
  "NOTES_WITH_CAMERA_MONITORING",
  "CALCULATOR_ALLOWED_CAMERA_LIMITATION",
] as const;
export type PolicyWarningCode = (typeof POLICY_WARNING_CODES)[number];

export type PolicyWarning = { code: PolicyWarningCode; message: string };

/**
 * Generates explainable, advisory-only warnings. Never blocks
 * publication — the existing app has no validation-blocking convention
 * for this kind of configuration choice, and this feature does not
 * introduce one.
 */
export function validateExamPolicy(policy: ExamPolicy, secureSettings: RelevantSecureSettings): PolicyWarning[] {
  const warnings: PolicyWarning[] = [];

  if (policy.examMode === "CLOSED_BOOK" && policy.internetAllowed) {
    warnings.push({
      code: "CLOSED_BOOK_WITH_INTERNET",
      message: "This combination is treated as a custom policy because internet access is enabled.",
    });
  }
  if (policy.examMode === "CLOSED_BOOK" && policy.aiToolsAllowed) {
    warnings.push({
      code: "CLOSED_BOOK_WITH_AI_TOOLS",
      message: "AI tools are enabled for an otherwise closed-book exam. Review the policy before publishing.",
    });
  }
  if (policy.internetAllowed && secureSettings.requireFullscreen) {
    warnings.push({
      code: "INTERNET_WITH_STRICT_FULLSCREEN",
      message:
        "Students may need to leave the exam page to access permitted internet resources. Strict fullscreen enforcement may conflict with this policy.",
    });
  }
  if (policy.aiToolsAllowed && !policy.internetAllowed) {
    warnings.push({
      code: "AI_TOOLS_WITHOUT_INTERNET",
      message: "Confirm how students will access the permitted AI tool, such as through an institution-managed service.",
    });
  }
  if (policy.notesAllowed && (secureSettings.requireCamera || secureSettings.enableAiCameraIntegrityChecks)) {
    warnings.push({
      code: "NOTES_WITH_CAMERA_MONITORING",
      message: "Looking away from the screen may be consistent with consulting permitted notes.",
    });
  }
  if (policy.calculatorAllowed) {
    warnings.push({
      code: "CALCULATOR_ALLOWED_CAMERA_LIMITATION",
      message:
        "The application cannot reliably distinguish a permitted physical calculator from another handheld device using camera evidence alone.",
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Secure-control summary labels — single source of truth for both the
// lecturer publication summary (Part 6) and the derived profile below.
// ---------------------------------------------------------------------------

export function expectedSecureControlLabels(secureSettings: RelevantSecureSettings): string[] {
  const labels: string[] = [];
  if (secureSettings.requireFullscreen) labels.push("Fullscreen required");
  if (secureSettings.blockCopyPaste) labels.push("Clipboard restricted");
  if (secureSettings.trackWindowBlur) labels.push("Tab changes reviewed");
  if (secureSettings.requireCamera || secureSettings.enableAiCameraIntegrityChecks) labels.push("Camera checks enabled");
  return labels;
}

/** Same underlying booleans, second-person present-tense wording for the student acknowledgement screen (Part 7). */
export function studentSecureControlStatements(secureSettings: RelevantSecureSettings): string[] {
  const labels: string[] = [];
  if (secureSettings.requireFullscreen) labels.push("Fullscreen is required");
  if (secureSettings.blockCopyPaste) labels.push("Clipboard actions are restricted");
  if (secureSettings.trackWindowBlur) labels.push("Tab changes are reviewed");
  if (secureSettings.requireCamera || secureSettings.enableAiCameraIntegrityChecks)
    labels.push("Camera integrity checks are enabled");
  return labels;
}

function resourceLists(policy: PermittedResources, internetLabel: string): { allowed: string[]; notAllowed: string[] } {
  const allowed: string[] = [];
  const notAllowed: string[] = [];
  (policy.calculatorAllowed ? allowed : notAllowed).push("Calculator");
  (policy.notesAllowed ? allowed : notAllowed).push("Notes");
  (policy.internetAllowed ? allowed : notAllowed).push(internetLabel);
  (policy.aiToolsAllowed ? allowed : notAllowed).push("AI tools");
  return { allowed, notAllowed };
}

// ---------------------------------------------------------------------------
// Part 3 — deriveExamIntegrityProfile
// ---------------------------------------------------------------------------

export const SIGNAL_CATEGORIES = [
  "FOCUS_TAB",
  "CLIPBOARD",
  "CAMERA_PRESENCE",
  "SESSION_DEVICE",
  "ANSWER_SIMILARITY",
  "AI_USE",
  "TIMING",
] as const;
export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];

export type ExamIntegrityProfile = {
  examMode: ExamMode;
  /** examMode as actually interpreted once contradictions are accounted for — see effectiveExamMode(). */
  effectiveExamMode: ExamMode;
  permittedResources: PermittedResources;
  expectedSecureControls: string[];
  applicableSignalCategories: SignalCategory[];
  suppressedOrDowngradedCategories: SignalCategory[];
  reviewEmphasis: string[];
  warnings: PolicyWarning[];
  versionIdentifier: string;
};

const OPEN_BOOK_REVIEW_EMPHASIS = [
  "Answer originality",
  "Answer similarity",
  "Scenario application",
  "Attribution",
  "Account and session continuity",
  "Oral verification where warranted",
];
const CLOSED_BOOK_REVIEW_EMPHASIS = [
  "Focus and tab changes",
  "Clipboard activity",
  "Session and device continuity",
  "Unauthorised-resource signals",
];

export function deriveExamIntegrityProfile(policy: ExamPolicy, secureSettings: RelevantSecureSettings): ExamIntegrityProfile {
  const effective = effectiveExamMode(policy);
  const warnings = validateExamPolicy(policy, secureSettings);

  // Session/device continuity, answer similarity, and timing remain
  // relevant under every policy (Part 9). Clipboard is always applicable
  // — it is a secure-control matter, not a permitted-resource matter.
  // AI-use signals stay visible for answer-quality review regardless of
  // aiToolsAllowed, but are never treated as a policy breach — see
  // classifyIntegritySignalForPolicy and the recommendation layer.
  const applicableSignalCategories: SignalCategory[] = [
    "CLIPBOARD",
    "CAMERA_PRESENCE",
    "SESSION_DEVICE",
    "ANSWER_SIMILARITY",
    "AI_USE",
    "TIMING",
    "FOCUS_TAB",
  ];
  const suppressedOrDowngradedCategories: SignalCategory[] = policy.internetAllowed ? ["FOCUS_TAB"] : [];

  const reviewEmphasis = policy.internetAllowed || effective === "OPEN_BOOK" ? OPEN_BOOK_REVIEW_EMPHASIS : CLOSED_BOOK_REVIEW_EMPHASIS;

  return {
    examMode: policy.examMode,
    effectiveExamMode: effective,
    permittedResources: {
      calculatorAllowed: policy.calculatorAllowed,
      notesAllowed: policy.notesAllowed,
      internetAllowed: policy.internetAllowed,
      aiToolsAllowed: policy.aiToolsAllowed,
    },
    expectedSecureControls: expectedSecureControlLabels(secureSettings),
    applicableSignalCategories,
    suppressedOrDowngradedCategories,
    reviewEmphasis,
    warnings,
    versionIdentifier: EXAM_POLICY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Part 6 — lecturer-facing publication summary
// ---------------------------------------------------------------------------

export type LecturerExamPolicySummary = {
  examModeLabel: string;
  allowed: string[];
  notAllowed: string[];
  secureControls: string[];
  warnings: PolicyWarning[];
};

export function buildLecturerExamPolicySummary(policy: ExamPolicy, secureSettings: RelevantSecureSettings): LecturerExamPolicySummary {
  const { allowed, notAllowed } = resourceLists(policy, "Internet");
  return {
    examModeLabel: `${EXAM_MODE_LABELS[policy.examMode]} exam`,
    allowed,
    notAllowed,
    secureControls: expectedSecureControlLabels(secureSettings),
    warnings: validateExamPolicy(policy, secureSettings),
  };
}

// ---------------------------------------------------------------------------
// Part 8 — immutable attempt-policy snapshot
// ---------------------------------------------------------------------------

export type ExamPolicySnapshot = {
  schemaVersion: number;
  policyVersion: string;
  examMode: ExamMode;
  calculatorAllowed: boolean;
  notesAllowed: boolean;
  internetAllowed: boolean;
  aiToolsAllowed: boolean;
  secureSettings: RelevantSecureSettings;
  derivedProfile: ExamIntegrityProfile;
  studentAcknowledgedAt: string;
  snapshotCreatedAt: string;
};

/**
 * Builds the immutable snapshot recorded once at attempt start. Contains
 * no secrets, no correct answers, no hidden question-pool contents, no
 * session-binding hashes, no IP information, and no reviewer comments —
 * only policy fields, the relevant secure-settings subset, and the
 * derived profile, exactly as they existed at that moment.
 */
export function buildExamPolicySnapshot(
  policy: ExamPolicy,
  secureSettings: RelevantSecureSettings,
  studentAcknowledgedAt: Date,
  now: Date,
): ExamPolicySnapshot {
  return {
    schemaVersion: EXAM_POLICY_SNAPSHOT_SCHEMA_VERSION,
    policyVersion: EXAM_POLICY_VERSION,
    examMode: policy.examMode,
    calculatorAllowed: policy.calculatorAllowed,
    notesAllowed: policy.notesAllowed,
    internetAllowed: policy.internetAllowed,
    aiToolsAllowed: policy.aiToolsAllowed,
    secureSettings,
    derivedProfile: deriveExamIntegrityProfile(policy, secureSettings),
    studentAcknowledgedAt: studentAcknowledgedAt.toISOString(),
    snapshotCreatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Part 7 — student acknowledgement summary
// ---------------------------------------------------------------------------

export type StudentExamPolicySummary = {
  examModeLabel: string;
  introStatement: string;
  allowed: string[];
  notAllowed: string[];
  secureControlStatements: string[];
};

const STUDENT_INTRO_STATEMENTS: Record<ExamMode, string> = {
  CLOSED_BOOK: "This is a closed-book exam.",
  OPEN_BOOK: "This is an open-book exam.",
  CUSTOM: "This exam has the following conditions.",
};

/** Accepts either a live policy+settings pair or an already-built snapshot — same shape either way. */
export function buildStudentExamPolicySummary(
  policySnapshot: Pick<ExamPolicySnapshot, "examMode" | "calculatorAllowed" | "notesAllowed" | "internetAllowed" | "aiToolsAllowed" | "secureSettings">,
): StudentExamPolicySummary {
  const { allowed, notAllowed } = resourceLists(policySnapshot, "Internet browsing");
  return {
    examModeLabel: EXAM_MODE_LABELS[policySnapshot.examMode],
    introStatement: STUDENT_INTRO_STATEMENTS[policySnapshot.examMode],
    allowed,
    notAllowed,
    secureControlStatements: studentSecureControlStatements(policySnapshot.secureSettings),
  };
}

// ---------------------------------------------------------------------------
// Part 9 — policy-aware integrity interpretation
// ---------------------------------------------------------------------------

export const POLICY_ALIGNMENTS = ["PERMITTED", "NOT_PERMITTED", "NOT_APPLICABLE", "UNKNOWN"] as const;
export type PolicyAlignment = (typeof POLICY_ALIGNMENTS)[number];

export const ADJUSTED_REVIEW_LEVELS = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export type AdjustedReviewLevel = (typeof ADJUSTED_REVIEW_LEVELS)[number];

export type IntegritySignalForPolicy = {
  eventType: string;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH";
  /** How many times this event type has occurred in this submission so far — used only to distinguish a single incident from a repeated pattern. */
  occurrenceCountInSubmission?: number;
};

export type PolicyInterpretation = {
  applicable: boolean;
  policyAlignment: PolicyAlignment;
  adjustedReviewLevel: AdjustedReviewLevel;
  reasonCode: string;
  explanation: string;
  limitation: string;
};

const SEVERITY_TO_LEVEL: Record<string, AdjustedReviewLevel> = { INFO: "NONE", LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" };

const FOCUS_TAB_EVENT_TYPES = new Set(["FULLSCREEN_EXIT", "WINDOW_BLUR", "WINDOW_FOCUS_RETURN"]);
const CLIPBOARD_EVENT_TYPES = new Set(["COPY_ATTEMPT", "PASTE_ATTEMPT", "RIGHT_CLICK_ATTEMPT"]);
const PHONE_VISIBLE_EVENT_TYPES = new Set(["POSSIBLE_PHONE_VISIBLE"]);
const LOOK_AWAY_EVENT_TYPES = new Set(["NO_PERSON_VISIBLE", "CAMERA_VIEW_BLOCKED", "CAMERA_TOO_DARK"]);

/** A single focus/tab event is never enough on its own; a pattern (≥3 in the submission) is what "repeated" means here. */
export const REPEATED_FOCUS_LOSS_THRESHOLD = 3;

type PolicyForClassification = Pick<ExamPolicy, "calculatorAllowed" | "notesAllowed" | "internetAllowed" | "aiToolsAllowed">;

/**
 * Interprets ONE already-recorded integrity signal against the
 * attempt's immutable policy snapshot. Never rewrites the original
 * event — this returns a separate, derived interpretation alongside it.
 * `policySnapshot: null` means a legacy attempt with no snapshot: the
 * signal is never retrospectively classified as a policy breach — it
 * always comes back UNKNOWN, at its original (never downgraded, never
 * upgraded) severity.
 */
export function classifyIntegritySignalForPolicy(
  signal: IntegritySignalForPolicy,
  policySnapshot: PolicyForClassification | null,
): PolicyInterpretation {
  const originalLevel = SEVERITY_TO_LEVEL[signal.severity] ?? "NONE";

  if (!policySnapshot) {
    return {
      applicable: true,
      policyAlignment: "UNKNOWN",
      adjustedReviewLevel: originalLevel,
      reasonCode: "LEGACY_NO_POLICY_SNAPSHOT",
      explanation: "No exam-policy snapshot exists for this legacy attempt.",
      limitation: "This attempt predates policy snapshots — activity cannot be classified against a specific policy.",
    };
  }

  if (FOCUS_TAB_EVENT_TYPES.has(signal.eventType)) {
    if (policySnapshot.internetAllowed) {
      return {
        applicable: true,
        policyAlignment: "PERMITTED",
        adjustedReviewLevel: "NONE",
        reasonCode: "FOCUS_TAB_PERMITTED_INTERNET_ALLOWED",
        explanation: "Activity was permitted under this exam policy.",
        limitation: "Internet use is permitted for this exam, so leaving the exam window may be expected.",
      };
    }
    const repeated = (signal.occurrenceCountInSubmission ?? 1) >= REPEATED_FOCUS_LOSS_THRESHOLD;
    if (repeated) {
      return {
        applicable: true,
        policyAlignment: "NOT_PERMITTED",
        adjustedReviewLevel: originalLevel === "NONE" ? "LOW" : originalLevel,
        reasonCode: "REPEATED_FOCUS_LOSS_INTERNET_NOT_ALLOWED",
        explanation: "Activity was inconsistent with this exam policy.",
        limitation: "This remains a review signal, not proof of anything.",
      };
    }
    return {
      applicable: true,
      policyAlignment: "NOT_APPLICABLE",
      adjustedReviewLevel: originalLevel,
      reasonCode: "FOCUS_TAB_SINGLE_OCCURRENCE",
      explanation: "A single instance of this activity is not, on its own, treated as inconsistent with this exam policy.",
      limitation: "Repeated occurrences may warrant closer review.",
    };
  }

  if (CLIPBOARD_EVENT_TYPES.has(signal.eventType)) {
    return {
      applicable: true,
      policyAlignment: "NOT_APPLICABLE",
      adjustedReviewLevel: originalLevel,
      reasonCode: "CLIPBOARD_POLICY_NEUTRAL",
      explanation: "Clipboard activity is reviewed the same way regardless of permitted-resource settings.",
      limitation: "This is a review signal, not proof of anything.",
    };
  }

  if (PHONE_VISIBLE_EVENT_TYPES.has(signal.eventType)) {
    if (policySnapshot.calculatorAllowed) {
      return {
        applicable: true,
        policyAlignment: "UNKNOWN",
        adjustedReviewLevel: originalLevel,
        reasonCode: "CALCULATOR_LIMITATION",
        explanation: "Review recommended. Calculators were allowed, so the object may have been a permitted calculator.",
        limitation: "A permitted calculator may appear visually similar to another handheld device using camera evidence alone.",
      };
    }
    return {
      applicable: true,
      policyAlignment: "NOT_APPLICABLE",
      adjustedReviewLevel: originalLevel,
      reasonCode: "PHONE_VISIBLE_NO_CALCULATOR_POLICY",
      explanation: "This camera signal is reviewed independently of the exam policy.",
      limitation: "This is a review signal, not proof of anything.",
    };
  }

  if (LOOK_AWAY_EVENT_TYPES.has(signal.eventType)) {
    if (policySnapshot.notesAllowed) {
      return {
        applicable: true,
        policyAlignment: "UNKNOWN",
        adjustedReviewLevel: originalLevel,
        reasonCode: "NOTES_LIMITATION",
        explanation: "The student was permitted to consult notes.",
        limitation: "Ordinary pauses or looking away are not, on their own, evidence of unauthorised notes.",
      };
    }
    return {
      applicable: true,
      policyAlignment: "NOT_APPLICABLE",
      adjustedReviewLevel: originalLevel,
      reasonCode: "CAMERA_PRESENCE_NO_NOTES_POLICY",
      explanation: "This camera signal is reviewed independently of the exam policy.",
      limitation: "This is a review signal, not proof of anything.",
    };
  }

  // Session/device, timing, answer-similarity, AI-use, and any other
  // event type: the policy never changes their interpretation — see
  // docs/exam-design-policy-v1.md ("Session changes, concurrent
  // sessions and answer similarity remain relevant").
  return {
    applicable: true,
    policyAlignment: "NOT_APPLICABLE",
    adjustedReviewLevel: originalLevel,
    reasonCode: "POLICY_NEUTRAL",
    explanation: "This signal is reviewed independently of the exam policy.",
    limitation: "This is a review signal, not proof of anything.",
  };
}

// ---------------------------------------------------------------------------
// Part 10 — bridge into the combined recommendation function
// ---------------------------------------------------------------------------

export type PolicyAdjustedRecommendationSignal = {
  category: "EVIDENCE";
  signalType: string;
  signalLevel: "LOW" | "MEDIUM" | "HIGH";
};

/**
 * Converts one integrity event's policy interpretation into an input for
 * calculateCombinedReviewRecommendation() (src/lib/combinedReviewRecommendation.ts).
 * Returns null for anything PERMITTED or at NONE level — permitted
 * activity must never raise a recommendation (Part 10).
 */
export function integrityEventPolicyToRecommendationSignal(
  eventType: string,
  interpretation: PolicyInterpretation,
): PolicyAdjustedRecommendationSignal | null {
  if (interpretation.policyAlignment === "PERMITTED") return null;
  if (interpretation.adjustedReviewLevel === "NONE") return null;
  return { category: "EVIDENCE", signalType: eventType, signalLevel: interpretation.adjustedReviewLevel };
}
