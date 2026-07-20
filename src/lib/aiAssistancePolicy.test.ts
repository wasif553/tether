/**
 * Controlled AI Brainstorming Assistance v1 — pure policy tests. See
 * docs/controlled-ai-brainstorming-assistance-v1.md.
 */
import { describe, expect, it } from "vitest";
import {
  buildAiAssistancePolicySnapshot,
  parseAiAssistancePolicy,
  isAiAssistanceEnabled,
  hasReachedQuestionPromptLimit,
  hasReachedAttemptPromptLimit,
  isStudentPromptLengthValid,
  MAX_STUDENT_PROMPT_CHARACTERS,
  isWithinRateLimit,
  hintLadderLevelForApprovedCount,
  MAX_HINT_LADDER_LEVEL,
  nextCumulativeRiskScore,
  isCumulativeHintLeakageRisk,
  CUMULATIVE_HINT_LEAKAGE_THRESHOLD,
  AI_ASSISTANCE_FALLBACK_RESPONSE,
  AI_ASSISTANCE_UNAVAILABLE_MESSAGE,
  DISABLED_AI_ASSISTANCE_POLICY,
  AI_ASSISTANCE_INTERACTION_STATUSES,
  TERMINAL_AI_ASSISTANCE_STATUSES,
  STALE_RESERVATION_MS,
  isStaleReservation,
  MAX_HIDDEN_REFERENCE_CHARACTERS,
  boundedHiddenReference,
  isApprovedResponseLengthValid,
} from "./aiAssistancePolicy";
import { severityFor, DEFAULT_SECURE_SETTINGS } from "./secureExam";
import { SEVERITY_WEIGHTS } from "./integrityRisk";

const ENABLED_SETTINGS = {
  aiAssistanceMode: "BRAINSTORM_ONLY" as const,
  aiAssistanceMaxPromptsPerQuestion: 3,
  aiAssistanceMaxPromptsPerAttempt: 10,
  aiAssistanceMaxResponseCharacters: 800,
  aiAssistanceAllowConceptExplanations: true,
  aiAssistanceAllowAnswerPlanning: true,
  aiAssistanceAllowReasoningFeedback: true,
  aiAssistanceAllowProgrammingConceptHelp: true,
};

describe("policy snapshot (Part 3)", () => {
  it("builds a snapshot from settings", () => {
    const snapshot = buildAiAssistancePolicySnapshot(ENABLED_SETTINGS);
    expect(snapshot.mode).toBe("BRAINSTORM_ONLY");
    expect(snapshot.maxPromptsPerQuestion).toBe(3);
    expect(isAiAssistanceEnabled(snapshot)).toBe(true);
  });

  it("a null/missing stored snapshot is ALWAYS treated as DISABLED", () => {
    expect(parseAiAssistancePolicy(null)).toEqual(DISABLED_AI_ASSISTANCE_POLICY);
    expect(parseAiAssistancePolicy(undefined)).toEqual(DISABLED_AI_ASSISTANCE_POLICY);
    expect(parseAiAssistancePolicy("not an object")).toEqual(DISABLED_AI_ASSISTANCE_POLICY);
    expect(isAiAssistanceEnabled(parseAiAssistancePolicy(null))).toBe(false);
  });

  it("25. a stored snapshot round-trips unchanged, independent of any 'current settings' passed elsewhere", () => {
    const snapshot = buildAiAssistancePolicySnapshot(ENABLED_SETTINGS);
    const stored = JSON.parse(JSON.stringify(snapshot));
    // Simulate the exam's settings changing AFTER the snapshot was taken —
    // parseAiAssistancePolicy takes ONLY the stored snapshot, never a
    // second "current settings" argument, so there is no code path by
    // which a later settings change could affect this attempt's snapshot.
    const reparsed = parseAiAssistancePolicy(stored);
    expect(reparsed).toEqual(snapshot);
    expect(reparsed.maxPromptsPerQuestion).toBe(3);
  });

  it("a malformed stored snapshot falls back to safe defaults, never throws", () => {
    const reparsed = parseAiAssistancePolicy({ mode: "BRAINSTORM_ONLY", maxPromptsPerQuestion: "not a number" });
    expect(reparsed.maxPromptsPerQuestion).toBe(3);
  });
});

