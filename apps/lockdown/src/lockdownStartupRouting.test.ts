import { describe, it, expect } from "vitest";
import {
  resolveStartupLoadUrl,
  parseExamIdFromDeepLinkUrl,
  findDeepLinkArg,
  resolveInitialExamIdFromArgv,
  TETHER_HOME_PATH,
} from "./lockdownStartupRouting";

// ---------------------------------------------------------------------------
// URGENT fix — confirmed physical Windows issue: a normal launch (Start
// Menu/desktop shortcut/exe, no deep link) opened directly into a
// previously deep-linked exam instead of Home/Dashboard, because the old
// buildLoadUrl fell back to a persisted `lastExamId` from electron-store.
// resolveStartupLoadUrl takes no store parameter at all — these tests
// prove, structurally, that no previous-launch state can ever leak into a
// later one.
// ---------------------------------------------------------------------------

const BASE_URL = "https://tether-murex.vercel.app";

describe("resolveStartupLoadUrl — normal launch always goes Home, never a previous exam", () => {
  it("[1] no examId (normal Start Menu/shortcut/exe launch) resolves to the Home/Dashboard route", () => {
    expect(resolveStartupLoadUrl(null, BASE_URL)).toBe(`${BASE_URL}${TETHER_HOME_PATH}`);
  });

  it("empty-string examId (malformed deep link with a blank param) also resolves to Home, not a fallback exam", () => {
    expect(resolveStartupLoadUrl("", BASE_URL)).toBe(`${BASE_URL}${TETHER_HOME_PATH}`);
  });

  it("[5] a valid fresh examId resolves to that exam's Tether launch route", () => {
    expect(resolveStartupLoadUrl("exam-123", BASE_URL)).toBe(`${BASE_URL}/student/exams/exam-123/tether-launch`);
  });

  it("[6] a second call with a DIFFERENT examId resolves to the new exam, never reusing the first", () => {
    const first = resolveStartupLoadUrl("exam-123", BASE_URL);
    const second = resolveStartupLoadUrl("exam-456", BASE_URL);
    expect(first).toContain("exam-123");
    expect(second).toContain("exam-456");
    expect(second).not.toContain("exam-123");
  });

  it("[3, 4] repeated no-examId calls after a deep-linked call still resolve to Home — no statefulness/memoization leaks between calls (pure function, no persisted store)", () => {
    resolveStartupLoadUrl("exam-789", BASE_URL); // a prior deep-linked call
    expect(resolveStartupLoadUrl(null, BASE_URL)).toBe(`${BASE_URL}${TETHER_HOME_PATH}`);
    expect(resolveStartupLoadUrl(null, BASE_URL)).toBe(`${BASE_URL}${TETHER_HOME_PATH}`);
  });
});

describe("parseExamIdFromDeepLinkUrl", () => {
  it("extracts examId from a tether:// deep link", () => {
    expect(parseExamIdFromDeepLinkUrl("tether://launch?examId=abc123")).toBe("abc123");
  });

  it("extracts examId from a legacy ses:// deep link", () => {
    expect(parseExamIdFromDeepLinkUrl("ses://launch?examId=xyz789")).toBe("xyz789");
  });

  it("[7] a malformed (unparseable) URL returns null, not a thrown error", () => {
    expect(parseExamIdFromDeepLinkUrl("not a url at all")).toBeNull();
  });

  it("[7] a well-formed deep link with no examId query param returns null", () => {
    expect(parseExamIdFromDeepLinkUrl("tether://launch")).toBeNull();
  });

  it("an empty string returns null", () => {
    expect(parseExamIdFromDeepLinkUrl("")).toBeNull();
  });
});

describe("findDeepLinkArg / resolveInitialExamIdFromArgv", () => {
  it("[2] normal launch argv (no deep link present) yields null — no examId at all", () => {
    expect(findDeepLinkArg(["C:\\Tether\\Tether.exe"])).toBeNull();
    expect(resolveInitialExamIdFromArgv(["C:\\Tether\\Tether.exe"])).toBeNull();
  });

  it("finds a tether:// deep-link argv entry among other argv values", () => {
    expect(findDeepLinkArg(["C:\\Tether\\Tether.exe", "tether://launch?examId=abc"])).toBe("tether://launch?examId=abc");
  });

  it("[5] resolves the examId directly from a deep-link argv entry", () => {
    expect(resolveInitialExamIdFromArgv(["C:\\Tether\\Tether.exe", "tether://launch?examId=abc"])).toBe("abc");
  });

  it("[8] a deep-link argv entry with no examId resolves to null (safe Home fallback upstream), not a controlled failure that defaults to an exam", () => {
    expect(resolveInitialExamIdFromArgv(["C:\\Tether\\Tether.exe", "tether://launch"])).toBeNull();
  });

  it("[15] resolving twice with different argv never carries state between calls — no hardcoded/memoized exam id", () => {
    expect(resolveInitialExamIdFromArgv(["tether://launch?examId=first"])).toBe("first");
    expect(resolveInitialExamIdFromArgv(["C:\\Tether\\Tether.exe"])).toBeNull();
    expect(resolveInitialExamIdFromArgv(["tether://launch?examId=second"])).toBe("second");
  });
});
