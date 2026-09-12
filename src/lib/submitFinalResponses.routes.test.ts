/**
 * Manual-submit answer flush fix, Part 2 — atomic terminal-response
 * persistence. DB-backed route tests for the `finalResponses` payload
 * POST /api/submissions/[id]/submit now optionally accepts, and writes
 * transactionally (via the same saveAnswerWithIdempotency path ordinary
 * autosave uses) BEFORE grading/finalizing. See
 * docs/tether-secure-resume-recovery-v1.md and
 * src/app/api/submissions/[id]/submit/route.ts's own doc comments.
 *
 * SAFE EXECUTION ONLY: run this file exclusively via `npm run
 * release:validate` — never a direct `npx vitest run` against this
 * repository's committed DATABASE_URL. See
 * src/lib/prismaDbSafetyGuard.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const startRoute = await import("../app/api/exams/[id]/start/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const answersRoute = await import("../app/api/submissions/[id]/answers/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT") {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId: testInstitution.id } };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let testInstitution: { id: string };
let lecturer: { id: string };
let student: { id: string };
const stamp = Date.now();
const cleanupExamIds: string[] = [];

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("submit-final-responses-test");
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Final Responses Lecturer", email: `final-resp-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitution.id },
  });
  student = await prisma.user.create({
    data: { name: "Final Responses Student", email: `final-resp-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
});

afterAll(async () => {
  await prisma.submission.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturer.id, student.id] } } });
  await prisma.$disconnect();
});

/** MCQ + SHORT_ANSWER + ESSAY questions, mirroring the three types this fix covers. */
async function createMixedExam(title: string) {
  const exam = await prisma.exam.create({
    data: { title: `${title} ${stamp}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
  });
  cleanupExamIds.push(exam.id);
  const mcq = await prisma.question.create({
    data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "MCQ Q", points: 1, options: ["A", "B", "C"], correctAnswer: "B", order: 0 },
  });
  const shortAnswer = await prisma.question.create({
    data: { examId: exam.id, type: "SHORT_ANSWER", text: "Short Q", points: 1, correctAnswer: "paris", order: 1 },
  });
  const essay = await prisma.question.create({
    data: { examId: exam.id, type: "ESSAY", text: "Essay Q", points: 5, order: 2 },
  });
  return { exam, mcq, shortAnswer, essay };
}

async function startAsStudent(examId: string) {
  mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
  const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examId }) });
  expect(res.status).toBeLessThan(300);
  return res.json();
}

describe("POST /api/submissions/[id]/submit — finalResponses (atomic terminal-response persistence)", () => {
  it("1/3/4/7 — ESSAY, SHORT_ANSWER, and MCQ responses that were NEVER separately autosaved still reach Answer.response via finalResponses, and auto-grading (MCQ/SHORT_ANSWER) uses those terminally-persisted values", async () => {
    const { exam, mcq, shortAnswer, essay } = await createMixedExam("Never Autosaved Exam");
    const submission = await startAsStudent(exam.id);

    // No PATCH /answers call at all for any question — simulating every
    // prior autosave attempt having failed. finalResponses is the ONLY
    // source of truth for this submit.
    const res = await submitRoute.POST(
      jsonRequest("POST", {
        submissionRequestId: "req-1",
        finalResponses: { [mcq.id]: "B", [shortAnswer.id]: "Paris", [essay.id]: "A very long essay the student just finished typing." },
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // hasEssay -> SUBMITTED (not auto-graded to GRADED), matching existing behaviour.
    expect(body.status).toBe("SUBMITTED");

    const answers = await prisma.answer.findMany({ where: { submissionId: submission.id } });
    const byQ = new Map(answers.map((a) => [a.questionId, a]));
    expect(byQ.get(mcq.id)?.response).toBe("B");
    expect(byQ.get(mcq.id)?.isCorrect).toBe(true); // auto-graded from the terminally-persisted response
    expect(byQ.get(mcq.id)?.score).toBe(1);
    expect(byQ.get(shortAnswer.id)?.response).toBe("Paris");
    expect(byQ.get(shortAnswer.id)?.isCorrect).toBe(true); // case/whitespace-insensitive match, same as the existing grading logic
    expect(byQ.get(essay.id)?.response).toBe("A very long essay the student just finished typing.");
    expect(byQ.get(essay.id)?.score).toBeNull(); // essays are never auto-scored
  });

  it("2 — finalResponses OVERRIDES a stale/older autosaved value with the client's newer terminal snapshot (the exact race this fix closes: a slow/failed final PATCH must never win over what the student actually submitted)", async () => {
    const { exam, essay } = await createMixedExam("Stale Autosave Exam");
    const submission = await startAsStudent(exam.id);

    // An earlier, successful autosave PATCH landed an OLDER draft.
    const patchRes = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: essay.id, response: "Old draft, first paragraph only." }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(patchRes.status).toBe(200);

    // The student kept typing after that; the LATEST text never made it
    // through a separate autosave, only via the terminal submit.
    const res = await submitRoute.POST(
      jsonRequest("POST", { submissionRequestId: "req-2", finalResponses: { [essay.id]: "Old draft, first paragraph only. Plus the final sentence the student just typed." } }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(200);

    const answer = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: essay.id } } });
    expect(answer?.response).toBe("Old draft, first paragraph only. Plus the final sentence the student just typed.");
  });

  it("5/8 — rejects (400) a finalResponses entry whose questionId does not belong to this submission's own exam, and writes NOTHING (submission stays IN_PROGRESS, no Answer row created) — the same boundary that keeps this from ever bypassing one-question-at-a-time/question-scope security", async () => {
    const { exam } = await createMixedExam("Boundary Exam A");
    const { exam: otherExam, essay: otherEssay } = await createMixedExam("Boundary Exam B (foreign question)");
    void otherExam;
    const submission = await startAsStudent(exam.id);

    const res = await submitRoute.POST(
      jsonRequest("POST", { submissionRequestId: "req-3", finalResponses: { [otherEssay.id]: "Should never be written." } }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FINAL_RESPONSE_QUESTION");

    const fresh = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(fresh?.status).toBe("IN_PROGRESS");
    const foreignAnswer = await prisma.answer.findUnique({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: otherEssay.id } },
    });
    expect(foreignAnswer).toBeNull();
  });

  it("malformed finalResponses (non-string value) is rejected (400) before any write", async () => {
    const { exam, essay } = await createMixedExam("Malformed Payload Exam");
    const submission = await startAsStudent(exam.id);

    const res = await submitRoute.POST(
      jsonRequest("POST", { submissionRequestId: "req-4", finalResponses: { [essay.id]: 12345 } }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_FINAL_RESPONSES");

    const fresh = await prisma.submission.findUnique({ where: { id: submission.id } });
    expect(fresh?.status).toBe("IN_PROGRESS");
  });

  it("6/12 — a duplicate/idempotent retry with the same submissionRequestId and finalResponses never re-finalizes, corrupts, or duplicates Answer rows; a further submit against the now-finalized submission is rejected the same way plain PATCH /answers already is", async () => {
    const { exam, essay } = await createMixedExam("Idempotent Retry Exam");
    const submission = await startAsStudent(exam.id);

    const payload = { submissionRequestId: "req-5-same", finalResponses: { [essay.id]: "The final answer." } };
    const first = await submitRoute.POST(jsonRequest("POST", payload), { params: Promise.resolve({ id: submission.id }) });
    expect(first.status).toBe(200);

    // Client-side retry of the EXACT same request (e.g. the response to
    // the first call was lost over a flaky connection).
    const second = await submitRoute.POST(jsonRequest("POST", payload), { params: Promise.resolve({ id: submission.id }) });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.code).toBe("ALREADY_FINALIZED");

    const answers = await prisma.answer.findMany({ where: { submissionId: submission.id, questionId: essay.id } });
    expect(answers).toHaveLength(1); // never duplicated
    expect(answers[0].response).toBe("The final answer.");

    // Finalized submission still rejects edits — unchanged, pre-existing
    // guarantee, re-confirmed here now that finalResponses exists as an
    // additional write path into Answer.response.
    const patchAfterFinalize = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: essay.id, response: "Trying to edit after submit." }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(patchAfterFinalize.status).toBe(409);
    const stillOnlyAnswer = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: essay.id } } });
    expect(stillOnlyAnswer?.response).toBe("The final answer.");
  });

  it("omitting finalResponses entirely is fully backward-compatible — submission still finalizes normally from whatever Answer rows autosave already committed", async () => {
    const { exam, shortAnswer } = await createMixedExam("Backward Compatible Exam");
    const submission = await startAsStudent(exam.id);
    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: shortAnswer.id, response: "Paris" }), { params: Promise.resolve({ id: submission.id }) });

    const res = await submitRoute.POST(jsonRequest("POST", { submissionRequestId: "req-6" }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const answer = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: shortAnswer.id } } });
    expect(answer?.response).toBe("Paris");
    expect(answer?.isCorrect).toBe(true);
  });

  it("9 — systemAutoSubmit:true also honours finalResponses (the auto-submit-at-timer-expiry path preserves the student's latest current answer, not just manual submit)", async () => {
    const { exam, essay } = await createMixedExam("Auto Submit Exam");
    const submission = await startAsStudent(exam.id);

    const res = await submitRoute.POST(
      jsonRequest("POST", { systemAutoSubmit: true, submissionRequestId: "req-7", finalResponses: { [essay.id]: "Whatever was on screen when the timer hit zero." } }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(200);
    const answer = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: essay.id } } });
    expect(answer?.response).toBe("Whatever was on screen when the timer hit zero.");
  });
});
