import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchTimeoutError, fetchWithTimeout, fetchWithTimeoutAndRetry } from "./fetchWithTimeout";

describe("fetchWithTimeout", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it("resolves with the response when fetch settles before the timeout", async () => {
    const response = new Response("ok", { status: 200 });
    global.fetch = vi.fn().mockResolvedValue(response);

    const result = await fetchWithTimeout("/api/thing", {}, 5_000);

    expect(result).toBe(response);
  });

  it("rejects with FetchTimeoutError when fetch never settles within timeoutMs", async () => {
    global.fetch = vi.fn().mockImplementation(
      (_input, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );

    const pending = fetchWithTimeout("/api/thing", {}, 5_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("propagates a genuine network error unchanged (not a timeout)", async () => {
    const networkError = new Error("network down");
    global.fetch = vi.fn().mockRejectedValue(networkError);

    await expect(fetchWithTimeout("/api/thing", {}, 5_000)).rejects.toBe(networkError);
  });

  it("respects a caller-supplied AbortSignal independently of the timeout", async () => {
    const callerController = new AbortController();
    global.fetch = vi.fn().mockImplementation(
      (_input, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );

    const pending = fetchWithTimeout("/api/thing", { signal: callerController.signal }, 5_000);
    callerController.abort();
    await expect(pending).rejects.toBeInstanceOf(DOMException);
  });
});

describe("fetchWithTimeoutAndRetry", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the first successful response without retrying", async () => {
    const response = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    global.fetch = fetchMock;

    const result = await fetchWithTimeoutAndRetry("/api/thing", {}, 5_000);

    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once after a failed first attempt, then succeeds", async () => {
    const response = new Response("ok", { status: 200 });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(response);
    global.fetch = fetchMock;

    const result = await fetchWithTimeoutAndRetry("/api/thing", {}, 5_000);

    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry an ordinary non-2xx HTTP response", async () => {
    const response = new Response("not found", { status: 404 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    global.fetch = fetchMock;

    const result = await fetchWithTimeoutAndRetry("/api/thing", {}, 5_000);

    expect(result.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates the second attempt's failure when both attempts fail", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("still down"));
    global.fetch = fetchMock;

    await expect(fetchWithTimeoutAndRetry("/api/thing", {}, 5_000)).rejects.toThrow("still down");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
