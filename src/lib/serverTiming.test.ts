import { describe, it, expect, vi } from "vitest";
import {
  createTimingCollector,
  timeSpan,
  buildServerTimingHeaderValue,
  isServerTimingHeaderEnabled,
  attachServerTimingHeader,
  buildBoundedTimingLogRecord,
  logBoundedNavigationTiming,
} from "./serverTiming";

describe("createTimingCollector", () => {
  it("records entries in the order they were recorded, clamping negative durations to 0", () => {
    const collector = createTimingCollector();
    collector.record("authMs", 12.3);
    collector.record("dbMs", -5);
    collector.record("authMs", 4.1);
    expect(collector.entries()).toEqual([
      { name: "authMs", durationMs: 12.3 },
      { name: "dbMs", durationMs: 0 },
      { name: "authMs", durationMs: 4.1 },
    ]);
  });

  it("starts empty", () => {
    expect(createTimingCollector().entries()).toEqual([]);
  });
});

describe("timeSpan", () => {
  it("records the elapsed time for an async span and passes the return value through unchanged", async () => {
    const collector = createTimingCollector();
    const result = await timeSpan(collector, "queryMs", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "the-value";
    });
    expect(result).toBe("the-value");
    expect(collector.entries()).toHaveLength(1);
    expect(collector.entries()[0].name).toBe("queryMs");
    expect(collector.entries()[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a synchronous span too", async () => {
    const collector = createTimingCollector();
    const result = await timeSpan(collector, "syncMs", () => 42);
    expect(result).toBe(42);
    expect(collector.entries()).toHaveLength(1);
  });

  it("is a pure pass-through with zero overhead when no collector is given — never throws, never requires a caller to branch", async () => {
    const result = await timeSpan(undefined, "authMs", async () => "value");
    expect(result).toBe("value");
  });

  it("still records the span even when the wrapped function throws, then rethrows", async () => {
    const collector = createTimingCollector();
    await expect(
      timeSpan(collector, "failingMs", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(collector.entries()).toHaveLength(1);
  });
});

describe("buildServerTimingHeaderValue", () => {
  it("formats entries as name;dur=X.X, comma-separated", () => {
    const value = buildServerTimingHeaderValue([
      { name: "authMs", durationMs: 12.34 },
      { name: "submissionLookupMs", durationMs: 45.6 },
    ]);
    expect(value).toBe("authMs;dur=12.3, submissionLookupMs;dur=45.6");
  });

  it("returns an empty string for no entries", () => {
    expect(buildServerTimingHeaderValue([])).toBe("");
  });

  it("strips anything outside [A-Za-z0-9_-] from a stage name — the Server-Timing token grammar, and a defensive guarantee no request-specific content can ever reach the header", () => {
    const value = buildServerTimingHeaderValue([{ name: "auth Ms; evil=1, x", durationMs: 1 }]);
    expect(value).toBe("authMsevil1x;dur=1.0");
  });

  it("falls back to a safe placeholder name if sanitization empties it out entirely", () => {
    const value = buildServerTimingHeaderValue([{ name: "!!!", durationMs: 1 }]);
    expect(value).toBe("stage;dur=1.0");
  });

  it("clamps a negative duration to 0 even if it bypassed the collector (e.g. a hand-built entry)", () => {
    expect(buildServerTimingHeaderValue([{ name: "x", durationMs: -3 }])).toBe("x;dur=0.0");
  });
});

describe("isServerTimingHeaderEnabled", () => {
  it("is true only for the exact literal string 'true'", () => {
    expect(isServerTimingHeaderEnabled("true")).toBe(true);
  });

  it("is false for undefined, empty, or any other value — including in a production-like environment, since this gate has no environment check at all", () => {
    expect(isServerTimingHeaderEnabled(undefined)).toBe(false);
    expect(isServerTimingHeaderEnabled("")).toBe(false);
    expect(isServerTimingHeaderEnabled("1")).toBe(false);
    expect(isServerTimingHeaderEnabled("TRUE")).toBe(false);
    expect(isServerTimingHeaderEnabled("false")).toBe(false);
  });
});

describe("attachServerTimingHeader", () => {
  it("sets the Server-Timing header when enabled and entries exist", () => {
    const collector = createTimingCollector();
    collector.record("authMs", 10);
    const setHeader = vi.fn();
    attachServerTimingHeader({ headers: { set: setHeader } }, collector, "true");
    expect(setHeader).toHaveBeenCalledWith("Server-Timing", "authMs;dur=10.0");
  });

  it("never sets the header when the flag is not enabled — the default, safe-for-production state", () => {
    const collector = createTimingCollector();
    collector.record("authMs", 10);
    const setHeader = vi.fn();
    attachServerTimingHeader({ headers: { set: setHeader } }, collector, undefined);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("never sets the header when enabled but nothing was recorded", () => {
    const setHeader = vi.fn();
    attachServerTimingHeader({ headers: { set: setHeader } }, createTimingCollector(), "true");
    expect(setHeader).not.toHaveBeenCalled();
  });
});

describe("buildBoundedTimingLogRecord", () => {
  it("shapes a record with event, route, and one rounded field per recorded stage — nothing else", () => {
    const collector = createTimingCollector();
    collector.record("authMs", 12.345);
    collector.record("submissionLookupMs", 45.6);
    expect(buildBoundedTimingLogRecord("save-and-navigate", collector)).toEqual({
      event: "TETHER_NAVIGATION_TIMING",
      route: "save-and-navigate",
      authMs: 12.35,
      submissionLookupMs: 45.6,
    });
  });

  it("never includes a stage that was never recorded — e.g. leaseCheckMs is simply absent for a STANDARD_WEB submission, not null/0", () => {
    const collector = createTimingCollector();
    collector.record("authMs", 1);
    const record = buildBoundedTimingLogRecord("question-progress", collector);
    expect(record).not.toHaveProperty("leaseCheckMs");
    expect(Object.keys(record)).toEqual(["event", "route", "authMs"]);
  });

  it("sanitizes stage names the same way the Server-Timing header does — no free-text field can smuggle anything through", () => {
    const collector = createTimingCollector();
    collector.record("weird name!!", 1);
    expect(buildBoundedTimingLogRecord("x", collector)).toEqual({ event: "TETHER_NAVIGATION_TIMING", route: "x", weirdname: 1 });
  });
});

describe("logBoundedNavigationTiming", () => {
  it("logs exactly one single-line JSON record when enabled and something was recorded", () => {
    const collector = createTimingCollector();
    collector.record("totalMs", 123.4);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logBoundedNavigationTiming("save-and-navigate", collector, "true");
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(spy.mock.calls[0][0] as string);
      expect(logged).toEqual({ event: "TETHER_NAVIGATION_TIMING", route: "save-and-navigate", totalMs: 123.4 });
    } finally {
      spy.mockRestore();
    }
  });

  it("never logs when the flag is off — the default", () => {
    const collector = createTimingCollector();
    collector.record("totalMs", 123.4);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logBoundedNavigationTiming("save-and-navigate", collector, undefined);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("never logs when enabled but nothing was recorded", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logBoundedNavigationTiming("save-and-navigate", createTimingCollector(), "true");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
