/**
 * Exam Design Policy v1 — pure tests. See docs/exam-design-policy-v1.md
 * and src/lib/examPolicy.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXAM_POLICY,
  effectiveExamMode,
  deriveExamIntegrityProfile,
  validateExamPolicy,
  classifyIntegritySignalForPolicy,
  buildStudentExamPolicySummary,
  buildLecturerExamPolicySummary,
  buildExamPolicySnapshot,
  getExamModePreset,
  integrityEventPolicyToRecommendationSignal,
  type ExamPolicy,
  type RelevantSecureSettings,
} from "./examPolicy";

const NEUTRAL_SETTINGS: RelevantSecureSettings = {
  secureModeEnabled: false,
  requireFullscreen: false,
  blockCopyPaste: false,
  trackWindowBlur: false,
  requireCamera: false,
  enableAiCameraIntegrityChecks: false,
};

const STRICT_SETTINGS: RelevantSecureSettings = {
  secureModeEnabled: true,
  requireFullscreen: true,
  blockCopyPaste: true,
  trackWindowBlur: true,
  requireCamera: true,
  enableAiCameraIntegrityChecks: true,
};

function policy(overrides: Partial<ExamPolicy> = {}): ExamPolicy {
  return { ...DEFAULT_EXAM_POLICY, ...overrides };
}

describe("1. existing exams default to CUSTOM without behavioural change", () => {
  it("DEFAULT_EXAM_POLICY is CUSTOM with everything disallowed", () => {
    expect(DEFAULT_EXAM_POLICY.examMode).toBe("CUSTOM");
    expect(DEFAULT_EXAM_POLICY.calculatorAllowed).toBe(false);
    expect(DEFAULT_EXAM_POLICY.notesAllowed).toBe(false);
    expect(DEFAULT_EXAM_POLICY.internetAllowed).toBe(false);
    expect(DEFAULT_EXAM_POLICY.aiToolsAllowed).toBe(false);
  });

  it("does not infer that an existing secure exam is closed-book", () => {
    const profile = deriveExamIntegrityProfile(DEFAULT_EXAM_POLICY, STRICT_SETTINGS);
    expect(profile.examMode).toBe("CUSTOM");
  });
});

describe("2. closed-book produces strict recommendations", () => {
  it("review emphasis favours closed-book-style categories", () => {
    const profile = deriveExamIntegrityProfile(policy({ examMode: "CLOSED_BOOK" }), STRICT_SETTINGS);
    expect(profile.reviewEmphasis).toContain("Focus and tab changes");
    expect(profile.suppressedOrDowngradedCategories).toEqual([]);
  });
});

describe("3. open-book does not automatically allow internet", () => {
  it("OPEN_BOOK preset leaves internet/AI tools off", () => {
    const preset = getExamModePreset("OPEN_BOOK");
    expect(preset?.resources.internetAllowed).toBe(false);
    expect(preset?.resources.aiToolsAllowed).toBe(false);
  });
});

describe("4. open-book plus internet allowed marks tab changes permitted", () => {
  it("FULLSCREEN_EXIT with internetAllowed is PERMITTED", () => {
    const result = classifyIntegritySignalForPolicy(
      { eventType: "FULLSCREEN_EXIT", severity: "MEDIUM" },
      policy({ examMode: "OPEN_BOOK", internetAllowed: true }),
    );
    expect(result.policyAlignment).toBe("PERMITTED");
    expect(result.explanation).toBe("Activity was permitted under this exam policy.");
    expect(result.adjustedReviewLevel).toBe("NONE");
  });

  it("suppresses FOCUS_TAB in the derived profile when internet is allowed", () => {
    const profile = deriveExamIntegrityProfile(policy({ internetAllowed: true }), NEUTRAL_SETTINGS);
    expect(profile.suppressedOrDowngradedCategories).toContain("FOCUS_TAB");
  });
});

describe("5. internet not allowed keeps repeated tab changes reviewable", () => {
  it("a single WINDOW_BLUR is not treated as inconsistent", () => {
    const result = classifyIntegritySignalForPolicy(
      { eventType: "WINDOW_BLUR", severity: "MEDIUM", occurrenceCountInSubmission: 1 },
      policy({ internetAllowed: false }),
    );
    expect(result.policyAlignment).toBe("NOT_APPLICABLE");
  });

  it("repeated WINDOW_BLUR is marked inconsistent with the policy", () => {
    const result = classifyIntegritySignalForPolicy(
      { eventType: "WINDOW_BLUR", severity: "MEDIUM", occurrenceCountInSubmission: 4 },
      policy({ internetAllowed: false }),
    );
    expect(result.policyAlignment).toBe("NOT_PERMITTED");
    expect(result.explanation).toBe("Activity was inconsistent with this exam policy.");
    expect(result.limitation.toLowerCase()).toContain("not proof");
  });
});

describe("6/7. AI tools allowed/not-allowed never proves AI use", () => {
  it("AI tools allowed: policy never treats an AI-use signal type as a breach (POLICY_NEUTRAL, not NOT_PERMITTED)", () => {
    const result = classifyIntegritySignalForPolicy(
      { eventType: "SOME_AI_USE_ADJACENT_EVENT", severity: "MEDIUM" },
      policy({ aiToolsAllowed: true }),
    );
    expect(result.policyAlignment).not.toBe("NOT_PERMITTED");
  });

  it("AI tools not allowed: classification never asserts AI use occurred", () => {
    const result = classifyIntegritySignalForPolicy(
      { eventType: "SOME_AI_USE_ADJACENT_EVENT", severity: "MEDIUM" },
      policy({ aiToolsAllowed: false }),
    );
    expect(result.explanation).not.toMatch(/AI use confirmed/i);
    expect(result.policyAlignment).not.toBe("NOT_PERMITTED");
  });
});

describe("8. notes allowed changes looking-away interpretation", () => {
  it("NO_PERSON_VISIBLE with notesAllowed gets the notes limitation", () => {
    const result = classifyIntegritySignalForPolicy(
      { eventType: "NO_PERSON_VISIBLE", severity: "MEDIUM" },
      policy({ notesAllowed: true }),
    );
    expect(result.explanation).toBe("The student was permitted to consult notes.");
  });

  it("NO_PERSON_VISIBLE without notesAllowed does not mention notes", () => {
    const result = classifyIntegritySignalForPolicy(
      { eventType: "NO_PERSON_VISIBLE", severity: "MEDIUM" },
      policy({ notesAllowed: false }),
    );
    expect(result.explanation).not.toContain("notes");
  });
});

describe("9. calculator allowed adds a limitation to phone-visible evidence", () => {
  it("POSSIBLE_PHONE_VISIBLE with calculatorAllowed includes the calculator limitation", () => {
    const result = classifyIntegritySignalForPolicy(
      { eventType: "POSSIBLE_PHONE_VISIBLE", severity: "MEDIUM" },
      policy({ calculatorAllowed: true }),
    );
    expect(result.limitation).toContain("permitted calculator may appear visually similar");
    expect(result.policyAlignment).toBe("UNKNOWN");
  });
});

describe("10. custom mode preserves explicit settings", () => {
  it("CUSTOM policy is echoed back unchanged in the derived profile", () => {
    const custom = policy({ examMode: "CUSTOM", calculatorAllowed: true, internetAllowed: true, aiToolsAllowed: true });
    const profile = deriveExamIntegrityProfile(custom, NEUTRAL_SETTINGS);
    expect(profile.permittedResources).toEqual({
      calculatorAllowed: true,
      notesAllowed: false,
      internetAllowed: true,
      aiToolsAllowed: true,
    });
  });
});

describe("11. contradictory settings produce warnings", () => {
  it("closed-book + internet produces the CLOSED_BOOK_WITH_INTERNET warning", () => {
    const warnings = validateExamPolicy(policy({ examMode: "CLOSED_BOOK", internetAllowed: true }), NEUTRAL_SETTINGS);
    expect(warnings.some((w) => w.code === "CLOSED_BOOK_WITH_INTERNET")).toBe(true);
  });

  it("internet + strict fullscreen produces a warning", () => {
    const warnings = validateExamPolicy(policy({ internetAllowed: true }), { ...NEUTRAL_SETTINGS, requireFullscreen: true });
    expect(warnings.some((w) => w.code === "INTERNET_WITH_STRICT_FULLSCREEN")).toBe(true);
  });

  it("warnings never block — validateExamPolicy only ever returns an array, never throws", () => {
    expect(() => validateExamPolicy(policy({ examMode: "CLOSED_BOOK", aiToolsAllowed: true, internetAllowed: true }), STRICT_SETTINGS)).not.toThrow();
  });
});

describe("12. presets do not overwrite settings without confirmation", () => {
  it("getExamModePreset only returns a PROPOSAL — applying it is the caller's explicit choice", () => {
    const preset = getExamModePreset("CLOSED_BOOK");
    // The preset object itself never mutates any input policy — pure data only.
    expect(preset?.resources.calculatorAllowed).toBe(false);
  });

  it("CUSTOM mode has no preset to silently apply", () => {
    expect(getExamModePreset("CUSTOM")).toBeNull();
  });

  it("effectiveExamMode demotes closed-book+internet to CUSTOM without changing the stored examMode", () => {
    const p = policy({ examMode: "CLOSED_BOOK", internetAllowed: true });
    expect(effectiveExamMode(p)).toBe("CUSTOM");
    expect(p.examMode).toBe("CLOSED_BOOK"); // stored value untouched
  });
});

describe("13. legacy attempts are not retrospectively classified", () => {
  it("classifyIntegritySignalForPolicy with null snapshot returns UNKNOWN, never NOT_PERMITTED", () => {
    const result = classifyIntegritySignalForPolicy({ eventType: "WINDOW_BLUR", severity: "MEDIUM" }, null);
    expect(result.policyAlignment).toBe("UNKNOWN");
    expect(result.adjustedReviewLevel).toBe("MEDIUM"); // original severity preserved, not upgraded/downgraded
  });
});

describe("14. policy snapshot is immutable after attempt start", () => {
  it("buildExamPolicySnapshot is a pure function — same inputs produce the same output", () => {
    const ack = new Date("2026-07-18T10:00:00Z");
    const now = new Date("2026-07-18T10:00:05Z");
    const a = buildExamPolicySnapshot(policy({ examMode: "CLOSED_BOOK" }), STRICT_SETTINGS, ack, now);
    const b = buildExamPolicySnapshot(policy({ examMode: "CLOSED_BOOK" }), STRICT_SETTINGS, ack, now);
    expect(a).toEqual(b);
    expect(a.snapshotCreatedAt).toBe(now.toISOString());
    expect(a.studentAcknowledgedAt).toBe(ack.toISOString());
  });
});

describe("15. student-safe policy DTO contains no secrets", () => {
  it("buildStudentExamPolicySummary never includes hashes, secrets, or raw settings JSON keys beyond the documented shape", () => {
    const snapshot = buildExamPolicySnapshot(policy({ examMode: "CLOSED_BOOK", calculatorAllowed: true }), STRICT_SETTINGS, new Date(), new Date());
    const summary = buildStudentExamPolicySummary(snapshot);
    const text = JSON.stringify(summary);
    expect(text).not.toMatch(/hash|secret|token|correctAnswer/i);
    expect(summary.allowed).toContain("Calculator");
    expect(summary.notAllowed).toContain("Internet browsing");
  });
});

describe("16/17. lecturer summary and snapshot independence", () => {
  it("buildLecturerExamPolicySummary matches the documented example shape", () => {
    const summary = buildLecturerExamPolicySummary(policy({ examMode: "CLOSED_BOOK", calculatorAllowed: true }), STRICT_SETTINGS);
    expect(summary.examModeLabel).toBe("Closed-book exam");
    expect(summary.allowed).toEqual(["Calculator"]);
    expect(summary.notAllowed).toEqual(["Notes", "Internet", "AI tools"]);
    expect(summary.secureControls).toEqual([
      "Fullscreen required",
      "Clipboard restricted",
      "Tab changes reviewed",
      "Camera checks enabled",
    ]);
  });

  it("editing the exam policy after a snapshot was built does not change that snapshot (pure function, no shared mutable state)", () => {
    const originalPolicy = policy({ examMode: "CLOSED_BOOK" });
    const snapshot = buildExamPolicySnapshot(originalPolicy, STRICT_SETTINGS, new Date(), new Date());
    // Simulate the lecturer changing the policy afterwards.
    const changedPolicy = { ...originalPolicy, examMode: "OPEN_BOOK" as const, internetAllowed: true };
    void changedPolicy;
    expect(snapshot.examMode).toBe("CLOSED_BOOK");
  });
});

describe("integrityEventPolicyToRecommendationSignal", () => {
  it("permitted activity never raises a recommendation (returns null)", () => {
    const interpretation = classifyIntegritySignalForPolicy({ eventType: "FULLSCREEN_EXIT", severity: "MEDIUM" }, policy({ internetAllowed: true }));
    expect(integrityEventPolicyToRecommendationSignal("FULLSCREEN_EXIT", interpretation)).toBeNull();
  });

  it("a policy-inconsistent signal produces an EVIDENCE-category recommendation input", () => {
    const interpretation = classifyIntegritySignalForPolicy(
      { eventType: "WINDOW_BLUR", severity: "MEDIUM", occurrenceCountInSubmission: 5 },
      policy({ internetAllowed: false }),
    );
    const signal = integrityEventPolicyToRecommendationSignal("WINDOW_BLUR", interpretation);
    expect(signal?.category).toBe("EVIDENCE");
    expect(signal?.signalLevel).toBe("MEDIUM");
  });
});
