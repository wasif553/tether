import { describe, it, expect } from "vitest";
import {
  computeSynchronisedAnswerTimesSignal,
  computeSynchronisedSubstantialEditsSignal,
  computeRepeatedSharedActivityBurstsSignal,
  type TimedEvent,
} from "./timingSync";

function ev(questionId: string | null, atMs: number, delta: number | null = null): TimedEvent {
  return { questionId, serverReceivedAtMs: atMs, responseLengthDelta: delta };
}

describe("computeSynchronisedAnswerTimesSignal", () => {
  it("one synchronised answer-save is never enough", () => {
    const a = [ev("q1", 100_000)];
    const b = [ev("q1", 100_500)];
    expect(computeSynchronisedAnswerTimesSignal(a, b)).toHaveLength(0);
  });

  it("repeated synchronised saves across multiple questions produce a signal", () => {
    const a = [ev("q1", 100_000), ev("q2", 200_000), ev("q3", 300_000)];
    const b = [ev("q1", 100_500), ev("q2", 200_800), ev("q3", 300_300)];
    const signals = computeSynchronisedAnswerTimesSignal(a, b);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("SYNCHRONISED_ANSWER_TIMES");
  });
});

describe("computeSynchronisedSubstantialEditsSignal", () => {
  it("one synchronised substantial edit is never enough", () => {
    const a = [ev("q1", 100_000, 300)];
    const b = [ev("q1", 100_500, 300)];
    expect(computeSynchronisedSubstantialEditsSignal(a, b)).toHaveLength(0);
  });

  it("repeated synchronised substantial edits produce a signal", () => {
    const a = [ev("q1", 100_000, 300), ev("q2", 200_000, 400)];
    const b = [ev("q1", 100_500, 300), ev("q2", 200_700, 400)];
    const signals = computeSynchronisedSubstantialEditsSignal(a, b);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("SYNCHRONISED_SUBSTANTIAL_EDITS");
  });

  it("small edits (below the substantial-edit threshold) never count, however synchronised", () => {
    const a = [ev("q1", 100_000, 10), ev("q2", 200_000, 5)];
    const b = [ev("q1", 100_500, 10), ev("q2", 200_700, 5)];
    expect(computeSynchronisedSubstantialEditsSignal(a, b)).toHaveLength(0);
  });
});

describe("computeRepeatedSharedActivityBurstsSignal", () => {
  it("a single shared burst is never enough", () => {
    const a = [ev(null, 1000), ev(null, 1100)];
    const b = [ev(null, 1050)];
    expect(computeRepeatedSharedActivityBurstsSignal(a, b)).toHaveLength(0);
  });

  it("repeated shared bursts across separate episodes produce a signal", () => {
    const a = [ev(null, 1000), ev(null, 60_000), ev(null, 120_000)];
    const b = [ev(null, 1005), ev(null, 60_005), ev(null, 120_010)];
    const signals = computeRepeatedSharedActivityBurstsSignal(a, b);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("REPEATED_SHARED_ACTIVITY_BURSTS");
  });
});
