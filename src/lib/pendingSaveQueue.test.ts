import { describe, expect, it } from "vitest";
import {
  nextRevision,
  shouldSupersede,
  isEntryExpired,
  computeBackoffDelayMs,
  classifyAcknowledgement,
  summarizeQueue,
  scopedKey,
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
