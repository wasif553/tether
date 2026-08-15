import { describe, expect, it } from "vitest";
import {
  nextRevision,
  shouldSupersede,
  isEntryExpired,
  computeBackoffDelayMs,
  classifyAcknowledgement,
  summarizeQueue,
  scopedKey,
  classifySaveFailureCategory,
  buildSaveAttemptDiagnostics,
  classifyNavigationSaveStrategy,
  PENDING_SAVE_RETENTION_MS,
} from "./pendingSaveQueue";

describe("pendingSaveQueue — pure logic (Part 2/3)", () => {
  it("scopedKey is scoped per user+submission+question — different users never collide", () => {
    expect(scopedKey("u1", "s1", "q1")).not.toBe(scopedKey("u2", "s1", "q1"));
    expect(scopedKey("u1", "s1", "q1")).toBe(scopedKey("u1", "s1", "q1"));
  });

  it("nextRevision starts at 1 and increments monotonically", () => {
    expect(nextRevision(undefined)).toBe(1);
    expect(nextRevision(null)).toBe(1);
    expect(nextRevision(1)).toBe(2);
    expect(nextRevision(41)).toBe(42);
  });

  // Requirement 4 — "newer revision supersedes older queued revision safely".
  it("shouldSupersede: a strictly greater revision always supersedes; equal or lower never does", () => {
    expect(shouldSupersede(undefined, 1)).toBe(true);
    expect(shouldSupersede({ revision: 3 }, 4)).toBe(true);
    expect(shouldSupersede({ revision: 3 }, 3)).toBe(false);
    expect(shouldSupersede({ revision: 3 }, 2)).toBe(false);
  });

  // Requirement 9 — "pending queue retention expiry works".
  it("isEntryExpired: false within retention, true once past it", () => {
    const now = 1_000_000;
    const entry = { queuedAtMs: now - PENDING_SAVE_RETENTION_MS + 1000 };
    expect(isEntryExpired(entry, now, PENDING_SAVE_RETENTION_MS)).toBe(false);
    const expired = { queuedAtMs: now - PENDING_SAVE_RETENTION_MS - 1 };
    expect(isEntryExpired(expired, now, PENDING_SAVE_RETENTION_MS)).toBe(true);
  });

  it("computeBackoffDelayMs is bounded exponential, capped at the configured max", () => {
    expect(computeBackoffDelayMs(0, 60)).toBe(1000);
    expect(computeBackoffDelayMs(1, 60)).toBe(2000);
    expect(computeBackoffDelayMs(2, 60)).toBe(4000);
    // Large retry counts must never exceed the configured ceiling — no request storm.
    expect(computeBackoffDelayMs(50, 60)).toBe(60_000);
    expect(computeBackoffDelayMs(5, 10)).toBeLessThanOrEqual(10_000);
  });

  // Requirement 2/3 — "a stale response arriving after a newer save must
  // not regress UI state" / "an older revision must not overwrite a
  // newer acknowledged revision".
  it("classifyAcknowledgement: equal or unknown acknowledged revision is SAVED, a strictly newer one is CONFLICT", () => {
    expect(classifyAcknowledgement(5, 5)).toBe("SAVED");
    expect(classifyAcknowledgement(5, null)).toBe("SAVED");
    expect(classifyAcknowledgement(5, 6)).toBe("CONFLICT");
    expect(classifyAcknowledgement(5, 4)).toBe("SAVED"); // server clamped to its own floor — still not a regression for THIS request
  });

  it("summarizeQueue reports pending count and whether any entry has already been retried", () => {
    expect(summarizeQueue([])).toEqual({ pendingCount: 0, hasFailedRetries: false });
    expect(summarizeQueue([{ retryCount: 0 }, { retryCount: 0 }])).toEqual({ pendingCount: 2, hasFailedRetries: false });
    expect(summarizeQueue([{ retryCount: 0 }, { retryCount: 2 }])).toEqual({ pendingCount: 2, hasFailedRetries: true });
  });
});

