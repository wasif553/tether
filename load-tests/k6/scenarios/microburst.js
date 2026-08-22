/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — bounded microburst scenario.
 *
 * Models the task's separate requirement: "~20-25% of active students
 * Save+Next within a short window and/or submit within a short window."
 * This is a DISTINCT scenario from the sustained-workload stages above —
 * never the default sustained shape — and defaults to a modest 100-VU
 * steady population so it can be rehearsed at the same scale as
 * stage1.js without separately requiring Stage 2/3 authorisation; scale
 * STEADY_VU_COUNT/BURST_VU_COUNT together with the same authorisation
 * discipline as the numbered stages if run larger.
 *
 * Two concurrent k6 scenarios:
 *   - "steady": the ordinary realistic-pacing journey (same as every
 *     other stage file), sized to STEADY_VU_COUNT.
 *   - "burst": BURST_VU_COUNT VUs (25% of steady) that each run ONE
 *     compressed-pacing journey (microburst: true — minimal jitter
 *     between Save+Next calls) starting BURST_START_OFFSET into the run,
 *     so their save-and-navigate/submit calls cluster into a short,
 *     genuine burst window layered on top of the steady background load.
 *
 * DO NOT RUN without explicit, separate authorisation — see
 * load-tests/README.md, "Execution permission". Never executed as part
 * of TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1.
 */
import { runStudentJourney } from "../lib/studentJourney.js";
import { STANDARD_THRESHOLDS, fiveXxAndTimeoutThresholdsFor } from "../lib/thresholds.js";

const STEADY_VU_COUNT = 100;
const BURST_VU_COUNT = 25; // 25% of STEADY_VU_COUNT
const ACTIVE_DURATION_SECONDS = 12 * 60;
const BURST_START_OFFSET = "5m";

export const options = {
  scenarios: {
    steady: {
      executor: "ramping-vus",
      exec: "steadyJourney",
      startVUs: 0,
      stages: [
        { duration: "2m", target: STEADY_VU_COUNT },
        { duration: `${ACTIVE_DURATION_SECONDS}s`, target: STEADY_VU_COUNT },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "1m",
    },
    burst: {
      executor: "per-vu-iterations",
      exec: "burstJourney",
      vus: BURST_VU_COUNT,
      iterations: 1,
      startTime: BURST_START_OFFSET,
      maxDuration: "3m",
    },
  },
  thresholds: {
    ...STANDARD_THRESHOLDS,
    ...fiveXxAndTimeoutThresholdsFor([
      "exam_start", "question_get", "question_navigator", "answers_patch",
      "save_and_navigate", "question_progress_goto", "question_state_flag",
      "session_heartbeat", "integrity_event", "submit",
    ]),
  },
  tags: { stage: "microburst", steadyVus: String(STEADY_VU_COUNT), burstVus: String(BURST_VU_COUNT) },
};

export function steadyJourney() {
  runStudentJourney({ targetDurationSeconds: ACTIVE_DURATION_SECONDS, microburst: false });
}

export function burstJourney() {
  // A short, compressed target duration collapses the per-question sleep
  // budget toward the jitter() floor — save-and-navigate calls fire in
  // rapid succession, modelling many students clicking Next/Submit within
  // the same short window (e.g. everyone finishing near the deadline).
  runStudentJourney({ targetDurationSeconds: 45, microburst: true });
}
