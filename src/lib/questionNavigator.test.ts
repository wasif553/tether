/**
 * Question Navigator v1 — pure tests. See docs/question-navigator-v1.md
 * and src/lib/questionNavigator.ts.
 */
import { describe, expect, it } from "vitest";
import {
  isMeaningfulAnswer,
  deriveQuestionDisplayState,
  canNavigateSequential,
  canNavigateToQuestion,
  deriveQuestionNavigatorState,
  summariseQuestionProgress,
  findFirstNavigableUnanswered,
  findFirstNavigableFlagged,
  type QuestionStateInput,
  type NavigatorContext,
} from "./questionNavigator";

function q(overrides: Partial<QuestionStateInput> & Pick<QuestionStateInput, "questionId">): QuestionStateInput {
  return { questionType: "SHORT_ANSWER", response: null, visited: false, flaggedForReview: false, ...overrides };
}

describe("state derivation", () => {
  it("1. current unanswered question is CURRENT", () => {
    expect(deriveQuestionDisplayState({ isCurrent: true, hasMeaningfulAnswer: false, visited: true })).toBe("CURRENT");
  });

  it("2. answered question is ANSWERED", () => {
    expect(deriveQuestionDisplayState({ isCurrent: false, hasMeaningfulAnswer: true, visited: true })).toBe("ANSWERED");
  });

  it("3. visited unanswered question is SKIPPED", () => {
    expect(deriveQuestionDisplayState({ isCurrent: false, hasMeaningfulAnswer: false, visited: true })).toBe("SKIPPED");
  });

  it("4. no visit/no answer is NOT_VISITED", () => {
    expect(deriveQuestionDisplayState({ isCurrent: false, hasMeaningfulAnswer: false, visited: false })).toBe("NOT_VISITED");
  });

  it("7. whitespace-only answer is unanswered", () => {
    expect(isMeaningfulAnswer("ESSAY", "   \n\t  ")).toBe(false);
    expect(isMeaningfulAnswer("ESSAY", "")).toBe(false);
    expect(isMeaningfulAnswer("ESSAY", null)).toBe(false);
  });

  it("8. MCQ selected response is answered", () => {
    expect(isMeaningfulAnswer("MULTIPLE_CHOICE", "Option B")).toBe(true);
  });
});

describe("5/6. flag state coexists with answered/skipped", () => {
  const ctx: NavigatorContext = { currentIndex: 0, allowQuestionJumping: true, allowBackNavigation: true, submissionInProgress: true };

  it("5. flag can coexist with answered", () => {
    const tiles = deriveQuestionNavigatorState([q({ questionId: "q1", response: "answered", visited: true, flaggedForReview: true })], ctx);
    expect(tiles[0].answered).toBe(true);
    expect(tiles[0].flaggedForReview).toBe(true);
  });

  it("6. flag can coexist with skipped", () => {
    const tiles = deriveQuestionNavigatorState([q({ questionId: "q1", visited: true, flaggedForReview: true })], { ...ctx, currentIndex: 1 });
    expect(tiles[0].state).toBe("SKIPPED");
    expect(tiles[0].flaggedForReview).toBe(true);
  });
});

describe("9/10. selected-question-set only", () => {
  it("9. question count uses only the supplied (selected) question set", () => {
    const tiles = deriveQuestionNavigatorState(
      [q({ questionId: "q1" }), q({ questionId: "q2" })],
      { currentIndex: 0, allowQuestionJumping: false, allowBackNavigation: false, submissionInProgress: true },
    );
    expect(tiles).toHaveLength(2);
  });

  it("10. unselected pool questions never appear — module only ever sees what the caller supplies", () => {
    const tiles = deriveQuestionNavigatorState([q({ questionId: "selected-only" })], {
      currentIndex: 0,
      allowQuestionJumping: false,
      allowBackNavigation: false,
      submissionInProgress: true,
    });
    expect(tiles.map((t) => t.questionId)).toEqual(["selected-only"]);
  });
});

