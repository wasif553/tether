import { describe, expect, it } from "vitest";
import {
  planAutomaticPoolSelection,
  computeResultingComposition,
  findOverQuotaBands,
  findOverDrawBands,
  totalOf,
  type BankQuestionForPlanning,
} from "./automaticPoolPlanning";

function q(id: string, overrides: Partial<BankQuestionForPlanning> = {}): BankQuestionForPlanning {
  return { id, type: "MULTIPLE_CHOICE", topic: null, difficulty: "easy", ...overrides };
}

describe("planAutomaticPoolSelection", () => {
  it("counts available questions per difficulty, excluding already-copied ones", () => {
    const bankQuestions = [
      q("e1", { difficulty: "easy" }),
      q("e2", { difficulty: "easy" }),
      q("m1", { difficulty: "medium" }),
      q("h1", { difficulty: "hard" }),
    ];
    const plan = planAutomaticPoolSelection({ bankQuestions, alreadyCopiedIds: new Set(["e2"]) });
    expect(plan.available).toEqual({ easy: 1, medium: 1, hard: 1 });
    expect(plan.emptyState).toBeNull();
  });

  it("never folds an unclassified (null-difficulty) question into any Easy/Medium/Hard band", () => {
    const bankQuestions = [q("e1", { difficulty: "easy" }), q("u1", { difficulty: null }), q("u2", { difficulty: null })];
    const plan = planAutomaticPoolSelection({ bankQuestions, alreadyCopiedIds: new Set() });
    expect(plan.available).toEqual({ easy: 1, medium: 0, hard: 0 });
    expect(plan.unclassifiedCount).toBe(2);
  });

  it("emptyState 'bank-empty' when the bank has no questions at all", () => {
    const plan = planAutomaticPoolSelection({ bankQuestions: [], alreadyCopiedIds: new Set() });
    expect(plan.emptyState).toBe("bank-empty");
  });

  it("emptyState 'no-filter-matches' when filters exclude every question", () => {
    const bankQuestions = [q("e1", { type: "ESSAY" })];
    const plan = planAutomaticPoolSelection({ bankQuestions, alreadyCopiedIds: new Set(), filterType: "MULTIPLE_CHOICE" });
    expect(plan.emptyState).toBe("no-filter-matches");
  });

  it("emptyState 'all-already-copied' when filters match but every match is already in the exam", () => {
    const bankQuestions = [q("e1"), q("e2")];
    const plan = planAutomaticPoolSelection({ bankQuestions, alreadyCopiedIds: new Set(["e1", "e2"]) });
    expect(plan.emptyState).toBe("all-already-copied");
  });

  it("emptyState 'none-classified' when matching fresh questions exist but none have a difficulty", () => {
    const bankQuestions = [q("u1", { difficulty: null }), q("u2", { difficulty: null })];
    const plan = planAutomaticPoolSelection({ bankQuestions, alreadyCopiedIds: new Set() });
    expect(plan.emptyState).toBe("none-classified");
    expect(plan.unclassifiedCount).toBe(2);
  });

  it("clearing filters (empty filterType/filterTopic) restores the full available counts", () => {
    const bankQuestions = [q("e1", { topic: "loops" }), q("e2", { topic: "functions" }), q("m1", { topic: "functions", difficulty: "medium" })];
    const filtered = planAutomaticPoolSelection({ bankQuestions, alreadyCopiedIds: new Set(), filterTopic: "functions" });
    expect(filtered.available).toEqual({ easy: 1, medium: 1, hard: 0 });

    const cleared = planAutomaticPoolSelection({ bankQuestions, alreadyCopiedIds: new Set(), filterTopic: "" });
    expect(cleared.available).toEqual({ easy: 2, medium: 1, hard: 0 });
  });

  it("respects the type filter", () => {
    const bankQuestions = [q("e1", { type: "MULTIPLE_CHOICE" }), q("e2", { type: "ESSAY" })];
    const plan = planAutomaticPoolSelection({ bankQuestions, alreadyCopiedIds: new Set(), filterType: "ESSAY" });
    expect(plan.available).toEqual({ easy: 1, medium: 0, hard: 0 });
  });
});

describe("computeResultingComposition", () => {
  it("adds the requested quotas on top of an existing pool's current composition", () => {
    expect(computeResultingComposition({ easy: 2, medium: 1, hard: 0 }, { easy: 4, medium: 3, hard: 3 })).toEqual({
      easy: 6,
      medium: 4,
      hard: 3,
    });
  });

  it("a brand-new pool (existing all zero) just reflects the quotas", () => {
    expect(computeResultingComposition({ easy: 0, medium: 0, hard: 0 }, { easy: 10, medium: 5, hard: 5 })).toEqual({
      easy: 10,
      medium: 5,
      hard: 5,
    });
  });
});

describe("findOverQuotaBands / findOverDrawBands", () => {
  it("flags exactly the bands where the pool-composition quota exceeds availability", () => {
    expect(findOverQuotaBands({ easy: 10, medium: 5, hard: 5 }, { easy: 7, medium: 5, hard: 10 })).toEqual(["easy"]);
    expect(findOverQuotaBands({ easy: 5, medium: 5, hard: 5 }, { easy: 5, medium: 5, hard: 5 })).toEqual([]);
  });

  it("flags exactly the bands where the per-student draw exceeds what the pool will contain", () => {
    expect(findOverDrawBands({ easy: 4, medium: 3, hard: 3 }, { easy: 3, medium: 3, hard: 3 })).toEqual(["easy"]);
  });

  it("a blank/all-zero draw never counts as over-draw, regardless of pool size", () => {
    expect(findOverDrawBands({ easy: 0, medium: 0, hard: 0 }, { easy: 0, medium: 0, hard: 0 })).toEqual([]);
  });
});

describe("totalOf", () => {
  it("sums the three bands", () => {
    expect(totalOf({ easy: 10, medium: 5, hard: 5 })).toBe(20);
    expect(totalOf({ easy: 0, medium: 0, hard: 0 })).toBe(0);
  });
});
