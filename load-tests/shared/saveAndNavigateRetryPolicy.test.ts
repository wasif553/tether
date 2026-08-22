import { describe, it, expect } from "vitest";
import {
  MAX_SAVE_AND_NAVIGATE_ATTEMPTS,
  RETRY_JITTER_MIN_MS,
  RETRY_JITTER_MAX_MS,
  isAcknowledged,
  shouldRetry,
  computeRetryJitterMs,
} from "./saveAndNavigateRetryPolicy.mjs";

describe("isAcknowledged", () => {
  it("treats every 2xx status as acknowledged", () => {
    for (const status of [200, 201, 204, 299]) expect(isAcknowledged(status)).toBe(true);
  });

  it("treats every non-2xx status as NOT acknowledged", () => {
    for (const status of [0, 199, 300, 400, 401, 403, 409, 429, 500, 503]) expect(isAcknowledged(status)).toBe(false);
  });

  it("treats a missing/non-numeric status (e.g. a dropped connection with no response at all) as NOT acknowledged", () => {
    expect(isAcknowledged(undefined)).toBe(false);
    expect(isAcknowledged(null)).toBe(false);
    expect(isAcknowledged("200")).toBe(false);
  });
});

describe("shouldRetry — bounded attempts, matching the exact evidence from the prior failed run", () => {
  it("retries after attempt 1 and attempt 2, but not after the final attempt", () => {
    expect(shouldRetry(1, MAX_SAVE_AND_NAVIGATE_ATTEMPTS)).toBe(true);
    expect(shouldRetry(2, MAX_SAVE_AND_NAVIGATE_ATTEMPTS)).toBe(true);
    expect(shouldRetry(MAX_SAVE_AND_NAVIGATE_ATTEMPTS, MAX_SAVE_AND_NAVIGATE_ATTEMPTS)).toBe(false);
  });

  it("never retries past maxAttempts even if called with an attemptNumber beyond it", () => {
    expect(shouldRetry(MAX_SAVE_AND_NAVIGATE_ATTEMPTS + 1, MAX_SAVE_AND_NAVIGATE_ATTEMPTS)).toBe(false);
  });

  it("MAX_SAVE_AND_NAVIGATE_ATTEMPTS is a small bounded number — never unbounded, never 1 (a policy of 1 would mean no retry logic exists at all)", () => {
    expect(MAX_SAVE_AND_NAVIGATE_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_SAVE_AND_NAVIGATE_ATTEMPTS).toBeLessThanOrEqual(5);
  });

  it("a single transient drop (exactly the failure mode from the prior local smoke run) is recoverable within the bound: attempt 1 fails, attempt 2 succeeds, no third attempt needed", () => {
    // Simulates the exact sequence this policy exists for.
    const attempts = [{ status: 0 }, { status: 200 }]; // attempt 1: dropped connection; attempt 2: acknowledged
    let acknowledgedAt = null;
    for (let attemptNumber = 1; attemptNumber <= attempts.length; attemptNumber++) {
      if (isAcknowledged(attempts[attemptNumber - 1].status)) {
        acknowledgedAt = attemptNumber;
        break;
      }
    }
    expect(acknowledgedAt).toBe(2);
    expect(acknowledgedAt).toBeLessThanOrEqual(MAX_SAVE_AND_NAVIGATE_ATTEMPTS);
  });
});

describe("computeRetryJitterMs", () => {
  it("is always within [RETRY_JITTER_MIN_MS, RETRY_JITTER_MAX_MS]", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const ms = computeRetryJitterMs(() => r);
      expect(ms).toBeGreaterThanOrEqual(RETRY_JITTER_MIN_MS);
      expect(ms).toBeLessThanOrEqual(RETRY_JITTER_MAX_MS);
    }
  });

  it("is short — bounded well under a second, so retries never meaningfully distort pacing/capacity measurements", () => {
    expect(RETRY_JITTER_MAX_MS).toBeLessThan(1000);
  });

  it("uses the injected random function, not a hidden global — deterministically testable", () => {
    expect(computeRetryJitterMs(() => 0)).toBe(RETRY_JITTER_MIN_MS);
    expect(computeRetryJitterMs(() => 1)).toBe(RETRY_JITTER_MAX_MS);
  });
});
