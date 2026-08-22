/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — Stage 1 (100 concurrent students).
 *
 * DO NOT RUN without explicit, separate authorisation — see
 * load-tests/README.md, "Execution permission". This file exists as a
 * ready-to-run artifact for a FUTURE, explicitly authorised task; it was
 * never executed as part of TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1.
 *
 * Run:
 *   node load-tests/setup/provisionFixture.mjs --students=120 --label=stage1
 *   k6 run load-tests/k6/scenarios/stage1.js \
 *     -e LOADTEST_TARGET_BASE_URL=https://your-dedicated-loadtest-deployment.vercel.app \
 *     -e RUN_ID=<runId>
 */
import { runStudentJourney } from "../lib/studentJourney.js";
import { STANDARD_THRESHOLDS, fiveXxAndTimeoutThresholdsFor } from "../lib/thresholds.js";

const ACTIVE_DURATION_SECONDS = 12 * 60;

export const options = {
  scenarios: {
    stage1: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: 100 },
        { duration: `${ACTIVE_DURATION_SECONDS}s`, target: 100 },
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
  tags: { stage: "stage1", vus: "100" },
};

function stage1Journey() {
  runStudentJourney({ targetDurationSeconds: ACTIVE_DURATION_SECONDS });
}

export default stage1Journey;
