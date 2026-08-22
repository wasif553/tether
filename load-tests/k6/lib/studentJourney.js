/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — shared VU workload.
 *
 * One call to runStudentJourney() = one synthetic student's COMPLETE exam
 * attempt, start to submit, driven entirely through the real, currently-
 * shipped API contracts (see load-tests/README.md, "Exact current
 * endpoint contracts discovered" for the trace this was built from).
 * Every scenario file (smoke/sanity/rehearsal/stage1/stage2/stage3/
 * microburst) imports this SAME function and only varies k6's own
 * `options` (VU ramp shape / duration) — the workload itself never
 * differs by stage, so a correctness defect found at 10 VUs is the same
 * defect that would occur at 500.
 *
 * Backend save semantics are NEVER touched or worked around here:
 * clientRequestId/clientRevision are generated and sent on every
 * PATCH /answers and POST /save-and-navigate call exactly as
 * useResilientAutosave.ts does, idempotency is never bypassed, and
 * navigation always goes through the real
 * POST /question-progress / POST /save-and-navigate contracts — nothing
 * here ever writes a Submission/Answer row directly.
 *
 * TETHER_LOCAL_POSTGRES_LOAD_SMOKE_10 (production-build recheck) —
 * save-and-navigate specifically now follows a bounded-retry,
 * never-advance-without-acknowledgement contract matching the real
 * client's own non-negotiable property (see
 * load-tests/shared/saveAndNavigateRetryPolicy.mjs). The prior local
 * smoke run's one finding was a harness defect, not a Tether defect: one
 * save-and-navigate HTTP request was dropped in transit, and the old
 * version of this loop advanced its local question index anyway. It no
 * longer can — see the "Advance to the next question" call site below.
 */
import http from "k6/http";
import { sleep } from "k6";
import exec from "k6/execution";
import { BASE_URL, EXAM_ID, FIXTURE_QUESTIONS, studentForVu } from "./config.js";
import { correctnessMetrics, recordResult, saveAndNavigateRetryMetrics } from "./metrics.js";
import { deterministicResponseFor } from "../../shared/deterministicAnswers.mjs";
import { MAX_SAVE_AND_NAVIGATE_ATTEMPTS, shouldRetry, computeRetryJitterMs } from "../../shared/saveAndNavigateRetryPolicy.mjs";

const JSON_HEADERS = { "Content-Type": "application/json" };

function jitter(baseSeconds, spreadFraction) {
  const spread = baseSeconds * spreadFraction;
  return Math.max(0.1, baseSeconds + (Math.random() * 2 - 1) * spread);
}

