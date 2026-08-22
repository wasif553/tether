/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — Stage 3 (500 concurrent students).
 *
 * DO NOT RUN without explicit, separate authorisation — see
 * load-tests/README.md, "Execution permission". Never executed as part
 * of TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1.
 *
 * Run:
 *   node load-tests/setup/provisionFixture.mjs --students=550 --label=stage3
 *   k6 run load-tests/k6/scenarios/stage3.js \
 *     -e LOADTEST_TARGET_BASE_URL=https://your-dedicated-loadtest-deployment.vercel.app \
 *     -e RUN_ID=<runId>
 */
import { runStudentJourney } from "../lib/studentJourney.js";
import { STANDARD_THRESHOLDS, fiveXxAndTimeoutThresholdsFor } from "../lib/thresholds.js";

const ACTIVE_DURATION_SECONDS = 20 * 60;

export const options = {
  scenarios: {
    stage3: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "4m", target: 500 },
        { duration: `${ACTIVE_DURATION_SECONDS}s`, target: 500 },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "1m",
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
  tags: { stage: "stage3", vus: "500" },
};

function stage3Journey() {
  runStudentJourney({ targetDurationSeconds: ACTIVE_DURATION_SECONDS });
}

export default stage3Journey;
