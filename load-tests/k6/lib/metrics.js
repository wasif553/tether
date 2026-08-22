/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — custom k6 metrics, tagged by
 * LOGICAL operation (never only by URL — a parameterised path like
 * /api/submissions/:id/answers would otherwise fragment into hundreds of
 * distinct k6 "url" tag values, one per submission id).
 *
 * One Trend (latency) + one Rate (success) + one Counter (4xx) + one
 * Counter (5xx) + one Counter (timeout) per operation, so
 * `k6 run --summary-export` / the end-of-run text summary reports each
 * operation's own p50/p95/p99 and error breakdown independently, exactly
 * what the task's METRICS section asks for.
 */
import { Trend, Rate, Counter } from "k6/metrics";

const OPERATIONS = [
  "auth_login", // only used by the microburst/self-contained scenarios that log in inline — the primary stage scenarios pre-authenticate in setup, see config.js
  "exam_start",
  "secure_client_status",
  "question_get",
  "question_navigator",
  "answers_patch", // ordinary debounced autosave (PATCH /answers)
  "save_and_navigate", // POST /save-and-navigate (Next/Previous)
  "question_progress_goto", // POST /question-progress { action: GOTO }
  "question_state_flag", // PATCH /question-state/[questionId]
  "session_heartbeat",
  "integrity_event",
  "submit",
  "submit_idempotent_replay",
];

export const metrics = {};
for (const op of OPERATIONS) {
  metrics[op] = {
    latency: new Trend(`${op}_latency_ms`, true),
    success: new Rate(`${op}_success_rate`),
    status4xx: new Counter(`${op}_4xx_total`),
    status5xx: new Counter(`${op}_5xx_total`),
    timeout: new Counter(`${op}_timeout_total`),
    unexpected429: new Counter(`${op}_unexpected_429_total`),
  };
}

export const correctnessMetrics = {
  duplicateIdempotencyConflict: new Counter("duplicate_idempotency_conflict_total"),
  staleNavigatorReconciliation: new Counter("stale_navigator_reconciliation_total"),
  ownershipRejectionConfirmed: new Counter("ownership_rejection_confirmed_total"),
};

/**
 * TETHER_LOCAL_POSTGRES_LOAD_SMOKE_10 (production-build recheck) — the
 * save-and-navigate bounded-retry policy's own observability. See
 * load-tests/shared/saveAndNavigateRetryPolicy.mjs for the policy this
 * instruments.
 *   - retryTotal: incremented once per RETRY attempt (i.e. every attempt
 *     after the first for one logical action) — a healthy run should
 *     show this near zero; a nonzero-but-small count is the harness
 *     recovering from a transient drop exactly like the one that caused
 *     the prior local smoke run's single navigator-convergence finding.
 *   - journeyFailedTotal: incremented once per VU whose save-and-navigate
 *     action was STILL unacknowledged after every retry — this is the
 *     harness correctly refusing to silently advance past an
 *     unacknowledged write. Any nonzero value here means that VU's
 *     journey stopped early (no later questions answered, no submit
 *     attempted) and should be investigated, but it is categorically
 *     different from the OLD defect (advancing anyway) — see
 *     studentJourney.js's own call site for the full contract.
 */
export const saveAndNavigateRetryMetrics = {
  retryTotal: new Counter("save_and_navigate_retry_total"),
  journeyFailedTotal: new Counter("save_and_navigate_journey_failed_total"),
};

/**
 * Records one HTTP response against the named operation's metric set.
 * `expected429Allowed` should be true ONLY for the rare, deliberate
 * rate-limit-testing paths this harness never actually exercises during
 * the timed active-exam workload — every ordinary operation call site
 * leaves it false, so any 429 the harness sees during a timed stage is
 * flagged as UNEXPECTED (see the task's own "Unexpected 429 during timed
 * active exam: 0" pass/fail gate).
 */
export function recordResult(operation, res, options = {}) {
  const m = metrics[operation];
  if (!m) throw new Error(`Unknown load-test operation metric: ${operation}`);
  const expected429Allowed = options.expected429Allowed === true;

  m.latency.add(res.timings.duration);

  const timedOut = res.error_code === 1050 || res.error_code === 1211 || (res.status === 0 && res.error && res.error.includes("timeout"));
  if (timedOut) {
    m.timeout.add(1);
    m.success.add(false);
    return { ok: false, timedOut: true };
  }

  if (res.status === 429 && !expected429Allowed) {
    m.unexpected429.add(1);
  }

  const ok = options.isOk ? options.isOk(res) : res.status >= 200 && res.status < 300;
  m.success.add(ok);
  if (res.status >= 400 && res.status < 500) m.status4xx.add(1);
  if (res.status >= 500) m.status5xx.add(1);
  return { ok, timedOut: false };
}