function newClientRequestId(prefix) {
  return `${prefix}-${exec.vu.idInTest}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object} params
 * @param {number} params.targetDurationSeconds — the stage's recommended
 *   active-measurement duration (see README's "Load shape" table); the
 *   per-question think-time budget is derived from this so a full 20-
 *   question attempt roughly fills the window without every VU racing
 *   through in a tight loop (an unrealistic worst-case burst the old
 *   scripts/load-test-secure-exam.mjs explicitly warned against).
 * @param {boolean} [params.microburst] — when true, skips the normal
 *   per-question think-time pacing for the save-and-navigate/submit
 *   calls specifically, modelling the task's separate "20-25% of active
 *   students Save+Next within a short window" burst scenario. Never the
 *   default.
 */
export function runStudentJourney({ targetDurationSeconds, microburst = false }) {
  // Every k6 VU re-runs its default function on every iteration; this
  // harness models ONE student's ONE complete attempt per VU, so any
  // iteration beyond the first for a given VU is a deliberate no-op — see
  // this file's own module doc comment. Prevents a `ramping-vus` executor
  // (which loops the default function for its whole duration) from
  // silently re-using the same pre-authenticated student for a second,
  // overlapping attempt.
  if (exec.vu.iterationInInstance > 0) {
    sleep(1);
    return;
  }

  const student = studentForVu(exec.vu.idInTest);
  const headers = { ...JSON_HEADERS, Cookie: student.cookieHeader };
  const totalQuestions = FIXTURE_QUESTIONS.length;
  const perQuestionBudgetSeconds = Math.max(1, targetDurationSeconds / totalQuestions);

  // --- Attempt start ---
  const startRes = http.post(`${BASE_URL}/api/exams/${EXAM_ID}/start`, JSON.stringify({ policyAcknowledged: true }), { headers, tags: { operation: "exam_start" } });
  const startOutcome = recordResult("exam_start", startRes, { isOk: (r) => r.status === 200 || r.status === 201 });
  if (!startOutcome.ok) return; // cannot proceed without a submission — every downstream metric would be meaningless
  const submission = startRes.json();
  const submissionId = submission.id;

  // --- Secure client (STANDARD_WEB delivery mode — see README's
  // "Secure Tether session strategy" for why this is the ONLY status
  // read this harness performs: session/launch/activate/mock-launch all
  // apply only to TETHER_CLIENT_REQUIRED/SEB_REQUIRED, which this
  // fixture deliberately never uses) ---
  const statusRes = http.get(`${BASE_URL}/api/submissions/${submissionId}/secure-client/status`, { headers, tags: { operation: "secure_client_status" } });
  recordResult("secure_client_status", statusRes);

  sleep(jitter(1.5, 0.5));

  // Small, controlled integrity-event volume — only a minority of
  // students, at most 1-2 events each, never per-question. See README's
  // "Integrity events" section.
  const isIntegrityEventStudent = student.studentIndex % 5 === 0;
  let integrityEventsSent = 0;

  let secondsSinceLastHeartbeat = 0;
  const HEARTBEAT_INTERVAL_SECONDS = 25; // matches session-heartbeat/route.ts's own documented client cadence

  let currentIndex = submission.currentQuestionIndex ?? 0;

  for (let i = currentIndex; i < totalQuestions; i++) {
    const isMcq = FIXTURE_QUESTIONS[i].type === "MULTIPLE_CHOICE";
    const response = deterministicResponseFor({ runId: __ENV.RUN_ID, studentIndex: student.studentIndex, questionIndex: i });

    // Periodic navigator refresh — not on every single question (a real
    // student mostly looks at the current question, not the grid).
    if (i % 4 === 0) {
      const navRes = http.get(`${BASE_URL}/api/submissions/${submissionId}/question-navigator`, { headers, tags: { operation: "question_navigator" } });
      recordResult("question_navigator", navRes);
    }

    // GET the current question payload — mirrors GET /question on first
    // load / a refresh (real students don't call this on every question
    // change, since save-and-navigate/question-progress already return
    // the next question's payload — modelled below).
    if (i === currentIndex) {
      const qRes = http.get(`${BASE_URL}/api/submissions/${submissionId}/question`, { headers, tags: { operation: "question_get" } });
      recordResult("question_get", qRes);
    }

    // Reading/deciding think-time — randomized so VUs are never
    // phase-locked (task's own "randomized think time/jitter" requirement).
    sleep(jitter(perQuestionBudgetSeconds * (isMcq ? 0.4 : 0.8), 0.5));
    secondsSinceLastHeartbeat += perQuestionBudgetSeconds * 0.5;

    // Ordinary debounced autosave (PATCH /answers) — used for roughly a
    // third of questions, exactly like the real client's 600ms-debounced
    // path firing independently of navigation.
    const clientRevision = 1;
    if (i % 3 === 0) {
      const patchRes = http.patch(
        `${BASE_URL}/api/submissions/${submissionId}/answers`,
        JSON.stringify({ questionId: FIXTURE_QUESTIONS[i].id, response, clientRequestId: newClientRequestId("patch"), clientRevision }),
        { headers, tags: { operation: "answers_patch" } },
      );
      recordResult("answers_patch", patchRes);
      sleep(jitter(0.4, 0.6));
    }

    // Occasional flag-for-review (~15% of questions).
    if (Math.random() < 0.15) {
      const flagRes = http.patch(
        `${BASE_URL}/api/submissions/${submissionId}/question-state/${FIXTURE_QUESTIONS[i].id}`,
        JSON.stringify({ flaggedForReview: true }),
        { headers, tags: { operation: "question_state_flag" } },
      );
      recordResult("question_state_flag", flagRes);
    }

    // A minority of students send 1-2 ordinary synthetic integrity
    // events during the run, never per-question.
    if (isIntegrityEventStudent && integrityEventsSent < 2 && Math.random() < 0.1) {
      const eventRes = http.post(
        `${BASE_URL}/api/submissions/${submissionId}/integrity-events`,
        JSON.stringify({ eventType: "WINDOW_BLUR", severity: "LOW", message: "Synthetic load-test integrity event.", occurredAt: new Date().toISOString() }),
        { headers, tags: { operation: "integrity_event" } },
      );
      recordResult("integrity_event", eventRes);
      integrityEventsSent++;
    }

    // Periodic session heartbeat — real ~25s client cadence, never
    // artificially faster.
    if (secondsSinceLastHeartbeat >= HEARTBEAT_INTERVAL_SECONDS) {
      const hbRes = http.post(
        `${BASE_URL}/api/submissions/${submissionId}/session-heartbeat`,
        JSON.stringify({ screenWidth: 1920, cameraPermissionState: "not_requested" }),
        { headers, tags: { operation: "session_heartbeat" } },
      );
      recordResult("session_heartbeat", hbRes);
      secondsSinceLastHeartbeat = 0;
    }

    const isLastQuestion = i === totalQuestions - 1;
    if (isLastQuestion) {
      // Final answer for this question still needs to be durably saved
      // before submit — one more PATCH if this index wasn't already
      // saved via the i % 3 === 0 branch above.
      if (i % 3 !== 0) {
        const finalPatch = http.patch(
          `${BASE_URL}/api/submissions/${submissionId}/answers`,
          JSON.stringify({ questionId: FIXTURE_QUESTIONS[i].id, response, clientRequestId: newClientRequestId("final"), clientRevision }),
          { headers, tags: { operation: "answers_patch" } },
        );
        recordResult("answers_patch", finalPatch);
      }
      break;
    }

    // Occasional Previous (~10%): review an earlier question, then GOTO
    // back to where we were, never disrupting forward progress overall.
    if (i > 0 && Math.random() < 0.1) {
      const prevIndex = i - 1;
      const backRes = http.post(
        `${BASE_URL}/api/submissions/${submissionId}/question-progress`,
        JSON.stringify({ currentIndex: prevIndex }),
        { headers, tags: { operation: "question_progress_goto" } },
      );
      recordResult("question_progress_goto", backRes);
      sleep(jitter(0.8, 0.5));
      const gotoRes = http.post(
        `${BASE_URL}/api/submissions/${submissionId}/question-progress`,
        JSON.stringify({ action: "GOTO", targetIndex: i }),
        { headers, tags: { operation: "question_progress_goto" } },
      );
      recordResult("question_progress_goto", gotoRes);
    }

    // Advance to the next question — the critical, most-frequent
    // navigation path: POST /save-and-navigate (single round trip).
    //
    // TETHER_LOCAL_POSTGRES_LOAD_SMOKE_10 (production-build recheck) —
    // this is the exact call site the prior local smoke run's single
    // finding traced back to: one save-and-navigate request was dropped
    // in transit (never reached the server at all — confirmed via the
    // server's own access log), and the harness advanced its local
    // question index anyway, leaving that question's "visited" marker
    // unset even though its answer had separately been saved. Real
    // Tether (useResilientAutosave.ts's saveAndNavigate) never applies
    // an unacknowledged write's local effects — see
    // load-tests/shared/saveAndNavigateRetryPolicy.mjs for the full
    // rationale. This call site now matches that contract:
    //   - ONE clientRequestId, generated ONCE, reused across every retry
    //     of this SAME logical action (never a fresh id per retry) — the
    //     server's own idempotency layer (saveAnswerWithIdempotency) is
    //     what makes a retry of a request whose response was merely lost
    //     safe to repeat; this harness never weakens or works around it.
    //   - a small bounded number of attempts, short randomized jitter
    //     between them.
    //   - the outer `for` loop is NEVER allowed to advance to `i + 1`
    //     unless the server genuinely acknowledged (2xx) — on
    //     exhausting every attempt unacknowledged, this VU's journey
    //     stops HERE: no later question is answered, submit is never
    //     attempted, and the failure is recorded on its own dedicated
    //     metric rather than silently folded into ordinary request
    //     failures.
    if (!microburst) sleep(jitter(perQuestionBudgetSeconds * 0.3, 0.6));
    const navigateClientRequestId = newClientRequestId("nav");
    let navigateAcknowledged = false;
    for (let attempt = 1; attempt <= MAX_SAVE_AND_NAVIGATE_ATTEMPTS; attempt++) {
      const navigateRes = http.post(
        `${BASE_URL}/api/submissions/${submissionId}/save-and-navigate`,
        JSON.stringify({ questionId: FIXTURE_QUESTIONS[i].id, response, clientRequestId: navigateClientRequestId, clientRevision, currentIndex: i + 1 }),
        { headers, tags: { operation: "save_and_navigate" } },
      );
      const outcome = recordResult("save_and_navigate", navigateRes);
      if (outcome.ok) {
        navigateAcknowledged = true;
        break;
      }
      if (shouldRetry(attempt)) {
        saveAndNavigateRetryMetrics.retryTotal.add(1);
        sleep(computeRetryJitterMs() / 1000);
      }
    }
    if (!navigateAcknowledged) {
      saveAndNavigateRetryMetrics.journeyFailedTotal.add(1);
      return; // never advance past an unacknowledged save-and-navigate — this VU's journey stops here
    }
  }

  // --- Final submission ---
  const submissionRequestId = `submit-${student.studentIndex}-${Date.now()}`;
  const submitRes = http.post(
    `${BASE_URL}/api/submissions/${submissionId}/submit`,
    JSON.stringify({ submissionRequestId }),
    { headers, tags: { operation: "submit" } },
  );
  recordResult("submit", submitRes, { isOk: (r) => r.status === 200 });

  // Bounded subset — idempotent-replay check with the SAME
  // submissionRequestId, never a majority (real students never
  // double-submit; this exists purely to prove the idempotency
  // guarantee holds under load, per the task's own "replay ... once and
  // verify correct idempotent behaviour" requirement).
  if (student.studentIndex % 20 === 0) {
    sleep(jitter(0.3, 0.3));
    const replayRes = http.post(
      `${BASE_URL}/api/submissions/${submissionId}/submit`,
      JSON.stringify({ submissionRequestId }),
      { headers, tags: { operation: "submit_idempotent_replay" } },
    );
    recordResult("submit_idempotent_replay", replayRes, { isOk: (r) => r.status === 200 });
    const replayBody = replayRes.json();
    if (replayBody?.code !== "ALREADY_FINALIZED" || replayRes.status !== 200) {
      correctnessMetrics.duplicateIdempotencyConflict.add(1);
    }
  }

  // Explicit negative ownership test (Student A must never read Student
  // B's protected submission) — deliberately NOT attempted here. This
  // harness never gives one VU another VU's submissionId (each VU only
  // ever learns its OWN submission's id, from its OWN POST /start
  // response) — that isolation is itself part of what makes cross-VU
  // leakage hard to smuggle by construction. The authoritative ownership
  // check runs post-run, out of band, in verify/verifyRun.mjs, which has
  // legitimate access to every submissionId via the dedicated database
  // connection and can issue a real cross-student GET attempt over HTTP
  // and assert the rejection — see that script's own "negative ownership
  // test" section.
}