describe("5/6. prompt/attempt limits", () => {
  it("question limit", () => {
    expect(hasReachedQuestionPromptLimit(2, { maxPromptsPerQuestion: 3 })).toBe(false);
    expect(hasReachedQuestionPromptLimit(3, { maxPromptsPerQuestion: 3 })).toBe(true);
    expect(hasReachedQuestionPromptLimit(4, { maxPromptsPerQuestion: 3 })).toBe(true);
  });

  it("attempt limit", () => {
    expect(hasReachedAttemptPromptLimit(9, { maxPromptsPerAttempt: 10 })).toBe(false);
    expect(hasReachedAttemptPromptLimit(10, { maxPromptsPerAttempt: 10 })).toBe(true);
  });
});

describe("request length bound", () => {
  it("rejects empty and over-length prompts", () => {
    expect(isStudentPromptLengthValid("")).toBe(false);
    expect(isStudentPromptLengthValid("   ")).toBe(false);
    expect(isStudentPromptLengthValid("a".repeat(MAX_STUDENT_PROMPT_CHARACTERS))).toBe(true);
    expect(isStudentPromptLengthValid("a".repeat(MAX_STUDENT_PROMPT_CHARACTERS + 1))).toBe(false);
  });
});

describe("7. rate limiting", () => {
  it("allows up to the configured max within the window, then blocks", () => {
    const now = 100_000;
    const timestamps = [now - 1000, now - 2000];
    expect(isWithinRateLimit(timestamps, now, 3, 20_000)).toBe(true);
    expect(isWithinRateLimit([...timestamps, now - 500], now, 3, 20_000)).toBe(false);
  });

  it("timestamps outside the window don't count", () => {
    const now = 100_000;
    const stale = [now - 100_000, now - 90_000];
    expect(isWithinRateLimit(stale, now, 1, 20_000)).toBe(true);
  });
});

describe("10. hint ladder", () => {
  it("never exceeds MAX_HINT_LADDER_LEVEL regardless of approved count", () => {
    expect(hintLadderLevelForApprovedCount(0)).toBe(1);
    expect(hintLadderLevelForApprovedCount(1)).toBe(2);
    expect(hintLadderLevelForApprovedCount(2)).toBe(3);
    expect(hintLadderLevelForApprovedCount(3)).toBe(4);
    expect(hintLadderLevelForApprovedCount(10)).toBe(MAX_HINT_LADDER_LEVEL);
  });
});

describe("20. cumulative hint leakage protection", () => {
  it("cumulative risk is a running, never-decreasing sum", () => {
    let cumulative = 0;
    cumulative = nextCumulativeRiskScore(cumulative, 0.4);
    cumulative = nextCumulativeRiskScore(cumulative, 0.3);
    expect(cumulative).toBeCloseTo(0.7);
    expect(isCumulativeHintLeakageRisk(cumulative)).toBe(false);
  });

  it("several individually-low-risk responses can still trip cumulative leakage protection", () => {
    let cumulative = 0;
    for (let i = 0; i < 5; i++) {
      cumulative = nextCumulativeRiskScore(cumulative, 0.4);
    }
    expect(cumulative).toBeGreaterThanOrEqual(CUMULATIVE_HINT_LEAKAGE_THRESHOLD);
    expect(isCumulativeHintLeakageRisk(cumulative)).toBe(true);
  });

  it("a negative riskScore never reduces the running total", () => {
    expect(nextCumulativeRiskScore(0.5, -1)).toBe(0.5);
  });
});

describe("9. Part 9 deterministic fallback", () => {
  it("is a fixed string, never model output", () => {
    expect(AI_ASSISTANCE_FALLBACK_RESPONSE.length).toBeGreaterThan(0);
    expect(AI_ASSISTANCE_FALLBACK_RESPONSE).toContain("cannot provide");
  });
});

