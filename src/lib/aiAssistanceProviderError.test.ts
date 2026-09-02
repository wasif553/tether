/**
 * Controlled AI Brainstorming Assistance v1 — intermittent-failure
 * follow-up. Pure unit tests for classification + bounded transient
 * retry. Imports the REAL @anthropic-ai/sdk error classes directly (no
 * mock needed — constructing an error instance never makes a network
 * call) so classification is verified against the SDK's actual class
 * hierarchy, not a hand-rolled stand-in that could drift from it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import {
  callWithTransientRetry,
  classifyProviderError,
  isTransientProviderErrorCategory,
  retryAfterMsFromError,
} from "./aiAssistanceProviderError";

function headersWith(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("classifyProviderError", () => {
  it("classifies a 429 rate-limit response", () => {
    const err = new RateLimitError(429, { type: "rate_limit_error", message: "rate limited" }, "429 rate limited", headersWith({}), "rate_limit_error");
    expect(classifyProviderError(err)).toBe("RATE_LIMITED");
  });

  it("classifies a 529 overloaded response (Anthropic's own overloaded_error type, delivered as a >=500 InternalServerError)", () => {
    const err = new InternalServerError(529, { type: "overloaded_error", message: "Overloaded" }, "529 Overloaded", headersWith({}), "overloaded_error");
    expect(classifyProviderError(err)).toBe("OVERLOADED");
  });

  it("classifies an ordinary 500/503 as SERVER_ERROR, distinct from OVERLOADED", () => {
    const err = new InternalServerError(500, { type: "api_error", message: "Internal error" }, "500 Internal error", headersWith({}), "api_error");
    expect(classifyProviderError(err)).toBe("SERVER_ERROR");
  });

  it("classifies a client-side connection timeout (no response ever received) as TIMEOUT", () => {
    expect(classifyProviderError(new APIConnectionTimeoutError())).toBe("TIMEOUT");
  });

  it("classifies a generic connection failure (no response ever received) as CONNECTION_ERROR, distinct from TIMEOUT", () => {
    expect(classifyProviderError(new APIConnectionError({ message: "fetch failed" }))).toBe("CONNECTION_ERROR");
  });

  it("classifies a 401/403 as CONFIG_MISSING — an invalid or revoked key is a configuration problem, not a transient one", () => {
    const authErr = new AuthenticationError(401, { type: "authentication_error", message: "invalid x-api-key" }, "401", headersWith({}), "authentication_error");
    const permErr = new PermissionDeniedError(403, { type: "permission_error", message: "forbidden" }, "403", headersWith({}), "permission_error");
    expect(classifyProviderError(authErr)).toBe("CONFIG_MISSING");
    expect(classifyProviderError(permErr)).toBe("CONFIG_MISSING");
  });

  it("classifies a 400 (malformed request) as UNKNOWN — never retried, but not conflated with a genuine provider outage", () => {
    const err = new BadRequestError(400, { type: "invalid_request_error", message: "bad request" }, "400", headersWith({}), "invalid_request_error");
    expect(classifyProviderError(err)).toBe("UNKNOWN");
  });

  it("classifies a non-Error thrown value as UNKNOWN without throwing", () => {
    expect(classifyProviderError("a plain string")).toBe("UNKNOWN");
    expect(classifyProviderError(null)).toBe("UNKNOWN");
    expect(classifyProviderError(undefined)).toBe("UNKNOWN");
  });
});

describe("isTransientProviderErrorCategory", () => {
  it("treats RATE_LIMITED, OVERLOADED, TIMEOUT, CONNECTION_ERROR, and SERVER_ERROR as transient", () => {
    for (const category of ["RATE_LIMITED", "OVERLOADED", "TIMEOUT", "CONNECTION_ERROR", "SERVER_ERROR"] as const) {
      expect(isTransientProviderErrorCategory(category)).toBe(true);
    }
  });

  it("never treats PARSE_ERROR, SCHEMA_ERROR, EMPTY_RESPONSE, CONFIG_MISSING, or UNKNOWN as transient — retrying cannot fix any of them", () => {
    for (const category of ["PARSE_ERROR", "SCHEMA_ERROR", "EMPTY_RESPONSE", "CONFIG_MISSING", "UNKNOWN"] as const) {
      expect(isTransientProviderErrorCategory(category)).toBe(false);
    }
  });
});

describe("retryAfterMsFromError", () => {
  it("reads and converts a retry-after (seconds) header", () => {
    const err = new RateLimitError(429, {}, "429", headersWith({ "retry-after": "2" }), "rate_limit_error");
    expect(retryAfterMsFromError(err)).toBe(2000);
  });

  it("prefers retry-after-ms over retry-after when both are present", () => {
    const err = new RateLimitError(429, {}, "429", headersWith({ "retry-after-ms": "750", "retry-after": "10" }), "rate_limit_error");
    expect(retryAfterMsFromError(err)).toBe(750);
  });

  it("caps an unreasonably long retry-after so it can never itself make a request wait unboundedly", () => {
    const err = new RateLimitError(429, {}, "429", headersWith({ "retry-after": "120" }), "rate_limit_error");
    expect(retryAfterMsFromError(err)).toBeLessThanOrEqual(5_000);
  });

  it("returns null when no headers are present at all (e.g. a connection error, which never receives a response)", () => {
    expect(retryAfterMsFromError(new APIConnectionTimeoutError())).toBeNull();
  });
});

describe("callWithTransientRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on a first-attempt success without any retry", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const attempts: unknown[] = [];

    const promise = callWithTransientRetry(fn, { maxAttempts: 3, onAttempt: (log) => attempts.push(log) });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([{ attempt: 1, outcome: "SUCCESS", durationMs: expect.any(Number) }]);
  });

  it("retries a transient failure (529 overloaded) and succeeds on the second attempt", async () => {
    const overloaded = new InternalServerError(529, {}, "529", headersWith({}), "overloaded_error");
    const fn = vi.fn().mockRejectedValueOnce(overloaded).mockResolvedValueOnce("recovered");
    const attempts: unknown[] = [];

    const promise = callWithTransientRetry(fn, { maxAttempts: 3, onAttempt: (log) => attempts.push(log) });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([
      { attempt: 1, outcome: "OVERLOADED", durationMs: expect.any(Number) },
      { attempt: 2, outcome: "SUCCESS", durationMs: expect.any(Number) },
    ]);
  });

  it("honours a rate-limit error's retry-after-ms header as the wait before the next attempt", async () => {
    const rateLimited = new RateLimitError(429, {}, "429", headersWith({ "retry-after-ms": "1234" }), "rate_limit_error");
    const fn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValueOnce("ok");

    const promise = callWithTransientRetry(fn, { maxAttempts: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1); // waiting on retry-after-ms, not yet retried
    await vi.advanceTimersByTimeAsync(1233);
    expect(fn).toHaveBeenCalledTimes(1); // still one millisecond short
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBe("ok");
  });

  it("never retries a non-transient error (config/authorization) — fails immediately on the first attempt", async () => {
    const authErr = new AuthenticationError(401, {}, "401", headersWith({}), "authentication_error");
    const fn = vi.fn().mockRejectedValue(authErr);

    // The .rejects matcher must be attached in the same synchronous tick
    // the promise is created — this error is non-transient, so it
    // rejects with no timer wait at all, and awaiting anything first
    // would let it go briefly unhandled (see promiseTimeout.test.ts's
    // identical note).
    await expect(callWithTransientRetry(fn, { maxAttempts: 3 })).rejects.toBe(authErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops after maxAttempts and throws the LAST attempt's own error when every attempt is transient", async () => {
    const first = new InternalServerError(500, {}, "500", headersWith({}), "api_error");
    const second = new InternalServerError(503, {}, "503", headersWith({}), "api_error");
    const third = new InternalServerError(529, {}, "529", headersWith({}), "overloaded_error");
    const fn = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second).mockRejectedValueOnce(third);

    const promise = callWithTransientRetry(fn, { maxAttempts: 3 });
    const assertion = expect(promise).rejects.toBe(third);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
