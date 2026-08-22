/**
 * TETHER_LOCAL_POSTGRES_LOAD_SMOKE_10 (production-build recheck) — the
 * bounded-retry policy for POST /api/submissions/[id]/save-and-navigate,
 * extracted as pure, dependency-free logic so it can be unit-tested with
 * vitest (k6's own runtime cannot run a Node test framework) and imported
 * unmodified by studentJourney.js exactly like productionDenylist.mjs and
 * deterministicAnswers.mjs already are.
 *
 * Models the same non-negotiable property the real client enforces (see
 * src/hooks/useResilientAutosave.ts's own doc comment: "resolves `true`
 * only once the SERVER has actually acknowledged the save — never merely
 * queued locally", and the one-question-mode caller, which BLOCKS
 * navigation on a `false` result): a save-and-navigate action's local
 * effects (advancing to the next question) may only ever be applied once
 * the server has genuinely acknowledged that exact write. Unlike the
 * production hook — which lets an unacknowledged save fall through to
 * its own background PATCH-based retry queue while the STUDENT decides
 * whether to click Next again — this synthetic harness has no human in
 * the loop to retry navigation, so it retries the identical logical
 * action itself a small bounded number of times before giving up.
 *
 * "Identical logical action" is the operative phrase: every retry reuses
 * the SAME clientRequestId and clientRevision as the first attempt (see
 * studentJourney.js's own call site) so the server's own idempotency
 * layer (saveAnswerWithIdempotency, src/lib/answerSaveRunner.ts) is what
 * actually protects against a double-apply if an earlier "failed"
 * attempt's response was merely lost in transit rather than genuinely
 * never processed — this module never weakens or works around that
 * layer, it exists purely to decide WHEN to stop retrying.
 */

/** Total attempts for one logical save-and-navigate action, including the first — never unbounded. */
export const MAX_SAVE_AND_NAVIGATE_ATTEMPTS = 3;

/** Short jitter window between retries — long enough to let a transient local hiccup (the exact failure mode this policy exists to recover from) clear, short enough to never meaningfully distort pacing/capacity measurements. */
export const RETRY_JITTER_MIN_MS = 150;
export const RETRY_JITTER_MAX_MS = 450;

/** A 2xx response is the only acknowledgement this policy accepts — matches every other operation's `recordResult` default `isOk`. */
export function isAcknowledged(httpStatus) {
  return typeof httpStatus === "number" && httpStatus >= 200 && httpStatus < 300;
}

/**
 * Whether attempt number `attemptNumber` (1-indexed; 1 is the first,
 * non-retry attempt) should be followed by another attempt, given it was
 * NOT acknowledged. `attemptNumber` must already have happened — this
 * decides whether to try AGAIN, not whether the current attempt itself
 * should run.
 */
export function shouldRetry(attemptNumber, maxAttempts = MAX_SAVE_AND_NAVIGATE_ATTEMPTS) {
  return attemptNumber < maxAttempts;
}

/** Bounded, randomized backoff between retries — never a fixed delay (would phase-lock retries across VUs), never unbounded (would distort pacing). `randomFn` is injectable so this is deterministically testable. */
export function computeRetryJitterMs(randomFn = Math.random) {
  return RETRY_JITTER_MIN_MS + randomFn() * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS);
}