describe("24. permitted AI-assistance use never increases integrity risk", () => {
  it("every AI_ASSISTANCE_* event severity is INFO (weight 0), including the new FAILED-provider event", () => {
    const settings = DEFAULT_SECURE_SETTINGS;
    for (const eventType of [
      "AI_ASSISTANCE_USED",
      "AI_ASSISTANCE_REQUEST_BLOCKED",
      "AI_ASSISTANCE_LIMIT_REACHED",
      "AI_ASSISTANCE_RESPONSE_REGENERATED",
      "AI_ASSISTANCE_REQUEST_FAILED",
    ] as const) {
      const severity = severityFor(eventType, settings);
      expect(severity).toBe("INFO");
      expect(SEVERITY_WEIGHTS[severity]).toBe(0);
    }
  });
});

describe("4. interaction status lifecycle", () => {
  it("is exactly the six-state (five persisted-terminal-plus-RESERVED) lifecycle", () => {
    expect([...AI_ASSISTANCE_INTERACTION_STATUSES].sort()).toEqual(
      ["RESERVED", "APPROVED", "BLOCKED", "FALLBACK", "FAILED"].sort(),
    );
  });

  it("every status except RESERVED is terminal", () => {
    expect(TERMINAL_AI_ASSISTANCE_STATUSES).not.toContain("RESERVED");
    for (const status of TERMINAL_AI_ASSISTANCE_STATUSES) {
      expect(AI_ASSISTANCE_INTERACTION_STATUSES).toContain(status);
    }
  });
});

describe("RESERVED records cannot remain permanently misleading", () => {
  it("a fresh reservation is not stale", () => {
    expect(isStaleReservation(new Date())).toBe(false);
  });

  it("a reservation older than STALE_RESERVATION_MS is stale", () => {
    const old = new Date(Date.now() - STALE_RESERVATION_MS - 1);
    expect(isStaleReservation(old)).toBe(true);
  });

  it("a reservation just under the threshold is not yet stale", () => {
    const almostOld = new Date(Date.now() - (STALE_RESERVATION_MS - 5_000));
    expect(isStaleReservation(almostOld)).toBe(false);
  });
});

describe("9. FAILED-status student message is distinct from the FALLBACK message", () => {
  it("never claims to have generated content, and is a fixed string", () => {
    expect(AI_ASSISTANCE_UNAVAILABLE_MESSAGE).not.toBe(AI_ASSISTANCE_FALLBACK_RESPONSE);
    expect(AI_ASSISTANCE_UNAVAILABLE_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe("Part 9 — provider payload bounds", () => {
  it("bounds hidden reference material to MAX_HIDDEN_REFERENCE_CHARACTERS", () => {
    const long = "a".repeat(MAX_HIDDEN_REFERENCE_CHARACTERS + 500);
    const bounded = boundedHiddenReference(long);
    expect(bounded).not.toBeNull();
    expect(bounded!.length).toBe(MAX_HIDDEN_REFERENCE_CHARACTERS);
  });

  it("leaves short reference material untouched", () => {
    expect(boundedHiddenReference("short answer")).toBe("short answer");
  });

  it("returns null for empty/null/undefined input", () => {
    expect(boundedHiddenReference(null)).toBeNull();
    expect(boundedHiddenReference(undefined)).toBeNull();
    expect(boundedHiddenReference("")).toBeNull();
  });

  it("21. approved-response length is enforced against the policy limit, never truncated by this function itself", () => {
    expect(isApprovedResponseLengthValid("short", { maxResponseCharacters: 800 })).toBe(true);
    expect(isApprovedResponseLengthValid("x".repeat(801), { maxResponseCharacters: 800 })).toBe(false);
    expect(isApprovedResponseLengthValid("", { maxResponseCharacters: 800 })).toBe(false);
  });
});
