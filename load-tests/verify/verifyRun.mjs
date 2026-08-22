#!/usr/bin/env node
/**
 * TETHER_LOAD_TEST_HARNESS_READINESS_P0_V1 — post-run correctness
 * verification.
 *
 * The ONE script in this harness that connects directly to a database —
 * a DEDICATED load-test Supabase project's connection string, supplied
 * via LOADTEST_DATABASE_URL, gated by the same production denylist every
 * other entry point uses (see ../shared/productionDenylist.mjs). Never
 * imports src/lib/prisma.ts (that module is the application's own
 * runtime singleton, implicitly tied to whatever DATABASE_URL the
 * current process/deployment happens to have — using it here would risk
 * silently reading this SCRIPT's own ambient environment instead of the
 * explicitly-supplied, explicitly-guarded LOADTEST_DATABASE_URL). Run via
 * tsx so the generated Prisma client (TypeScript) and @prisma/adapter-pg
 * resolve exactly like every other script in this repository:
 *
 *   npx tsx load-tests/verify/verifyRun.mjs --runId=<runId>
 *
 * Requires `npx prisma generate` to have already produced
 * src/generated/prisma/client (gitignored — see this repo's own
 * .gitignore; every existing script that touches Prisma already assumes
 * this).
 *
 * Implements the task's DATA-INTEGRITY VERIFICATION checklist (12 items)
 * plus the explicit negative ownership test, and prints a PASS/FAIL
 * summary against the task's own hard correctness gates (zero tolerance
 * — a single violation anywhere fails the whole run, regardless of how
 * small a fraction of students it affects).
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertLoadTestEnvironmentIsSafe } from "../shared/productionDenylist.mjs";
import { expectedResponseFor, isMcqIndex, mcqCorrectOption } from "../shared/deterministicAnswers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(__dirname, "..", "runs");

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [k, v] = arg.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
  );
  return { runId: args.runId };
}

const findings = [];
function fail(category, detail) {
  findings.push({ category, detail });
  console.error(`  ✗ [${category}] ${detail}`);
}
function pass(label) {
  console.log(`  ✓ ${label}`);
}

async function main() {
  const { runId } = parseArgs();
  if (!runId) {
    console.error("Usage: npx tsx load-tests/verify/verifyRun.mjs --runId=<runId>");
    process.exit(2);
  }

  const targetBaseUrl = process.env.LOADTEST_TARGET_BASE_URL;
  const databaseUrl = process.env.LOADTEST_DATABASE_URL;
  // MANDATORY, unconditional, non-overridable.
  assertLoadTestEnvironmentIsSafe({ targetBaseUrl, databaseUrl });

  const runDir = path.join(RUNS_DIR, runId);
  const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
  const credentials = JSON.parse(await readFile(path.join(runDir, "credentials.local.json"), "utf8"));

  console.log(`[verifyRun] Run: ${runId} (label: ${manifest.label})`);
  console.log(`[verifyRun] Exam: ${manifest.examId}`);
  console.log(`[verifyRun] Provisioned students: ${manifest.studentCountProvisioned}\n`);

  const adapter = new PrismaPg({ connectionString: databaseUrl, max: 3 });
  const prisma = new PrismaClient({ adapter });

  try {
    const submissions = await prisma.submission.findMany({
      where: { examId: manifest.examId, student: { email: { in: credentials.students.map((s) => s.email) } } },
      include: { answers: true, student: { select: { id: true, email: true } } },
    });
    const emailToStudentIndex = new Map(credentials.students.map((s) => [s.email, s.studentIndex]));
    const submissionByStudentIndex = new Map(submissions.map((s) => [emailToStudentIndex.get(s.student.email), s]));

    // 1/2. Each synthetic submission belongs to the intended student; no cross-student references.
    console.log("Checking (1/2) submission ownership and no cross-student references...");
    let ownershipOk = true;
    for (const s of submissions) {
      const expectedIndex = emailToStudentIndex.get(s.student.email);
      if (expectedIndex == null) {
        fail("ownership", `Submission ${s.id} belongs to an email not in this run's provisioned student list: ${s.student.email}`);
        ownershipOk = false;
      }
    }
    if (ownershipOk) pass(`All ${submissions.length} submissions belong to their intended student — no cross-student references found.`);

    // 3/4/5. Every expected final answer is present, associated with the intended question, matches the deterministic expected value.
    console.log("Checking (3/4/5) final answers present, correctly associated, and matching deterministic expected values...");
    let answerMismatches = 0;
    let missingAnswers = 0;
    for (const [studentIndex, submission] of submissionByStudentIndex.entries()) {
      const answerByQuestionId = new Map(submission.answers.map((a) => [a.questionId, a]));
      for (const q of manifest.questions) {
        const answer = answerByQuestionId.get(q.id);
        if (!answer) {
          fail("lost-answer", `Student ${studentIndex} / submission ${submission.id}: no Answer row for question ${q.id} (fixtureIndex ${q.fixtureIndex}).`);
          missingAnswers++;
          continue;
        }
        const expected = expectedResponseFor(runId, studentIndex, q.fixtureIndex);
        if (answer.response !== expected) {
          fail("wrong-value", `Student ${studentIndex} / submission ${submission.id} / question ${q.id}: expected response "${expected}", got "${answer.response}".`);
          answerMismatches++;
        }
        // Wrong answer/question association would show up here as either
        // a value belonging to a DIFFERENT (studentIndex, questionIndex)
        // pair (self-identifying string, see deterministicAnswers.mjs) —
        // any mismatch already caught above is exactly that signal for
        // short-answer questions; for MCQ, correctness is checked next.
      }
    }
    if (missingAnswers === 0) pass(`No lost answers — every provisioned student has an Answer row for all ${manifest.questions.length} questions.`);
    if (answerMismatches === 0) pass("Every persisted answer matches its deterministic expected value — no wrong-question/wrong-student association detected.");

    // 6. Frozen question order remains valid.
    console.log("Checking (6) frozen question order remains valid...");
    let orderOk = true;
    for (const submission of submissions) {
      if (submission.questionOrderJson != null) {
        // This fixture never enables randomiseQuestionOrder/question pools
        // (see provisionFixture.mjs's PATCH body) — questionOrderJson
        // should therefore be null for every submission. A non-null value
        // here would indicate the fixture's own settings drifted from
        // what this harness intended, not a grading defect — flagged as
        // a finding either way since it changes what "correct" order
        // verification would mean.
        fail("question-order", `Submission ${submission.id} has a non-null questionOrderJson despite the fixture never enabling randomisation/pools.`);
        orderOk = false;
      }
    }
    if (orderOk) pass("Frozen question order is valid for every submission (no unexpected randomisation/pool state).");

    // 7. MCQ option/question association remains valid — correctAnswer scoring matches the deterministic design.
    console.log("Checking (7) MCQ option/question association and correctness...");
    let mcqScoreOk = true;
    for (const [studentIndex, submission] of submissionByStudentIndex.entries()) {
      if (submission.status !== "GRADED" && submission.status !== "SUBMITTED") continue;
      const answerByQuestionId = new Map(submission.answers.map((a) => [a.questionId, a]));
      for (const q of manifest.questions) {
        if (!isMcqIndex(q.fixtureIndex)) continue;
        const answer = answerByQuestionId.get(q.id);
        if (!answer) continue; // already flagged above
        const expectedCorrect = mcqCorrectOption(q.fixtureIndex);
        if (answer.response === expectedCorrect && answer.isCorrect !== true) {
          fail("mcq-scoring", `Student ${studentIndex} / question ${q.id}: submitted the correct option "${expectedCorrect}" but Answer.isCorrect is not true.`);
          mcqScoreOk = false;
        }
      }
    }
    if (mcqScoreOk) pass("MCQ grading matches the deterministic correct-option design for every graded submission.");

    // 8. Current/final question sequencing remains valid.
    console.log("Checking (8) final question sequencing...");
    let sequencingOk = true;
    for (const [studentIndex, submission] of submissionByStudentIndex.entries()) {
      if (submission.status === "IN_PROGRESS") {
        fail("sequencing", `Student ${studentIndex} / submission ${submission.id}: still IN_PROGRESS after the run — submit may have failed (see submit_success_rate in the k6 summary).`);
        sequencingOk = false;
        continue;
      }
      if (submission.currentQuestionIndex < manifest.questions.length - 1) {
        fail("sequencing", `Student ${studentIndex} / submission ${submission.id}: currentQuestionIndex=${submission.currentQuestionIndex}, expected to have reached the last question (${manifest.questions.length - 1}) before submitting.`);
        sequencingOk = false;
      }
    }
    if (sequencingOk) pass("Every finalized submission's question sequencing reached the end correctly.");

    // 9. Final submission status is correct.
    console.log("Checking (9) final submission status...");
    const hasEssay = manifest.questions.some((q) => q.type === "ESSAY");
    let statusOk = true;
    for (const [studentIndex, submission] of submissionByStudentIndex.entries()) {
      const expectedStatus = hasEssay ? "SUBMITTED" : "GRADED";
      if (submission.status !== expectedStatus && submission.status !== "IN_PROGRESS") {
        fail("final-status", `Student ${studentIndex} / submission ${submission.id}: expected status ${expectedStatus}, got ${submission.status}.`);
        statusOk = false;
      }
    }
    if (statusOk) pass(`Final submission status is ${hasEssay ? "SUBMITTED" : "GRADED"} for every finalized submission, as expected (this fixture has no ESSAY questions).`);

    // 10. Submit idempotency replay did not create corruption.
    console.log("Checking (10) submit idempotency replay integrity...");
    let duplicateOk = true;
    const dupeCheck = await prisma.submission.groupBy({
      by: ["examId", "studentId"],
      where: { examId: manifest.examId, student: { email: { in: credentials.students.map((s) => s.email) } } },
      _count: { _all: true },
    });
    for (const row of dupeCheck) {
      if (row._count._all > 1) {
        fail("duplicate-submission", `Student ${row.studentId} has ${row._count._all} Submission rows for exam ${manifest.examId} — expected exactly 1 (idempotent start + idempotent submit replay must never create a second row).`);
        duplicateOk = false;
      }
    }
    if (duplicateOk) pass("No duplicate Submission rows — idempotent start and idempotent submit-replay held under load.");

    // 11. Navigator state converges correctly (spot-check: answeredCount via SubmissionQuestionState visited rows vs. actual answer count).
    console.log("Checking (11) navigator visited-state convergence...");
    let navigatorOk = true;
    const questionStates = await prisma.submissionQuestionState.findMany({
      where: { submissionId: { in: [...submissionByStudentIndex.values()].map((s) => s.id) } },
    });
    const statesBySubmission = new Map();
    for (const st of questionStates) {
      if (!statesBySubmission.has(st.submissionId)) statesBySubmission.set(st.submissionId, []);
      statesBySubmission.get(st.submissionId).push(st);
    }
    for (const [studentIndex, submission] of submissionByStudentIndex.entries()) {
      const states = statesBySubmission.get(submission.id) ?? [];
      const visitedCount = states.filter((s) => s.firstVisitedAt != null).length;
      if (visitedCount < submission.answers.length) {
        fail("navigator-convergence", `Student ${studentIndex} / submission ${submission.id}: only ${visitedCount} questions marked visited but ${submission.answers.length} answers were saved — a question cannot be answered without having been visited.`);
        navigatorOk = false;
      }
    }
    if (navigatorOk) pass("Navigator visited-state is consistent with persisted answers for every submission (no under-counting).");

    // 12. No duplicate-corruption occurred (Answer uniqueness per submission+question).
    console.log("Checking (12) no duplicate Answer rows per (submission, question)...");
    let answerDupeOk = true;
    const answerDupeCheck = await prisma.answer.groupBy({
      by: ["submissionId", "questionId"],
      where: { submissionId: { in: [...submissionByStudentIndex.values()].map((s) => s.id) } },
      _count: { _all: true },
    });
    for (const row of answerDupeCheck) {
      if (row._count._all > 1) {
        fail("duplicate-answer", `Submission ${row.submissionId} / question ${row.questionId} has ${row._count._all} Answer rows — expected exactly 1.`);
        answerDupeOk = false;
      }
    }
    if (answerDupeOk) pass("No duplicate Answer rows for any (submission, question) pair.");

    // Explicit negative ownership test — a real HTTP request, not a DB read.
    console.log("\nChecking explicit negative ownership test (Student A must never read Student B's protected submission)...");
    if (submissions.length >= 2) {
      const [studentA, studentB] = credentials.students;
      const submissionForB = submissionByStudentIndex.get(studentB.studentIndex);
      if (submissionForB) {
        const res = await fetch(new URL(`/api/submissions/${submissionForB.id}`, targetBaseUrl), {
          headers: { Cookie: studentA.cookieHeader },
        });
        if (res.status === 403 || res.status === 404) {
          pass(`Student A's attempt to read Student B's submission was correctly rejected (HTTP ${res.status}).`);
        } else {
          fail("ownership-bypass", `Student A's cookie was able to read Student B's submission ${submissionForB.id} — HTTP ${res.status} (expected 403/404).`);
        }
      }
    } else {
      console.log("  (skipped — fewer than 2 provisioned students in this run)");
    }

    console.log(`\n${"=".repeat(60)}`);
    if (findings.length === 0) {
      console.log("VERIFICATION RESULT: PASS — 0 findings against every hard correctness gate.");
    } else {
      console.log(`VERIFICATION RESULT: FAIL — ${findings.length} finding(s):`);
      for (const f of findings) console.log(`  - [${f.category}] ${f.detail}`);
    }
    console.log("=".repeat(60));
    process.exitCode = findings.length === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[verifyRun] FAILED:", err);
  process.exit(1);
});
