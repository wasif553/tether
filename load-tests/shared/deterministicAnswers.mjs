/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — deterministic synthetic
 * answers.
 *
 * Pure, dependency-free, plain ESM JS — imported unmodified by both the
 * Node setup/verify scripts and every k6 scenario (same constraint as
 * productionDenylist.mjs: no Node built-ins, no npm packages).
 *
 * Given (runId, studentIndex, questionIndex, questionType, mcqOptions),
 * always produces the SAME response text — so a k6 VU and the later
 * verification script can independently compute "what should this
 * student's answer to this question be" without any shared state, and a
 * mismatch between what was submitted and what is persisted is
 * unambiguous evidence of a real correctness defect (lost answer, wrong
 * question association, or cross-student mixup) rather than a test
 * artifact.
 *
 * Short-answer responses deliberately embed the run id, student index,
 * and question index directly in the text — this is what makes a
 * cross-student or cross-question mixup self-evidently detectable by
 * grepping persisted Answer.response values, independent of the
 * submissionId/questionId foreign keys also being checked.
 */

/** 20-question fixture shape: indices 0..11 are MCQ, 12..19 are SHORT_ANSWER. Exported so setup/verify/k6 never hard-code these boundaries independently. */
export const FIXTURE_QUESTION_COUNT = 20;
export const FIXTURE_MCQ_COUNT = 12;
export const FIXTURE_SHORT_ANSWER_COUNT = FIXTURE_QUESTION_COUNT - FIXTURE_MCQ_COUNT;

export function isMcqIndex(questionIndex) {
  return questionIndex < FIXTURE_MCQ_COUNT;
}

/** The fixed 4-option set used for every MCQ question in the fixture — deterministic and identical across questions, only the correct slot varies. */
export const MCQ_OPTIONS = Object.freeze(["A", "B", "C", "D"]);

/** Which option is correct for MCQ question `questionIndex` — cycles through all 4 slots so the fixture never has the same "always pick index 0" degenerate shape. */
export function mcqCorrectOption(questionIndex) {
  return MCQ_OPTIONS[questionIndex % MCQ_OPTIONS.length];
}

/**
 * The deterministic response a synthetic student submits for one
 * question. For MCQ, always the objectively CORRECT option (so grading
 * correctness is also verifiable — see mcqCorrectOption). For short
 * answer, a fixed, self-identifying string embedding runId/studentIndex/
 * questionIndex.
 */
export function deterministicResponseFor(params) {
  const { runId, studentIndex, questionIndex } = params;
  if (isMcqIndex(questionIndex)) {
    return mcqCorrectOption(questionIndex);
  }
  return `LT-${runId}-S${studentIndex}-Q${questionIndex}`;
}

/** Reconstructs the expected response for verification without needing the harness's own in-memory state — pure function of the same three identifiers every response was generated from. */
export function expectedResponseFor(runId, studentIndex, questionIndex) {
  return deterministicResponseFor({ runId, studentIndex, questionIndex });
}

/** Builds the 20-question fixture payload used by the setup script's POST /api/exams/[id]/questions calls, in stable order (MCQ block first, then short-answer). */
export function buildFixtureQuestionDefinitions() {
  const questions = [];
  for (let i = 0; i < FIXTURE_MCQ_COUNT; i++) {
    questions.push({
      type: "MULTIPLE_CHOICE",
      text: `[Load Test] Multiple choice question ${i + 1} of ${FIXTURE_MCQ_COUNT} — select the option matching this question's designated correct slot.`,
      options: [...MCQ_OPTIONS],
      correctAnswer: mcqCorrectOption(i),
      points: 1,
    });
  }
  for (let i = FIXTURE_MCQ_COUNT; i < FIXTURE_QUESTION_COUNT; i++) {
    questions.push({
      type: "SHORT_ANSWER",
      text: `[Load Test] Short answer question ${i - FIXTURE_MCQ_COUNT + 1} of ${FIXTURE_SHORT_ANSWER_COUNT} — this question exists only to exercise autosave/grading paths for a synthetic load-test run; there is no meaningful correct answer to grade against.`,
      points: 1,
    });
  }
  return questions;
}
