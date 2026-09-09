/**
 * Exam-load latency follow-up (physical hang investigation) — bounds an
 * arbitrary Promise, not just a `fetch()` call. fetchWithTimeout.ts already
 * bounds every fetch on the exam-open critical path via AbortController,
 * but the native Tether/Electron lockdown bridge
 * (window.sesLockdown.getSecureClientEnforcementState()) is a plain IPC
 * Promise with no `fetch`/AbortController underneath it — a stuck main-
 * process handler leaves that Promise permanently unsettled, which
 * fetchWithTimeout cannot help with at all. This is the generic version:
 * race ANY Promise against a timer.
 *
 * The underlying operation is never actually cancelled (there is no
 * cancellation primitive for a bridge IPC call) — this only bounds how
 * long a caller WAITS before treating it as failed. A caller must keep
 * treating a late resolution as irrelevant (e.g. via a `cancelled` flag),
 * exactly like every existing fetch-based effect on this page already
 * does for its own timeout/abort case.
 */

export class PromiseTimeoutError extends Error {
  constructor() {
    super("Operation timed out");
    this.name = "PromiseTimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PromiseTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