describe("navigation authorisation", () => {
  it("11. current question is accessible", () => {
    const result = canNavigateToQuestion({ targetIndex: 3, currentIndex: 3, totalQuestions: 10, allowQuestionJumping: false, allowBackNavigation: false, submissionInProgress: true });
    expect(result.allowed).toBe(true);
  });

  it("12. jumping disabled rejects direct (grid) navigation to a non-current question", () => {
    const result = canNavigateToQuestion({ targetIndex: 4, currentIndex: 3, totalQuestions: 10, allowQuestionJumping: false, allowBackNavigation: true, submissionInProgress: true });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("JUMPING_NOT_ALLOWED");
  });

  it("13. jumping enabled allows future (grid) navigation", () => {
    const result = canNavigateToQuestion({ targetIndex: 7, currentIndex: 3, totalQuestions: 10, allowQuestionJumping: true, allowBackNavigation: false, submissionInProgress: true });
    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBe("FORWARD_JUMP_ALLOWED");
  });

  it("14. earlier (grid) navigation requires allowBackNavigation even when jumping is allowed", () => {
    const withoutBack = canNavigateToQuestion({ targetIndex: 1, currentIndex: 3, totalQuestions: 10, allowQuestionJumping: true, allowBackNavigation: false, submissionInProgress: true });
    expect(withoutBack.allowed).toBe(false);
    expect(withoutBack.reasonCode).toBe("BACK_NAVIGATION_NOT_ALLOWED");
    const withBack = canNavigateToQuestion({ targetIndex: 1, currentIndex: 3, totalQuestions: 10, allowQuestionJumping: true, allowBackNavigation: true, submissionInProgress: true });
    expect(withBack.allowed).toBe(true);
  });

  it("15. back-disabled exam rejects a manipulated earlier-index sequential request", () => {
    const result = canNavigateSequential({ targetIndex: 2, currentIndex: 3, totalQuestions: 10, allowBackNavigation: false, submissionInProgress: true });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("BACK_NAVIGATION_NOT_ALLOWED");
  });

  it("16. invalid target index is rejected", () => {
    expect(canNavigateToQuestion({ targetIndex: -1, currentIndex: 0, totalQuestions: 5, allowQuestionJumping: true, allowBackNavigation: true, submissionInProgress: true }).allowed).toBe(false);
    expect(canNavigateToQuestion({ targetIndex: 5, currentIndex: 0, totalQuestions: 5, allowQuestionJumping: true, allowBackNavigation: true, submissionInProgress: true }).allowed).toBe(false);
  });

  it("17. submitted (not in-progress) attempt rejects navigation", () => {
    const result = canNavigateToQuestion({ targetIndex: 1, currentIndex: 0, totalQuestions: 5, allowQuestionJumping: true, allowBackNavigation: true, submissionInProgress: false });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("SUBMISSION_NOT_IN_PROGRESS");
  });

  it("20. server authorisation is authoritative — a non-adjacent sequential-path request is never authorised, regardless of jumping settings (must use GOTO)", () => {
    const result = canNavigateSequential({ targetIndex: 9, currentIndex: 0, totalQuestions: 10, allowBackNavigation: true, submissionInProgress: true });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("JUMPING_NOT_ALLOWED");
  });

  it("existing Next/Previous sequential behaviour is unaffected by allowQuestionJumping", () => {
    const next = canNavigateSequential({ targetIndex: 4, currentIndex: 3, totalQuestions: 10, allowBackNavigation: false, submissionInProgress: true });
    expect(next.allowed).toBe(true);
    expect(next.reasonCode).toBe("SEQUENTIAL_NEXT_ALLOWED");
  });
});

describe("progress summary", () => {
  it("28. answered/unanswered/flagged counts are correct", () => {
    const tiles = deriveQuestionNavigatorState(
      [
        q({ questionId: "q1", response: "answer", visited: true }),
        q({ questionId: "q2", visited: true, flaggedForReview: true }),
        q({ questionId: "q3" }),
      ],
      { currentIndex: 0, allowQuestionJumping: false, allowBackNavigation: false, submissionInProgress: true },
    );
    const summary = summariseQuestionProgress(tiles);
    expect(summary.answeredCount).toBe(1);
    expect(summary.unansweredCount).toBe(2);
    expect(summary.flaggedCount).toBe(1);
    expect(summary.totalQuestions).toBe(3);
  });

  it("32. answered state may be derived without a visit row (visited defaults false)", () => {
    const tiles = deriveQuestionNavigatorState([q({ questionId: "q1", response: "answered but never marked visited" })], {
      currentIndex: 5,
      allowQuestionJumping: false,
      allowBackNavigation: false,
      submissionInProgress: true,
    });
    expect(tiles[0].answered).toBe(true);
    expect(tiles[0].visited).toBe(false);
  });
});

describe("review-before-submit helpers", () => {
  const ctx: NavigatorContext = { currentIndex: 0, allowQuestionJumping: true, allowBackNavigation: true, submissionInProgress: true };

  it("35. return-to-unanswered uses the first permitted target", () => {
    const tiles = deriveQuestionNavigatorState(
      [q({ questionId: "q1", response: "x" }), q({ questionId: "q2" }), q({ questionId: "q3" })],
      ctx,
    );
    expect(findFirstNavigableUnanswered(tiles, ctx)).toBe(1);
  });

  it("36. review-flagged uses the first permitted target", () => {
    const tiles = deriveQuestionNavigatorState(
      [q({ questionId: "q1" }), q({ questionId: "q2", flaggedForReview: true }), q({ questionId: "q3", flaggedForReview: true })],
      ctx,
    );
    expect(findFirstNavigableFlagged(tiles, ctx)).toBe(1);
  });

  it("37. a locked unanswered question does not bypass policy — skipped in favour of the next permitted one, or null if none", () => {
    const lockedCtx: NavigatorContext = { currentIndex: 0, allowQuestionJumping: false, allowBackNavigation: false, submissionInProgress: true };
    const tiles = deriveQuestionNavigatorState([q({ questionId: "q1" }), q({ questionId: "q2" })], lockedCtx);
    // Jumping disabled: only the current index (0) is navigable; q1 (index 0) is itself unanswered and current, so it IS returned.
    expect(findFirstNavigableUnanswered(tiles, lockedCtx)).toBe(0);
    // If the current question is answered but a later one is not and jumping is off, there's nothing permitted to jump to.
    const tiles2 = deriveQuestionNavigatorState([q({ questionId: "q1", response: "x" }), q({ questionId: "q2" })], lockedCtx);
    expect(findFirstNavigableUnanswered(tiles2, lockedCtx)).toBeNull();
  });
});
