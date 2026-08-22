/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — Stage: SANITY (25 concurrent students).
 *
 * Run:
 *   node load-tests/setup/provisionFixture.mjs --students=30 --label=sanity
 *   k6 run load-tests/k6/scenarios/sanity.js \
 *     -e LOADTEST_TARGET_BASE_URL=https://your-dedicated-loadtest-deployment.vercel.app \
 *     -e RUN_ID=<runId>
 */
import { runStudentJourney } from "../lib/studentJourney.js";
import { STANDARD_THRESHOLDS, fiveXxAndTimeoutThresholdsFor } from "../lib/thresholds.js";

const ACTIVE_DURATION_SECONDS = 7 * 60;

export const options = {
  scenarios: {
    sanity: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: 25 },
        { duration: `${ACTIVE_DURATION_SECONDS}s`, target: 25 },
        { duration: "1m", target: 0 },
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
  tags: { stage: "sanity", vus: "25" },
};

function sanityJourney() {
  runStudentJourney({ targetDurationSeconds: ACTIVE_DURATION_SECONDS });
}

export default sanityJourney;
