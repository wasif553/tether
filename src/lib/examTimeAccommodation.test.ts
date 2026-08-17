import { describe, expect, it } from "vitest";
import {
  resolveEffectiveExamDurationMins,
  validateExamTimeAccommodationAdjustment,
  buildExamTimeAccommodationSnapshot,
  isValidExamTimeAccommodationMode,
  InvalidExamTimeAccommodationError,
} from "./examTimeAccommodation";

describe("resolveEffectiveExamDurationMins", () => {
  it("standard 60, no accommodation => 60", () => {
    expect(resolveEffectiveExamDurationMins({ standardDurationMins: 60, accommodation: null })).toBe(60);
  });

  it("60 + 25% => 75", () => {
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 },
      }),
    ).toBe(75);
  });

  it("60 + 50% => 90", () => {
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 50 },
      }),
    ).toBe(90);
  });

  it("60 + 100% => 120", () => {
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 100 },
      }),
    ).toBe(120);
  });

  it("50 + 25% => 63 (rounds upward, never shortened by rounding)", () => {
    // 50 * 125 / 100 = 62.5 -> ceil -> 63
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 50,
        accommodation: { adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 },
      }),
    ).toBe(63);
  });

  it("60 + 30 extra minutes => 90", () => {
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "EXTRA_MINUTES", adjustmentValue: 30 },
      }),
    ).toBe(90);
  });

  it("60, custom total 90 => 90", () => {
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "TOTAL_DURATION", adjustmentValue: 90 },
      }),
    ).toBe(90);
  });

  it("standard changed to 100 with custom total 90 => 100 (never reduces below standard)", () => {
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 100,
        accommodation: { adjustmentMode: "TOTAL_DURATION", adjustmentValue: 90 },
      }),
    ).toBe(100);
  });

  it("custom total below standard never shortens the standard duration even at the boundary", () => {
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "TOTAL_DURATION", adjustmentValue: 60 },
      }),
    ).toBe(60);
  });

  it("rejects a zero adjustmentValue", () => {
    expect(() =>
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "EXTRA_MINUTES", adjustmentValue: 0 },
      }),
    ).toThrow(InvalidExamTimeAccommodationError);
  });

  it("rejects a negative adjustmentValue", () => {
    expect(() =>
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "PERCENT_EXTRA", adjustmentValue: -10 },
      }),
    ).toThrow(InvalidExamTimeAccommodationError);
  });

  it("rejects a non-integer adjustmentValue", () => {
    expect(() =>
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "EXTRA_MINUTES", adjustmentValue: 12.5 },
      }),
    ).toThrow(InvalidExamTimeAccommodationError);
  });

  it("rejects a non-finite adjustmentValue", () => {
    expect(() =>
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "EXTRA_MINUTES", adjustmentValue: Infinity },
      }),
    ).toThrow(InvalidExamTimeAccommodationError);
  });

  it("rejects an unknown adjustment mode", () => {
    expect(() =>
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        // @ts-expect-error deliberately invalid mode for the runtime check
        accommodation: { adjustmentMode: "DOUBLE_TIME", adjustmentValue: 10 },
      }),
    ).toThrow(InvalidExamTimeAccommodationError);
  });

  it("rejects a zero or negative standard duration", () => {
    expect(() => resolveEffectiveExamDurationMins({ standardDurationMins: 0, accommodation: null })).toThrow(
      InvalidExamTimeAccommodationError,
    );
    expect(() => resolveEffectiveExamDurationMins({ standardDurationMins: -5, accommodation: null })).toThrow(
      InvalidExamTimeAccommodationError,
    );
  });

  it("rejects an unsafe-integer overflow result", () => {
    expect(() =>
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "EXTRA_MINUTES", adjustmentValue: Number.MAX_SAFE_INTEGER },
      }),
    ).toThrow(InvalidExamTimeAccommodationError);
  });
});

describe("validateExamTimeAccommodationAdjustment", () => {
  it("accepts a valid PERCENT_EXTRA adjustment", () => {
    expect(validateExamTimeAccommodationAdjustment({ adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 })).toEqual({
      adjustmentMode: "PERCENT_EXTRA",
      adjustmentValue: 25,
    });
  });

  it("rejects a non-string mode", () => {
    expect(() => validateExamTimeAccommodationAdjustment({ adjustmentMode: 123, adjustmentValue: 10 })).toThrow(
      InvalidExamTimeAccommodationError,
    );
  });

  it("rejects a missing adjustmentValue", () => {
    expect(() => validateExamTimeAccommodationAdjustment({ adjustmentMode: "EXTRA_MINUTES", adjustmentValue: undefined })).toThrow(
      InvalidExamTimeAccommodationError,
    );
  });
});

describe("isValidExamTimeAccommodationMode", () => {
  it("accepts all three documented modes", () => {
    expect(isValidExamTimeAccommodationMode("PERCENT_EXTRA")).toBe(true);
    expect(isValidExamTimeAccommodationMode("EXTRA_MINUTES")).toBe(true);
    expect(isValidExamTimeAccommodationMode("TOTAL_DURATION")).toBe(true);
  });

  it("rejects an arbitrary percentage-adjacent string not in the allowed set at the type-guard level, while resolveEffectiveExamDurationMins still supports any positive PERCENT_EXTRA value", () => {
    expect(isValidExamTimeAccommodationMode("PERCENT_75")).toBe(false);
    // The pure resolver itself is NOT hardcoded to only 25/50/100 — any
    // positive integer percentage is supported via PERCENT_EXTRA.
    expect(
      resolveEffectiveExamDurationMins({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 75 },
      }),
    ).toBe(105);
  });

  it("rejects non-string values", () => {
    expect(isValidExamTimeAccommodationMode(null)).toBe(false);
    expect(isValidExamTimeAccommodationMode(undefined)).toBe(false);
    expect(isValidExamTimeAccommodationMode(42)).toBe(false);
  });
});

describe("buildExamTimeAccommodationSnapshot", () => {
  it("returns null when there is no accommodation", () => {
    expect(buildExamTimeAccommodationSnapshot({ standardDurationMins: 60, accommodation: null })).toBeNull();
  });

  it("returns the full explainability snapshot for a PERCENT_EXTRA accommodation", () => {
    expect(
      buildExamTimeAccommodationSnapshot({
        standardDurationMins: 60,
        accommodation: { adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 50 },
      }),
    ).toEqual({
      standardDurationMins: 60,
      adjustmentMode: "PERCENT_EXTRA",
      adjustmentValue: 50,
      effectiveDurationMins: 90,
    });
  });

  it("never stores diagnosis/reason fields — snapshot has exactly four keys", () => {
    const snapshot = buildExamTimeAccommodationSnapshot({
      standardDurationMins: 60,
      accommodation: { adjustmentMode: "EXTRA_MINUTES", adjustmentValue: 15 },
    });
    expect(Object.keys(snapshot ?? {}).sort()).toEqual(
      ["adjustmentMode", "adjustmentValue", "effectiveDurationMins", "standardDurationMins"].sort(),
    );
  });
});
