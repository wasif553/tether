/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — k6 shared config/fixture
 * loader.
 *
 * Every k6 scenario file imports ONLY this module (never
 * productionDenylist.mjs directly) so the production-target guard is
 * guaranteed to run at INIT time, before a single VU/request exists, no
 * matter which scenario is invoked. k6 re-evaluates a script's init
 * context once per VU (each VU gets its own isolated JS runtime) — this
 * module's top-level guard therefore re-runs on every VU's init, which is
 * intentional defense-in-depth, not a performance concern at the VU
 * counts this harness targets (<= 500).
 *
 * Required environment variables (passed via `k6 run -e NAME=value`):
 *   LOADTEST_TARGET_BASE_URL  — e.g. https://your-dedicated-loadtest-deployment.vercel.app
 *   RUN_ID                    — the run id printed by
 *                                load-tests/setup/provisionFixture.mjs
 *
 * No default/fallback target exists anywhere in this file — an unset
 * LOADTEST_TARGET_BASE_URL fails closed via checkLoadTestTargetUrl's own
 * "no target supplied" rejection, never silently proceeds.
 */
import { checkLoadTestTargetUrl } from "../../shared/productionDenylist.mjs";

const TARGET_BASE_URL = __ENV.LOADTEST_TARGET_BASE_URL;
const RUN_ID = __ENV.RUN_ID;

const targetCheck = checkLoadTestTargetUrl(TARGET_BASE_URL);
if (!targetCheck.ok) {
  throw new Error(`PRODUCTION DENYLIST REFUSED TARGET: ${targetCheck.reason}`);
}
if (!RUN_ID) {
  throw new Error("RUN_ID environment variable is required — pass -e RUN_ID=<runId>, using the run id load-tests/setup/provisionFixture.mjs printed.");
}

// open() is only valid in k6's init context (module top level) — never
// inside the default function. Paths are resolved relative to THIS file.
const manifestRaw = open(`../../runs/${RUN_ID}/manifest.json`);
const credentialsRaw = open(`../../runs/${RUN_ID}/credentials.local.json`);

export const BASE_URL = TARGET_BASE_URL;
export const MANIFEST = JSON.parse(manifestRaw);
export const CREDENTIALS = JSON.parse(credentialsRaw);

if (!Array.isArray(CREDENTIALS.students) || CREDENTIALS.students.length === 0) {
  throw new Error(`No provisioned students found in run ${RUN_ID}'s credentials.local.json — re-run provisionFixture.mjs.`);
}

/**
 * Deterministically assigns one pre-authenticated student to a VU. Every
 * VU picks a DIFFERENT student (round-robin over however many were
 * provisioned) — never re-uses the same student's cookie across two
 * concurrently-running VUs, which would otherwise make two "different
 * students" actually be the same Submission from the server's point of
 * view.
 */
export function studentForVu(vuId) {
  const students = CREDENTIALS.students;
  return students[(vuId - 1) % students.length];
}

export const EXAM_ID = MANIFEST.examId;
export const FIXTURE_QUESTIONS = MANIFEST.questions; // [{ id, type, order, fixtureIndex }, ...] in fixture order
