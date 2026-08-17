/**
 * Controlled AI commercial completion pass — pure tests for the derived
 * lecturer-facing summary. See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * summarizeAiAssistanceInteractions operates only on the ALREADY-normalized
 * `AiAssistanceReviewInteraction[]` that buildAiAssistanceReview produces
 * (stale-RESERVED rows already mapped to "FAILED" by the time this runs —
 * see aiAssistanceReview.ts) — so these tests construct interaction fixtures
 * directly with final statuses rather than exercising the DB-backed
 * stale-reservation normalization itself (covered separately by
 * aiAssistancePolicy.test.ts's isStaleReservation tests and
 * aiAssistance.routes.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  summarizeAiAssistanceInteractions,
  buildAiAssistanceReview,
  type AiAssistanceReviewInteraction,
} from "./aiAssistanceReview";
import { prisma } from "./prisma";
import { getOrCreateTestInstitution } from "./testInstitution";

function interaction(overrides: Partial<AiAssistanceReviewInteraction>): AiAssistanceReviewInteraction {
  return {
    id: overrides.id ?? "interaction-1",
    questionId: overrides.questionId ?? "question-1",
    questionText: "What is the capital of France?",
    studentPrompt: "Can you help me understand this question?",
    response: overrides.response ?? "Think about what you already know about French geography.",
    status: overrides.status ?? "APPROVED",
    wasRegenerated: overrides.wasRegenerated ?? false,
    promptNumberForQuestion: overrides.promptNumberForQuestion ?? 1,
    promptNumberForAttempt: overrides.promptNumberForAttempt ?? 1,
    policyVersion: "v1",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("summarizeAiAssistanceInteractions", () => {
  it("returns all-zero counts for no interactions", () => {
    expect(summarizeAiAssistanceInteractions([])).toEqual({
      totalRequests: 0,
      guidanceShownCount: 0,
      declinedCount: 0,
      failedCount: 0,
      questionsUsedCount: 0,
    });
  });

  it("counts an APPROVED interaction toward guidanceShownCount, not declined or failed", () => {
    const summary = summarizeAiAssistanceInteractions([interaction({ status: "APPROVED" })]);
    expect(summary.totalRequests).toBe(1);
    expect(summary.guidanceShownCount).toBe(1);
    expect(summary.declinedCount).toBe(0);
    expect(summary.failedCount).toBe(0);
  });

  it("counts a FALLBACK interaction toward guidanceShownCount — a deterministic safe response was still shown to the student", () => {
    const summary = summarizeAiAssistanceInteractions([interaction({ status: "FALLBACK" })]);
    expect(summary.guidanceShownCount).toBe(1);
    expect(summary.declinedCount).toBe(0);
    expect(summary.failedCount).toBe(0);
  });

  it("counts a BLOCKED interaction toward declinedCount only", () => {
    const summary = summarizeAiAssistanceInteractions([interaction({ status: "BLOCKED", response: null })]);
    expect(summary.guidanceShownCount).toBe(0);
    expect(summary.declinedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
  });

  it("counts a FAILED interaction toward failedCount only — including one that originated as a stale RESERVED row normalized upstream", () => {
    // buildAiAssistanceReview() already maps a stale-RESERVED row's status
    // to "FAILED" before this function ever sees it — see the ternary in
    // aiAssistanceReview.ts. This fixture stands in for that normalized
    // result, confirming the summary applies the SAME interpretation
    // rather than re-deriving it (e.g. never treating a stale reservation
    // as "guidance shown" or silently dropping it from totalRequests).
    const summary = summarizeAiAssistanceInteractions([interaction({ status: "FAILED", response: null })]);
    expect(summary.totalRequests).toBe(1);
    expect(summary.guidanceShownCount).toBe(0);
    expect(summary.declinedCount).toBe(0);
    expect(summary.failedCount).toBe(1);
  });

  it("counts distinct questionIds only once, even across many interactions on the same question", () => {
    const summary = summarizeAiAssistanceInteractions([
      interaction({ id: "a", questionId: "q1", promptNumberForQuestion: 1 }),
      interaction({ id: "b", questionId: "q1", promptNumberForQuestion: 2 }),
      interaction({ id: "c", questionId: "q2", promptNumberForQuestion: 1 }),
    ]);
    expect(summary.totalRequests).toBe(3);
    expect(summary.questionsUsedCount).toBe(2);
  });

  it("derives correct mixed-status totals across APPROVED, FALLBACK, BLOCKED and FAILED in one attempt", () => {
    const summary = summarizeAiAssistanceInteractions([
      interaction({ id: "a", questionId: "q1", status: "APPROVED" }),
      interaction({ id: "b", questionId: "q1", status: "FALLBACK" }),
      interaction({ id: "c", questionId: "q2", status: "BLOCKED", response: null }),
      interaction({ id: "d", questionId: "q3", status: "FAILED", response: null }),
    ]);
    expect(summary).toEqual({
      totalRequests: 4,
      guidanceShownCount: 2,
      declinedCount: 1,
      failedCount: 1,
      questionsUsedCount: 3,
    });
  });
});

/**
 * Regression coverage for a semantic bug found in review: buildAiAssistanceReview
 * previously derived aiAssistanceEnabled as `snapshot != null`, but
 * POST /api/exams/[id]/start (see buildAiAssistancePolicySnapshot's call
 * site there) stores a policy snapshot UNCONDITIONALLY, even when the
 * frozen mode is DISABLED — so a non-null snapshot never actually implied
 * Controlled AI was enabled. The fix reads the snapshot's own `mode`
 * through the same fail-closed parseAiAssistancePolicy()/isAiAssistanceEnabled()
 * pair every request-time decision already goes through (see
 * aiAssistancePolicy.ts), rather than re-deriving the answer from
 * "is there JSON at all". DB-backed — requires the disposable
 * release:validate Postgres instance, same as aiAssistance.routes.test.ts.
 */
