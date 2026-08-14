import { describe, it, expect } from "vitest";
import { applyLocalNavigatorTransition, type LocalNavigatorSnapshot } from "./navigatorLocalSync";

// Question Navigator immediate-local-synchronization (Tether v1.7.6,
// Part 10). Pure unit tests for applyLocalNavigatorTransition — the
// function that lets the navigator update the instant a navigation
// response arrives, without waiting on the separate, physically observed
// 2-3s GET /api/submissions/[id]/question-navigator round trip. See
// src/app/student/exams/[id]/page.test.ts for the structural (source-text)
// tests proving this is actually WIRED into navigateQuestion/
// requestNavigationOnly/loadNavigator ahead of, not instead of, the
// existing background refresh.

function baseSnapshot(overrides?: Partial<LocalNavigatorSnapshot["settings"]>): LocalNavigatorSnapshot {
  return {
    submissionId: "sub-1",
    currentQuestionIndex: 0,
    totalQuestions: 4,
    settings: {
      showQuestionNavigator: true,
      allowQuestionJumping: false,
      allowBackNavigation: true,
      allowFlagForReview: true,
      ...overrides,
    },
    // Deliberately left stale/obviously-wrong on purpose in every test
    // below — proving applyLocalNavigatorTransition never touches
    // progress (Part 8: counts are reconciled only by the background
    // loadNavigator() refresh, never derived locally).
    progress: { answeredCount: 999, unansweredCount: 999, flaggedCount: 999, visitedCount: 999 },
    questions: [
      { questionId: "q1", index: 0, number: 1, state: "CURRENT", flaggedForReview: false, locked: false, canNavigate: true },
      { questionId: "q2", index: 1, number: 2, state: "NOT_VISITED", flaggedForReview: true, locked: true, canNavigate: false },
      { questionId: "q3", index: 2, number: 3, state: "ANSWERED", flaggedForReview: false, locked: true, canNavigate: false },
      { questionId: "q4", index: 3, number: 4, state: "NOT_VISITED", flaggedForReview: false, locked: true, canNavigate: false },
    ],
  };
}

describe("applyLocalNavigatorTransition — Part 10 (1)/(2): successful navigation updates the CURRENT tile immediately", () => {
  it("moves currentQuestionIndex and marks the new question CURRENT", () => {
    const next = applyLocalNavigatorTransition(baseSnapshot(), {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: "my answer",
      newQuestionId: "q2",
      newIndex: 1,
    });
    expect(next.currentQuestionIndex).toBe(1);
    expect(next.questions.find((t) => t.questionId === "q2")?.state).toBe("CURRENT");
  });

  it("a meaningful authoritative response on the prior question becomes ANSWERED (Part 10 (2))", () => {
    const next = applyLocalNavigatorTransition(baseSnapshot(), {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: "a real answer",
      newQuestionId: "q2",
      newIndex: 1,
    });
    expect(next.questions.find((t) => t.questionId === "q1")?.state).toBe("ANSWERED");
  });
});

describe("applyLocalNavigatorTransition — Part 10 (3): an unanswered prior question becomes SKIPPED", () => {
  it("null response", () => {
    const next = applyLocalNavigatorTransition(baseSnapshot(), {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: null,
      newQuestionId: "q2",
      newIndex: 1,
    });
    expect(next.questions.find((t) => t.questionId === "q1")?.state).toBe("SKIPPED");
  });

  it("whitespace-only response — never counted as meaningful, matching isMeaningfulAnswer's trim rule", () => {
    const next = applyLocalNavigatorTransition(baseSnapshot(), {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: "   \n\t  ",
      newQuestionId: "q2",
      newIndex: 1,
    });
    expect(next.questions.find((t) => t.questionId === "q1")?.state).toBe("SKIPPED");
  });
});

describe("applyLocalNavigatorTransition — Part 10 (4): flags are preserved", () => {
  it("flaggedForReview is untouched for every tile, including the two that change state", () => {
    const snapshot = baseSnapshot({ allowQuestionJumping: true });
    const next = applyLocalNavigatorTransition(snapshot, {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: "answer",
      newQuestionId: "q2",
      newIndex: 1,
    });
    for (const tile of next.questions) {
      const original = snapshot.questions.find((t) => t.questionId === tile.questionId)!;
      expect(tile.flaggedForReview).toBe(original.flaggedForReview);
    }
    // q2 (the new current tile) was flagged before this transition —
    // still flagged after becoming CURRENT.
    expect(next.questions.find((t) => t.questionId === "q2")).toMatchObject({ state: "CURRENT", flaggedForReview: true });
  });
});

describe("applyLocalNavigatorTransition — Part 10 (5): lock state stays consistent with the existing pure navigation rules", () => {
  it("with jumping disallowed, every tile except the new current one is locked (grid navigation always requires allowQuestionJumping, regardless of adjacency)", () => {
    const next = applyLocalNavigatorTransition(baseSnapshot({ allowQuestionJumping: false }), {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: "answer",
      newQuestionId: "q2",
      newIndex: 1,
    });
    for (const tile of next.questions) {
      if (tile.questionId === "q2") {
        expect(tile).toMatchObject({ locked: false, canNavigate: true });
      } else {
        expect(tile).toMatchObject({ locked: true, canNavigate: false });
      }
    }
  });

  it("with jumping allowed and back-navigation disallowed, tiles BEHIND the new current index are locked and tiles AHEAD are unlocked", () => {
    const next = applyLocalNavigatorTransition(baseSnapshot({ allowQuestionJumping: true, allowBackNavigation: false }), {
      previousQuestionId: "q2",
      previousAuthoritativeResponse: "answer",
      newQuestionId: "q3",
      newIndex: 2,
    });
    expect(next.questions.find((t) => t.questionId === "q1")).toMatchObject({ locked: true, canNavigate: false });
    expect(next.questions.find((t) => t.questionId === "q2")).toMatchObject({ locked: true, canNavigate: false });
    expect(next.questions.find((t) => t.questionId === "q3")).toMatchObject({ locked: false, canNavigate: true }); // CURRENT
    expect(next.questions.find((t) => t.questionId === "q4")).toMatchObject({ locked: false, canNavigate: true }); // forward jump always allowed
  });
});

describe("applyLocalNavigatorTransition — other invariants", () => {
  it("never touches progress — counts are reconciled only by the background loadNavigator() refresh", () => {
    const snapshot = baseSnapshot();
    const next = applyLocalNavigatorTransition(snapshot, {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: "answer",
      newQuestionId: "q2",
      newIndex: 1,
    });
    expect(next.progress).toEqual(snapshot.progress);
  });

  it("tiles unrelated to the previous/new question are left completely untouched", () => {
    const snapshot = baseSnapshot({ allowQuestionJumping: true });
    const next = applyLocalNavigatorTransition(snapshot, {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: "answer",
      newQuestionId: "q2",
      newIndex: 1,
    });
    // q3 was already ANSWERED before this transition and is neither the
    // previous nor the new current question — its state is untouched
    // (only locked/canNavigate are recomputed, which is expected).
    expect(next.questions.find((t) => t.questionId === "q3")?.state).toBe("ANSWERED");
  });

  it("re-navigating to the SAME question (previousQuestionId === newQuestionId) stays CURRENT — never briefly flips to ANSWERED/SKIPPED first", () => {
    const next = applyLocalNavigatorTransition(baseSnapshot(), {
      previousQuestionId: "q1",
      previousAuthoritativeResponse: "answer",
      newQuestionId: "q1",
      newIndex: 0,
    });
    expect(next.questions.find((t) => t.questionId === "q1")?.state).toBe("CURRENT");
  });
});
