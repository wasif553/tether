/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — shared k6 thresholds.
 *
 * One definition of the task's own "Suggested operational targets", used
 * identically by every stage scenario — thresholds never loosen for a
 * larger stage (the task's own explicit instruction). k6 marks the whole
 * run FAILED (non-zero exit code) if any threshold is breached, which is
 * what makes these genuine pass/fail gates rather than advisory numbers.
 *
 * Hard correctness gates (lost answers, wrong association, cross-student
 * leakage, ownership/session-binding bypass, duplicate submission
 * corruption) are NOT expressible as a k6 latency/rate threshold — those
 * are zero-tolerance findings verified post-run by verify/verifyRun.mjs
 * against the database directly. This file only encodes the
 * PERFORMANCE/availability targets k6 itself can observe live.
 */
export const STANDARD_THRESHOLDS = {
  // Autosave (ordinary debounced PATCH /answers).
  answers_patch_success_rate: ["rate>=0.995"],
  answers_patch_latency_ms: ["p(95)<1500", "p(99)<3000"],

  // Save + Next — the critical path.
  save_and_navigate_success_rate: ["rate>=0.995"],
  save_and_navigate_latency_ms: ["p(95)<2000", "p(99)<4000"],

  // Core reads / navigator.
  question_get_latency_ms: ["p(95)<1500", "p(99)<3000"],
  question_navigator_latency_ms: ["p(95)<1500", "p(99)<3000"],
  question_progress_goto_latency_ms: ["p(95)<1500", "p(99)<3000"],

  // Final submission.
  submit_success_rate: ["rate>=0.995"],
  submit_latency_ms: ["p(95)<3000", "p(99)<6000"],

  // Unexpected 429 during the timed active-exam workload must be zero.
  exam_start_unexpected_429_total: ["count==0"],
  answers_patch_unexpected_429_total: ["count==0"],
  save_and_navigate_unexpected_429_total: ["count==0"],
  question_progress_goto_unexpected_429_total: ["count==0"],
  question_navigator_unexpected_429_total: ["count==0"],
  session_heartbeat_unexpected_429_total: ["count==0"],
  submit_unexpected_429_total: ["count==0"],

  // Correctness counters observable live — real zero-tolerance findings;
  // any non-zero value here should already have stopped the stage per
  // the runbook's STOP conditions well before the run completes.
  duplicate_idempotency_conflict_total: ["count==0"],
};

/** Unexpected 5xx / timeout stay just under the task's <0.5% targets, expressed per-operation since k6 has no single "overall" HTTP metric across custom Trends. */
export function fiveXxAndTimeoutThresholdsFor(operations) {
  const out = {};
  for (const op of operations) {
    out[`${op}_5xx_total`] = ["count<1"]; // advisory per-operation; the runbook's own 0.5%-of-total-requests gate is checked from the exported summary, not per-metric here
    out[`${op}_timeout_total`] = ["count<1"];
  }
  return out;
}