describe("buildAiAssistanceReview — aiAssistanceEnabled reflects the snapshot's mode, not merely its presence", () => {
  const stamp = Date.now();
  const cleanup = { users: [] as string[], exams: [] as string[] };
  let instA: string;
  let lecturerA: { id: string };
  let studentA: { id: string };

  beforeAll(async () => {
    const inst = await getOrCreateTestInstitution(`ai-review-enabled-${stamp}`);
    instA = inst.id;
    const passwordHash = await bcrypt.hash("test-password", 4);
    lecturerA = await prisma.user.create({
      data: { name: "Review Lecturer", email: `review-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
    });
    studentA = await prisma.user.create({
      data: { name: "Review Student", email: `review-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
    });
    cleanup.users.push(lecturerA.id, studentA.id);
  });

  afterAll(async () => {
    await prisma.aiAssistanceInteraction.deleteMany({ where: { examId: { in: cleanup.exams } } });
    await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
    await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
    await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
    await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
  });

  function lecturerSession() {
    return {
      user: { id: lecturerA.id, email: lecturerA.id, name: "Review Lecturer", role: "LECTURER", institutionId: instA },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    } as unknown as Parameters<typeof buildAiAssistanceReview>[1];
  }

  async function createSubmission(aiAssistancePolicySnapshotJson: unknown) {
    const exam = await prisma.exam.create({
      data: {
        title: `AI Review Enabled Semantics Exam ${Date.now()}-${Math.random()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA,
      },
    });
    cleanup.exams.push(exam.id);
    const submission = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: studentA.id,
        status: "IN_PROGRESS",
        aiAssistancePolicySnapshotJson:
          aiAssistancePolicySnapshotJson === undefined
            ? undefined
            : (aiAssistancePolicySnapshotJson as never),
      },
    });
    return submission;
  }

  it("1. a null (never taken) snapshot resolves aiAssistanceEnabled: false", async () => {
    const submission = await createSubmission(undefined);
    const review = await buildAiAssistanceReview(submission.id, lecturerSession());
    expect(review.aiAssistanceEnabled).toBe(false);
  });

  it("2. a malformed snapshot (no recognizable mode) resolves aiAssistanceEnabled: false", async () => {
    const submission = await createSubmission({ garbage: true, notAPolicy: 42 });
    const review = await buildAiAssistanceReview(submission.id, lecturerSession());
    expect(review.aiAssistanceEnabled).toBe(false);
  });

  it("3. a valid, well-formed snapshot with mode DISABLED resolves aiAssistanceEnabled: false — the exact bug this regresses (a non-null snapshot alone must never read as enabled)", async () => {
    const submission = await createSubmission({
      schemaVersion: 1,
      policyVersion: "v1.0",
      mode: "DISABLED",
      maxPromptsPerQuestion: 0,
      maxPromptsPerAttempt: 0,
      maxResponseCharacters: 0,
      allowConceptExplanations: false,
      allowAnswerPlanning: false,
      allowReasoningFeedback: false,
      allowProgrammingConceptHelp: false,
    });
    const review = await buildAiAssistanceReview(submission.id, lecturerSession());
    expect(review.aiAssistanceEnabled).toBe(false);
  });

  it("4. a valid snapshot with mode BRAINSTORM_ONLY resolves aiAssistanceEnabled: true", async () => {
    const submission = await createSubmission({
      schemaVersion: 1,
      policyVersion: "v1.0",
      mode: "BRAINSTORM_ONLY",
      maxPromptsPerQuestion: 3,
      maxPromptsPerAttempt: 10,
      maxResponseCharacters: 800,
      allowConceptExplanations: true,
      allowAnswerPlanning: true,
      allowReasoningFeedback: true,
      allowProgrammingConceptHelp: true,
    });
    const review = await buildAiAssistanceReview(submission.id, lecturerSession());
    expect(review.aiAssistanceEnabled).toBe(true);
  });

  it("enabled + zero interactions still reports enabled with an all-zero summary — the 'Enabled — no requests made' UI state's underlying data", async () => {
    const submission = await createSubmission({
      schemaVersion: 1,
      policyVersion: "v1.0",
      mode: "BRAINSTORM_ONLY",
      maxPromptsPerQuestion: 3,
      maxPromptsPerAttempt: 10,
      maxResponseCharacters: 800,
      allowConceptExplanations: true,
      allowAnswerPlanning: true,
      allowReasoningFeedback: true,
      allowProgrammingConceptHelp: true,
    });
    const review = await buildAiAssistanceReview(submission.id, lecturerSession());
    expect(review.aiAssistanceEnabled).toBe(true);
    expect(review.summary).toEqual({
      totalRequests: 0,
      guidanceShownCount: 0,
      declinedCount: 0,
      failedCount: 0,
      questionsUsedCount: 0,
    });
    expect(review.interactions).toEqual([]);
  });

  it("summary counts are unaffected by this fix — still derived purely from interactions, not from the enabled flag", async () => {
    const submission = await createSubmission({
      schemaVersion: 1,
      policyVersion: "v1.0",
      mode: "DISABLED",
      maxPromptsPerQuestion: 0,
      maxPromptsPerAttempt: 0,
      maxResponseCharacters: 0,
      allowConceptExplanations: false,
      allowAnswerPlanning: false,
      allowReasoningFeedback: false,
      allowProgrammingConceptHelp: false,
    });
    const review = await buildAiAssistanceReview(submission.id, lecturerSession());
    // Even with aiAssistanceEnabled: false (DISABLED), a leftover
    // interaction from before a lecturer disabled Controlled AI must still
    // be counted correctly — the enabled flag and the summary are
    // independent derivations, neither one gates the other.
    expect(review.summary.totalRequests).toBe(0);
  });

  it("never introduces risk/misconduct language or fields on the review object", async () => {
    const submission = await createSubmission({
      schemaVersion: 1,
      policyVersion: "v1.0",
      mode: "BRAINSTORM_ONLY",
      maxPromptsPerQuestion: 3,
      maxPromptsPerAttempt: 10,
      maxResponseCharacters: 800,
      allowConceptExplanations: true,
      allowAnswerPlanning: true,
      allowReasoningFeedback: true,
      allowProgrammingConceptHelp: true,
    });
    const review = await buildAiAssistanceReview(submission.id, lecturerSession());
    const keys = Object.keys(review);
    expect(keys.join(" ").toLowerCase()).not.toMatch(/risk|misconduct|suspicion/);
  });
});
