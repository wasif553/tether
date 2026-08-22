/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — Stage: SMOKE (10 concurrent students).
 *
 * Run:
 *   node load-tests/setup/provisionFixture.mjs --students=12 --label=smoke
 *   k6 run load-tests/k6/scenarios/smoke.js \
 *     -e LOADTEST_TARGET_BASE_URL=https://your-dedicated-loadtest-deployment.vercel.app \
 *     -e RUN_ID=<runId from provisionFixture output>
 *
 * See load-tests/README.md, "Execution permission" — the 10-user smoke is
 * the ONLY stage this harness may ever run, and only once its own 6
 * preconditions are independently proven for the target environment.
 */
import { runStudentJourney } from "../lib/studentJourney.js";
import { STANDARD_THRESHOLDS, fiveXxAndTimeoutThresholdsFor } from "../lib/thresholds.js";

const ACTIVE_DURATION_SECONDS = 4 * 60; // ~5 minutes total including ramps, per the task's suggested profile

export const options = {
  scenarios: {
    smoke: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 10 },
        { duration: `${ACTIVE_DURATION_SECONDS}s`, target: 10 },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
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
  tags: { stage: "smoke", vus: "10" },
};

function smokeJourney() {
  runStudentJourney({ targetDurationSeconds: ACTIVE_DURATION_SECONDS });
}

export default smokeJourney;
