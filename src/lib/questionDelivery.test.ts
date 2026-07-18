/**
 * One-Question-At-A-Time Exam Delivery v1 — see
 * docs/one-question-delivery-v1.md and src/lib/questionDelivery.ts.
 *
 * Pure unit tests only — no Prisma/DB, no browser.
 */
import { describe, expect, it } from "vitest";
import {
  buildOptionOrders,
  buildQuestionOrder,
  buildSelectedQuestionIds,
  canNavigateNext,
  canNavigatePrevious,
  clampQuestionIndex,
  isBlockedBackNavigation,
  nextAllowedIndex,
  resolveEffectiveQuestionIds,
  resolveOptionOrder,
  resolveQuestionOrder,
  resolveSelectedQuestionIds,
  shuffleWithRng,
} from "./questionDelivery";

// Deterministic fake RNG for reproducible shuffle assertions.
function fakeRng(sequence: number[]): () => number {
  let i = 0;
  return () => sequence[i++ % sequence.length];
}

describe("shuffleWithRng", () => {
  it("never mutates the input array", () => {
    const original = ["a", "b", "c"];
    const copy = [...original];
    shuffleWithRng(original, fakeRng([0.9, 0.1]));
    expect(original).toEqual(copy);
  });

  it("returns the same elements, just reordered", () => {
    const result = shuffleWithRng(["a", "b", "c", "d"], fakeRng([0.9, 0.1, 0.5]));
    expect([...result].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("is deterministic for a given rng sequence", () => {
    const rngSeq = [0.9, 0.1, 0.5];
    const r1 = shuffleWithRng(["a", "b", "c", "d"], fakeRng(rngSeq));
    const r2 = shuffleWithRng(["a", "b", "c", "d"], fakeRng(rngSeq));
    expect(r1).toEqual(r2);
  });
});

describe("buildQuestionOrder", () => {
  it("11. preserves the original order when randomiseQuestionOrder is false", () => {
    const ids = ["q1", "q2", "q3"];
    expect(buildQuestionOrder({ questionIds: ids, randomiseQuestionOrder: false })).toEqual(ids);
  });

  it("shuffles when randomiseQuestionOrder is true", () => {
    const ids = ["q1", "q2", "q3", "q4"];
    const result = buildQuestionOrder({
      questionIds: ids,
      randomiseQuestionOrder: true,
      rng: fakeRng([0.9, 0.1, 0.5]),
    });
    expect([...result].sort()).toEqual([...ids].sort());
  });

  it("10. different rng sequences (simulating different submissions) can produce different orders", () => {
    const ids = ["q1", "q2", "q3", "q4", "q5"];
    const orderA = buildQuestionOrder({ questionIds: ids, randomiseQuestionOrder: true, rng: fakeRng([0.9, 0.1, 0.5, 0.2]) });
    const orderB = buildQuestionOrder({ questionIds: ids, randomiseQuestionOrder: true, rng: fakeRng([0.1, 0.9, 0.05, 0.8]) });
    expect(orderA).not.toEqual(orderB);
  });
});

describe("buildOptionOrders", () => {
  const questions = [
    { id: "q1", type: "MULTIPLE_CHOICE", options: ["A", "B", "C"] },
    { id: "q2", type: "SHORT_ANSWER", options: null },
    { id: "q3", type: "ESSAY", options: null },
  ];

  it("returns an empty map when randomiseMcqOptionOrder is false", () => {
    expect(buildOptionOrders({ questions, randomiseMcqOptionOrder: false })).toEqual({});
  });

  it("only randomises MULTIPLE_CHOICE questions, never essay/short-answer", () => {
    const result = buildOptionOrders({ questions, randomiseMcqOptionOrder: true, rng: fakeRng([0.9, 0.1]) });
    expect(Object.keys(result)).toEqual(["q1"]);
    expect([...result.q1].sort()).toEqual(["A", "B", "C"]);
  });

  it("skips MCQ questions with no options or only one option", () => {
    const result = buildOptionOrders({
      questions: [
        { id: "q1", type: "MULTIPLE_CHOICE", options: null },
        { id: "q2", type: "MULTIPLE_CHOICE", options: ["only one"] },
      ],
      randomiseMcqOptionOrder: true,
    });
    expect(result).toEqual({});
  });
});

describe("resolveQuestionOrder", () => {
  const originalIds = ["q1", "q2", "q3"];

  it("9. returns the stored order when it exists and matches the current question set", () => {
    const stored = { questionIds: ["q3", "q1", "q2"] };
    expect(resolveQuestionOrder(originalIds, stored)).toEqual(["q3", "q1", "q2"]);
  });

  it("11. falls back to the original order when nothing is stored", () => {
    expect(resolveQuestionOrder(originalIds, null)).toEqual(originalIds);
    expect(resolveQuestionOrder(originalIds, undefined)).toEqual(originalIds);
  });

  it("falls back to the original order when the stored order's question set no longer matches (e.g. a question was added/removed)", () => {
    const stale = { questionIds: ["q1", "q2"] }; // missing q3
    expect(resolveQuestionOrder(originalIds, stale)).toEqual(originalIds);
  });

  it("falls back on malformed stored data", () => {
    expect(resolveQuestionOrder(originalIds, { questionIds: "not-an-array" })).toEqual(originalIds);
    expect(resolveQuestionOrder(originalIds, "garbage")).toEqual(originalIds);
  });
});

describe("resolveOptionOrder", () => {
  const originalOptions = ["A", "B", "C"];

  it("returns the stored per-question option order when valid", () => {
    const stored = { questionIds: ["q1"], optionOrders: { q1: ["C", "A", "B"] } };
    expect(resolveOptionOrder("q1", originalOptions, stored)).toEqual(["C", "A", "B"]);
  });

  it("falls back to the original options when no stored order exists for this question", () => {
    const stored = { questionIds: ["q1"], optionOrders: {} };
    expect(resolveOptionOrder("q1", originalOptions, stored)).toEqual(originalOptions);
  });

  it("falls back when stored options don't match the current option set", () => {
    const stored = { questionIds: ["q1"], optionOrders: { q1: ["A", "B"] } }; // missing C
    expect(resolveOptionOrder("q1", originalOptions, stored)).toEqual(originalOptions);
  });
});

describe("clampQuestionIndex / canNavigatePrevious / canNavigateNext", () => {
  it("clamps within [0, total-1]", () => {
    expect(clampQuestionIndex(-5, 5)).toBe(0);
    expect(clampQuestionIndex(2, 5)).toBe(2);
    expect(clampQuestionIndex(99, 5)).toBe(4);
    expect(clampQuestionIndex(0, 0)).toBe(0);
  });

  it("14. canNavigatePrevious is false when allowBackNavigation is false, regardless of index", () => {
    expect(canNavigatePrevious(3, false)).toBe(false);
    expect(canNavigatePrevious(0, false)).toBe(false);
  });

  it("canNavigatePrevious is true only when allowBackNavigation is true and index > 0", () => {
    expect(canNavigatePrevious(3, true)).toBe(true);
    expect(canNavigatePrevious(0, true)).toBe(false);
  });

  it("canNavigateNext is true until the last question", () => {
    expect(canNavigateNext(0, 5)).toBe(true);
    expect(canNavigateNext(4, 5)).toBe(false);
  });
});

describe("nextAllowedIndex / isBlockedBackNavigation", () => {
  it("moves freely forward and backward when allowBackNavigation is true", () => {
    expect(nextAllowedIndex(0, 3, true, 5)).toBe(0);
    expect(nextAllowedIndex(4, 1, true, 5)).toBe(4);
  });

  it("13/14. never allows moving below the stored index when allowBackNavigation is false", () => {
    expect(nextAllowedIndex(1, 3, false, 5)).toBe(3); // requested backward -> stays put
    expect(nextAllowedIndex(4, 3, false, 5)).toBe(4); // requested forward -> allowed
    expect(nextAllowedIndex(3, 3, false, 5)).toBe(3); // same question -> unchanged
  });

  it("clamps out-of-range requests before applying the back-navigation floor", () => {
    expect(nextAllowedIndex(99, 2, false, 5)).toBe(4);
    expect(nextAllowedIndex(-1, 2, false, 5)).toBe(2);
  });

  it("identifies a blocked back-navigation attempt for integrity logging", () => {
    expect(isBlockedBackNavigation(1, 3, false)).toBe(true);
    expect(isBlockedBackNavigation(4, 3, false)).toBe(false);
    expect(isBlockedBackNavigation(1, 3, true)).toBe(false);
  });
});

// Question Pools v1 — see docs/question-pools-v1.md.
describe("buildSelectedQuestionIds", () => {
  const q = (id: string, questionPoolId: string | null, order: number) => ({ id, questionPoolId, order });

  it("7. unpooled questions are always included", () => {
    const result = buildSelectedQuestionIds({
      questions: [q("u1", null, 0), q("u2", null, 1)],
      pools: [],
      randomiseQuestionOrder: false,
    });
    expect(result.sort()).toEqual(["u1", "u2"]);
  });

  it("2. selects exactly drawCount questions from a pool", () => {
    const questions = [
      q("u1", null, 0),
      q("p1", "poolA", 1),
      q("p2", "poolA", 2),
      q("p3", "poolA", 3),
      q("p4", "poolA", 4),
    ];
    const result = buildSelectedQuestionIds({
      questions,
      pools: [{ id: "poolA", drawCount: 2 }],
      randomiseQuestionOrder: false,
      rng: fakeRng([0.9, 0.1, 0.5]),
    });
    // 1 unpooled + 2 drawn from the pool of 4.
    expect(result).toHaveLength(3);
    expect(result).toContain("u1");
    const drawnFromPool = result.filter((id) => id !== "u1");
    expect(drawnFromPool).toHaveLength(2);
    for (const id of drawnFromPool) expect(["p1", "p2", "p3", "p4"]).toContain(id);
  });

  it("6. drawCount greater than available questions includes all available questions, no error", () => {
    const questions = [q("p1", "poolA", 0), q("p2", "poolA", 1)];
    const result = buildSelectedQuestionIds({
      questions,
      pools: [{ id: "poolA", drawCount: 100 }],
      randomiseQuestionOrder: false,
    });
    expect(result.sort()).toEqual(["p1", "p2"]);
  });

  it("drawCount null or 0 includes every question in the pool", () => {
    const questions = [q("p1", "poolA", 0), q("p2", "poolA", 1), q("p3", "poolA", 2)];
    expect(
      buildSelectedQuestionIds({ questions, pools: [{ id: "poolA", drawCount: null }], randomiseQuestionOrder: false }).sort(),
    ).toEqual(["p1", "p2", "p3"]);
    expect(
      buildSelectedQuestionIds({ questions, pools: [{ id: "poolA", drawCount: 0 }], randomiseQuestionOrder: false }).sort(),
    ).toEqual(["p1", "p2", "p3"]);
  });

  it("preserves original Question.order for the selected set when randomiseQuestionOrder is false", () => {
    const questions = [q("q3", null, 2), q("q1", null, 0), q("q2", null, 1)];
    const result = buildSelectedQuestionIds({ questions, pools: [], randomiseQuestionOrder: false });
    expect(result).toEqual(["q1", "q2", "q3"]);
  });

  it("13. shuffles the combined selected set when randomiseQuestionOrder is true", () => {
    const questions = [q("q1", null, 0), q("q2", null, 1), q("q3", null, 2), q("q4", null, 3)];
    const result = buildSelectedQuestionIds({
      questions,
      pools: [],
      randomiseQuestionOrder: true,
      rng: fakeRng([0.9, 0.1, 0.5, 0.2]),
    });
    expect(result.sort()).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("never selects a question from a pool that isn't listed in pools (orphaned pool reference)", () => {
    const questions = [q("p1", "poolA", 0)];
    const result = buildSelectedQuestionIds({ questions, pools: [], randomiseQuestionOrder: false });
    expect(result).toEqual([]);
  });

  it("5. two independently-generated draws (simulating different submissions) usually differ", () => {
    const questions = Array.from({ length: 10 }, (_, i) => q(`p${i}`, "poolA", i));
    const drawA = buildSelectedQuestionIds({
      questions,
      pools: [{ id: "poolA", drawCount: 4 }],
      randomiseQuestionOrder: false,
      rng: fakeRng([0.9, 0.1, 0.5, 0.2, 0.7]),
    });
    const drawB = buildSelectedQuestionIds({
      questions,
      pools: [{ id: "poolA", drawCount: 4 }],
      randomiseQuestionOrder: false,
      rng: fakeRng([0.1, 0.9, 0.05, 0.8, 0.3]),
    });
    expect(drawA.sort()).not.toEqual(drawB.sort());
  });
});

describe("resolveSelectedQuestionIds", () => {
  const examQuestionIds = ["q1", "q2", "q3", "q4", "q5"];

  it("4/9. returns the stored selection when valid (a genuine subset of exam questions)", () => {
    const stored = { questionIds: [], selectedQuestionIds: ["q3", "q1"] };
    expect(resolveSelectedQuestionIds(examQuestionIds, stored)).toEqual(["q3", "q1"]);
  });

  it("falls back to every exam question when nothing is stored (pools enabled after attempt start)", () => {
    expect(resolveSelectedQuestionIds(examQuestionIds, null)).toEqual(examQuestionIds);
    expect(resolveSelectedQuestionIds(examQuestionIds, { questionIds: [] })).toEqual(examQuestionIds);
  });

  it("filters out any stored id that is no longer a valid exam question", () => {
    const stored = { questionIds: [], selectedQuestionIds: ["q1", "deleted-question", "q2"] };
    expect(resolveSelectedQuestionIds(examQuestionIds, stored)).toEqual(["q1", "q2"]);
  });

  it("falls back if every stored id is now invalid", () => {
    const stored = { questionIds: [], selectedQuestionIds: ["gone1", "gone2"] };
    expect(resolveSelectedQuestionIds(examQuestionIds, stored)).toEqual(examQuestionIds);
  });

  it("deduplicates stored ids", () => {
    const stored = { questionIds: [], selectedQuestionIds: ["q1", "q1", "q2"] };
    expect(resolveSelectedQuestionIds(examQuestionIds, stored)).toEqual(["q1", "q2"]);
  });
});

describe("resolveEffectiveQuestionIds", () => {
  const examQuestionIds = ["q1", "q2", "q3"];

  it("uses the pool-selection resolver when questionPoolsActive is true", () => {
    const stored = { questionIds: ["irrelevant"], selectedQuestionIds: ["q2"] };
    expect(
      resolveEffectiveQuestionIds({ examQuestionIds, stored, questionPoolsActive: true }),
    ).toEqual(["q2"]);
  });

  it("uses the plain full-exam resolver when questionPoolsActive is false (existing behavior unchanged)", () => {
    const stored = { questionIds: ["q3", "q1", "q2"] };
    expect(
      resolveEffectiveQuestionIds({ examQuestionIds, stored, questionPoolsActive: false }),
    ).toEqual(["q3", "q1", "q2"]);
  });
});
