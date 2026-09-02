/**
 * Exam-load latency follow-up (physical acceptance review) — the exam
 * page's critical-path fetches (secure-client status, the submission
 * itself, the current question) previously used a bare `fetch()` with no
 * timeout: a stalled connection (e.g. a slow Vercel cold start on a flaky
 * network) left the student staring at an unbounded wait with no
 * feedback and no retry. This never bypasses or weakens any check — a
 * timeout is treated exactly like the network error every caller already
 * has a fail-closed `catch` for; it only bounds how long a caller waits
 * before that existing fail-closed path runs.
 *
 * Browser-only (uses fetch/AbortController) — never imported from a
 * server module.
 */

export class FetchTimeoutError extends Error {
  constructor() {
    super("Request timed out");
    this.name = "FetchTimeoutError";
  }
}

/**
 * Same contract as `fetch`, but rejects with FetchTimeoutError if the
 * request hasn't settled within `timeoutMs`. A caller-supplied `signal`
 * (none of today's callers pass one) is respected too — either source
 * aborting ends the request.
 */
export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onCallerAbort);

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new FetchTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Retries a `fetchWithTimeout` call once (fixed, no backoff — this is
 * for latency-sensitive exam-open calls, not a background sync queue)
 * when the FIRST attempt fails via timeout or a network-level exception.
 * An ordinary non-2xx/4xx/5xx HTTP response is NOT retried here — that's
 * a real server answer (e.g. 403/404), not a transient failure, and
 * every caller already has its own logic for interpreting response
 * status/body.
 */
export async function fetchWithTimeoutAndRetry(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  try {
    return await fetchWithTimeout(input, init, timeoutMs);
  } catch {
    return fetchWithTimeout(input, init, timeoutMs);
  }
}
