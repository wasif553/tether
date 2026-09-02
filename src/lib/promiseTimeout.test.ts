import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromiseTimeoutError, withTimeout } from "./promiseTimeout";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves with the underlying value when it settles before the timeout", async () => {
    const promise = withTimeout(Promise.resolve("ok"), 1000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe("ok");
  });

  it("rejects with PromiseTimeoutError when the underlying promise never settles", async () => {
    const neverSettles = new Promise<string>(() => {});
    const promise = withTimeout(neverSettles, 1000);
    const assertion = expect(promise).rejects.toBeInstanceOf(PromiseTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("propagates the underlying promise's own rejection, not a timeout error, when it rejects before the timeout", async () => {
    const boom = new Error("bridge threw");
    // The .rejects matcher must be attached in the same synchronous tick
    // the promise is created (matching the pattern used for the
    // never-settles case below) — awaiting a timer advance first would
    // let this already-rejecting promise go briefly unhandled.
    const promise = withTimeout(Promise.reject(boom), 1000);
    await expect(promise).rejects.toBe(boom);
  });

  it("never fires the timeout after the underlying promise already resolved (timer is cleared)", async () => {
    const promise = withTimeout(Promise.resolve("fast"), 1000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe("fast");
    // Advancing well past the timeout after resolution must not throw an
    // unhandled rejection or otherwise change the already-settled result.
    await vi.advanceTimersByTimeAsync(5000);
  });

  it("does not resolve/reject before the underlying promise settles, even past a long timeout window, when it settles late but before the timeout", async () => {
    let resolveLate: (value: string) => void = () => {};
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const promise = withTimeout(late, 5000);
    await vi.advanceTimersByTimeAsync(4000);
    resolveLate("late-but-in-time");
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe("late-but-in-time");
  });
});