// Physical acceptance follow-up ("answer could not be saved" symptom) —
// bounded save-failure diagnostic classification. See
// SaveAttemptDiagnostics's own doc comment: these must never see (and
// therefore can never leak) answer text, question text, cookies, lease
// contents, or credentials — every input here is already a plain
// operational fact (a status code, a duration, a couple of booleans).
describe("pendingSaveQueue — bounded save-failure diagnostics", () => {
  it("classifySaveFailureCategory: timeout takes priority, then thrown network error, then HTTP status bands", () => {
    expect(classifySaveFailureCategory({ threw: true, timedOut: true, httpStatus: null })).toBe("TIMEOUT");
    expect(classifySaveFailureCategory({ threw: true, timedOut: false, httpStatus: null })).toBe("NETWORK_ERROR");
    expect(classifySaveFailureCategory({ threw: false, timedOut: false, httpStatus: null })).toBe("UNKNOWN");
    expect(classifySaveFailureCategory({ threw: false, timedOut: false, httpStatus: 403 })).toBe("HTTP_CLIENT_ERROR");
    expect(classifySaveFailureCategory({ threw: false, timedOut: false, httpStatus: 409 })).toBe("HTTP_CLIENT_ERROR");
    expect(classifySaveFailureCategory({ threw: false, timedOut: false, httpStatus: 500 })).toBe("HTTP_SERVER_ERROR");
    expect(classifySaveFailureCategory({ threw: false, timedOut: false, httpStatus: 503 })).toBe("HTTP_SERVER_ERROR");
  });

  it("buildSaveAttemptDiagnostics carries through every safe field unchanged and derives the right category", () => {
    const d = buildSaveAttemptDiagnostics({
      threw: false,
      timedOut: false,
      httpStatus: 403,
      serverErrorCode: "TETHER_CONTENT_ACCESS_REQUIRED",
      durationMs: 842,
      clientRevision: 7,
      retryCount: 2,
      queueRetained: true,
    });
    expect(d).toEqual({
      category: "HTTP_CLIENT_ERROR",
      httpStatus: 403,
      serverErrorCode: "TETHER_CONTENT_ACCESS_REQUIRED",
      durationMs: 842,
      threw: false,
      timedOut: false,
      clientRevision: 7,
      retryCount: 2,
      queueRetained: true,
    });
  });

  it("diagnostics for a timeout never carry an HTTP status or server error code", () => {
    const d = buildSaveAttemptDiagnostics({
      threw: false,
      timedOut: true,
      httpStatus: null,
      serverErrorCode: null,
      durationMs: 15_000,
      clientRevision: 1,
      retryCount: 0,
      queueRetained: true,
    });
    expect(d.category).toBe("TIMEOUT");
    expect(d.httpStatus).toBeNull();
    expect(d.serverErrorCode).toBeNull();
  });
});

// Physical acceptance follow-up — save/next latency diagnosis. Pure
// extraction of navigateQuestion()'s own three-way navigation-strategy
// split (src/app/student/exams/[id]/page.tsx), so the exact same decision
// the UI makes on every Next/Previous click is independently,
// behaviorally testable without a DOM/React-rendering harness.
describe("pendingSaveQueue — classifyNavigationSaveStrategy (clean / dirty / in-flight-reuse)", () => {
  it("A. clean navigation: an untouched question (response undefined) never triggers a save", () => {
    expect(classifyNavigationSaveStrategy({ responseIsDefined: false, isAcknowledged: false, hasInFlightSave: false })).toBe("SKIP_SAVE");
  });

  it("A. clean navigation: content already matching the last genuine server acknowledgement never triggers a save, even if (impossibly) something were also in flight", () => {
    expect(classifyNavigationSaveStrategy({ responseIsDefined: true, isAcknowledged: true, hasInFlightSave: false })).toBe("SKIP_SAVE");
    expect(classifyNavigationSaveStrategy({ responseIsDefined: true, isAcknowledged: true, hasInFlightSave: true })).toBe("SKIP_SAVE");
  });

  it("C. exact in-flight save reuse: dirty content with an identical-content save already outstanding reuses it rather than duplicating", () => {
    expect(classifyNavigationSaveStrategy({ responseIsDefined: true, isAcknowledged: false, hasInFlightSave: true })).toBe("REUSE_IN_FLIGHT_SAVE");
  });

  it("B. dirty navigation: not acknowledged and nothing in flight -> the single combined save-and-navigate round trip", () => {
    expect(classifyNavigationSaveStrategy({ responseIsDefined: true, isAcknowledged: false, hasInFlightSave: false })).toBe("COMBINED_SAVE_AND_NAVIGATE");
  });

  it("isAcknowledged is checked before hasInFlightSave — matches navigateQuestion()'s own short-circuit order (response !== undefined && !isAcknowledged && !hasInFlightSave)", () => {
    // Every one of the 2x2 (isAcknowledged, hasInFlightSave) combinations
    // with responseIsDefined:true, cross-checked against the exact
    // boolean expression this function replaces.
    const cases = [
      { isAcknowledged: false, hasInFlightSave: false, expected: "COMBINED_SAVE_AND_NAVIGATE" },
      { isAcknowledged: false, hasInFlightSave: true, expected: "REUSE_IN_FLIGHT_SAVE" },
      { isAcknowledged: true, hasInFlightSave: false, expected: "SKIP_SAVE" },
      { isAcknowledged: true, hasInFlightSave: true, expected: "SKIP_SAVE" },
    ] as const;
    for (const c of cases) {
      const dirty = true && !c.isAcknowledged && !c.hasInFlightSave; // the original inline expression, response !== undefined already true here
      const expectedFromOriginal = dirty ? "COMBINED_SAVE_AND_NAVIGATE" : c.hasInFlightSave && !c.isAcknowledged ? "REUSE_IN_FLIGHT_SAVE" : "SKIP_SAVE";
      expect(expectedFromOriginal).toBe(c.expected);
      expect(classifyNavigationSaveStrategy({ responseIsDefined: true, isAcknowledged: c.isAcknowledged, hasInFlightSave: c.hasInFlightSave })).toBe(c.expected);
    }
  });
});
