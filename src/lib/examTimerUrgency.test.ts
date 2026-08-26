import { describe, expect, it } from "vitest";
import { getTimerUrgency, timerAccessibleLabel } from "./examTimerUrgency";

describe("getTimerUrgency", () => {
  it("5:01 (301s) is normal", () => {
    expect(getTimerUrgency(301)).toBe("normal");
  });

  it("5:00 (300s) is warning — the boundary belongs to the more urgent tier", () => {
    expect(getTimerUrgency(300)).toBe("warning");
  });

  it("2:01 (121s) is warning", () => {
    expect(getTimerUrgency(121)).toBe("warning");
  });

  it("2:00 (120s) is high — the boundary belongs to the more urgent tier", () => {
    expect(getTimerUrgency(120)).toBe("high");
  });

  it("1:01 (61s) is high", () => {
    expect(getTimerUrgency(61)).toBe("high");
  });

  it("1:00 (60s) is critical — the boundary belongs to the more urgent tier", () => {
    expect(getTimerUrgency(60)).toBe("critical");
  });

  it("0:30 (30s) is critical", () => {
    expect(getTimerUrgency(30)).toBe("critical");
  });

  it("0 seconds remaining is critical", () => {
    expect(getTimerUrgency(0)).toBe("critical");
  });

  it("null (no authoritative remaining time yet) is normal, never an urgent flash on load", () => {
    expect(getTimerUrgency(null)).toBe("normal");
  });
});

describe("timerAccessibleLabel", () => {
  it("normal tier uses exact minutes and seconds", () => {
    expect(timerAccessibleLabel(29 * 60 + 14, "normal")).toBe("29 minutes 14 seconds remaining");
  });

  it("singular minute/second wording when exactly 1 of each", () => {
    expect(timerAccessibleLabel(61, "high")).toBe("2 minutes remaining");
  });

  it("warning tier is rounded to '5 minutes remaining' regardless of exact seconds", () => {
    expect(timerAccessibleLabel(301, "warning")).toBe("5 minutes remaining");
    expect(timerAccessibleLabel(240, "warning")).toBe("5 minutes remaining");
  });

  it("high tier is rounded to '2 minutes remaining'", () => {
    expect(timerAccessibleLabel(90, "high")).toBe("2 minutes remaining");
  });

  it("critical tier is rounded to '1 minute remaining'", () => {
    expect(timerAccessibleLabel(30, "critical")).toBe("1 minute remaining");
  });

  it("returns an empty string when there is no authoritative remaining time", () => {
    expect(timerAccessibleLabel(null, "normal")).toBe("");
  });
});
