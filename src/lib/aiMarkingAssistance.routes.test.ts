/**
 * AI Marking Assistance v1 — see docs/ai-marking-assistance-v1.md.
 *
 * DB-backed route tests covering:
 *  - PATCH /api/lecturer/exams/[examId]/marking-guides (question-level
 *    guide management — ownership, ESSAY-only, persistence).
 *  - POST /api/lecturer/submissions/[id]/answers/[questionId]/ai-mark
 *    (single-answer marking) automatically reusing the question's saved
 *    guide, never a per-call caller-supplied one.
 *  - POST /api/lecturer/exams/[examId]/ai-mark-essays ("generate missing
 *    AI suggestions" — never overwrites an existing draft) automatically
 *    reusing the question's saved guide too, and always reporting a
 *    full eligible/generated/alreadySuggested/failed breakdown.
 *  - POST /api/lecturer/exams/[examId]/ai-mark-essays/regenerate
 *    ("regenerate AI suggestions" — deliberately overwrites every
 *    eligible essay answer's existing draft using each question's
 *    CURRENT saved guide), and that it never touches manual scores,
 *    finalized grades, student answers, or non-essay questions.
 *  - Version behaviour: an existing Answer.aiReasoning snapshot is never
 *    mutated when the question's guide changes later; a fresh/regenerated
 *    draft always uses the latest saved guide.
 *  - Student-facing leak checks: GET /api/exams/[id] and GET
 *    /api/submissions/[id] never expose Question.aiMarkingGuide to a
 *    STUDENT, in any attempt state.
 *
 * Mocks @/lib/ai/essayMarker's markEssay (never the Anthropic SDK
 * directly here — that's already covered by essayMarker.test.ts) so
 * these tests exercise ownership/eligibility/persistence against a real
 * database, never a live model.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { mockMarkEssay } = vi.hoisted(() => ({ mockMarkEssay: vi.fn() }));
vi.mock("@/lib/ai/essayMarker", async () => {
  const actual = await vi.importActual<typeof import("./ai/essayMarker")>("./ai/essayMarker");
  return { ...actual, markEssay: mockMarkEssay };
});

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const aiMarkRoute = await import("../app/api/lecturer/submissions/[id]/answers/[questionId]/ai-mark/route");
const bulkMarkRoute = await import("../app/api/lecturer/exams/[examId]/ai-mark-essays/route");
const regenerateRoute = await import("../app/api/lecturer/exams/[examId]/ai-mark-essays/regenerate/route");
const markingGuidesRoute = await import("../app/api/lecturer/exams/[examId]/marking-guides/route");
const examRoute = await import("../app/api/exams/[id]/route");
const submissionRoute = await import("../app/api/submissions/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const gradeRoute = await import("../app/api/submissions/[id]/grade/route");

const stamp = Date.now();

function sessionFor(userId: string, role: "LECTURER" | "STUDENT", institutionId: string) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let institutionId: string;
let lecturerId: string;
let otherLecturerId: string;
let studentAId: string;
let studentBId: string;
const cleanupExamIds: string[] = [];
const cleanupUserIds: string[] = [];

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`ai-marking-guides-${stamp}`);
  institutionId = inst.id;
  const passwordHash = await bcrypt.hash("password", 4);
  const lecturer = await prisma.user.create({
    data: { name: "AI Marking Lecturer", email: `ai-mark-lect-${stamp}@test.invalid`, passwordHash, role: "LECTURER", institutionId },
  });
  lecturerId = lecturer.id;
  const otherLecturer = await prisma.user.create({
    data: { name: "AI Marking Other Lecturer", email: `ai-mark-lect2-${stamp}@test.invalid`, passwordHash, role: "LECTURER", institutionId },
  });
  otherLecturerId = otherLecturer.id;
  const studentA = await prisma.user.create({
    data: { name: "AI Marking Student A", email: `ai-mark-studA-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
  });
  studentAId = studentA.id;
  const studentB = await prisma.user.create({
    data: { name: "AI Marking Student B", email: `ai-mark-studB-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
  });
  studentBId = studentB.id;
  cleanupUserIds.push(lecturerId, otherLecturerId, studentAId, studentBId);
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterAll(async () => {
  await prisma.answer.deleteMany({ where: { submission: { studentId: { in: [studentAId, studentBId] } } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: [studentAId, studentBId] } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

beforeEach(() => {
  mockMarkEssay.mockReset();
});

const VALID_RESULT = {
  criteriaScores: [{ criterion: "Content & accuracy", score: 5, maxMarks: 6, justification: "Mentions the key mechanism." }],
  totalScore: 5,
  totalMaxMarks: 6,
  overallFeedback: "Solid attempt.",
  strengths: ["Clear structure"],
  areasForImprovement: ["More detail needed"],
  confidence: "HIGH" as const,
};

async function makeExamWithTwoEssays(tag: string) {
  const exam = await prisma.exam.create({
    data: { title: `AI Marking Guides Exam ${tag} ${stamp}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerId, institutionId },
  });
  cleanupExamIds.push(exam.id);
  const questionA = await prisma.question.create({
    data: { examId: exam.id, type: "ESSAY", text: "Explain photosynthesis.", points: 10, order: 0 },
  });
  const questionB = await prisma.question.create({
    data: { examId: exam.id, type: "ESSAY", text: "Explain mitosis.", points: 10, order: 1 },
  });
  return { exam, questionA, questionB };
}

async function makeSubmission(examId: string, questionId: string, studentId: string, response = "A student answer.") {
  const submission = await prisma.submission.create({
    data: { examId, studentId, status: "SUBMITTED", submittedAt: new Date() },
  });
  await prisma.answer.create({ data: { submissionId: submission.id, questionId, response } });
  return submission;
}

describe("PATCH /api/lecturer/exams/[examId]/marking-guides — question-level guide management", () => {
  it("saves a marking guide for one essay question", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("save-one");
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(
      jsonRequest("PATCH", { guides: [{ questionId: questionA.id, aiMarkingGuide: "Award full marks only if chlorophyll is mentioned." }] }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);

    const updated = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    expect(updated.aiMarkingGuide).toBe("Award full marks only if chlorophyll is mentioned.");
  });

  it("Question B can have a different guide from Question A, saved in the same request", async () => {
    const { exam, questionA, questionB } = await makeExamWithTwoEssays("two-guides");
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(
      jsonRequest("PATCH", {
        guides: [
          { questionId: questionA.id, aiMarkingGuide: "Guide for photosynthesis." },
          { questionId: questionB.id, aiMarkingGuide: "Guide for mitosis." },
        ],
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(200);

    const a = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    const b = await prisma.question.findUniqueOrThrow({ where: { id: questionB.id } });
    expect(a.aiMarkingGuide).toBe("Guide for photosynthesis.");
    expect(b.aiMarkingGuide).toBe("Guide for mitosis.");
  });

  it("null/empty clears a previously saved guide", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("clear-guide");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Old guide" } });
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(jsonRequest("PATCH", { guides: [{ questionId: questionA.id, aiMarkingGuide: null }] }), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(200);
    const updated = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    expect(updated.aiMarkingGuide).toBeNull();
  });

  it("valid multi-question save: every submitted guide persists", async () => {
    const { exam, questionA, questionB } = await makeExamWithTwoEssays("valid-multi");
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(
      jsonRequest("PATCH", {
        guides: [
          { questionId: questionA.id, aiMarkingGuide: "Guide A." },
          { questionId: questionB.id, aiMarkingGuide: "Guide B." },
        ],
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);
    const a = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    const b = await prisma.question.findUniqueOrThrow({ where: { id: questionB.id } });
    expect(a.aiMarkingGuide).toBe("Guide A.");
    expect(b.aiMarkingGuide).toBe("Guide B.");
  });

  it("rejects the whole batch (400) when one questionId is invalid/nonexistent — never a partial save", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("invalid-id");
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(
      jsonRequest("PATCH", {
        guides: [
          { questionId: questionA.id, aiMarkingGuide: "Would have been saved." },
          { questionId: "does-not-exist", aiMarkingGuide: "Bogus." },
        ],
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.invalidQuestionIds).toEqual(["does-not-exist"]);

    // The batch is rejected wholesale — the OTHERWISE-valid Question A
    // guide must not have been silently saved either.
    const a = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    expect(a.aiMarkingGuide).toBeNull();
  });

  it("rejects the whole batch (400) when a questionId belongs to a DIFFERENT exam", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("foreign-exam-a");
    const { questionA: foreignQuestion } = await makeExamWithTwoEssays("foreign-exam-b");
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(
      jsonRequest("PATCH", {
        guides: [
          { questionId: questionA.id, aiMarkingGuide: "Would have been saved." },
          { questionId: foreignQuestion.id, aiMarkingGuide: "Belongs to a different exam." },
        ],
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.invalidQuestionIds).toEqual([foreignQuestion.id]);

    const a = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    expect(a.aiMarkingGuide).toBeNull();
    const foreignAfter = await prisma.question.findUniqueOrThrow({ where: { id: foreignQuestion.id } });
    expect(foreignAfter.aiMarkingGuide).toBeNull();
  });

  it("rejects the whole batch (400) when a questionId is non-ESSAY (e.g. MULTIPLE_CHOICE)", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("non-essay");
    const mcq = await prisma.question.create({ data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "2+2=?", points: 1, options: ["3", "4"], correctAnswer: "4" } });
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(
      jsonRequest("PATCH", {
        guides: [
          { questionId: questionA.id, aiMarkingGuide: "Would have been saved." },
          { questionId: mcq.id, aiMarkingGuide: "MCQ can't have a marking guide." },
        ],
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.invalidQuestionIds).toEqual([mcq.id]);

    // No partial persistence — Question A's otherwise-valid guide is
    // untouched, and the MCQ never gets a guide either.
    const a = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    expect(a.aiMarkingGuide).toBeNull();
    const mcqAfter = await prisma.question.findUniqueOrThrow({ where: { id: mcq.id } });
    expect(mcqAfter.aiMarkingGuide).toBeNull();
  });

  it("failed batch: a previously saved guide on a VALID question is left exactly as it was, not reset or altered", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("failed-batch-preserves-existing");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Guide saved earlier." } });
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(
      jsonRequest("PATCH", {
        guides: [
          { questionId: questionA.id, aiMarkingGuide: "Attempted new guide — should never apply." },
          { questionId: "does-not-exist", aiMarkingGuide: "Bogus." },
        ],
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(400);

    const a = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    expect(a.aiMarkingGuide).toBe("Guide saved earlier."); // unchanged — the failed batch touched nothing
  });

  it("blocks a non-owning lecturer from editing another exam's marking guides", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("non-owner");
    mockAuth.mockResolvedValue(sessionFor(otherLecturerId, "LECTURER", institutionId));
    const res = await markingGuidesRoute.PATCH(jsonRequest("PATCH", { guides: [{ questionId: questionA.id, aiMarkingGuide: "Hijacked guide" }] }), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(404);
    const untouched = await prisma.question.findUniqueOrThrow({ where: { id: questionA.id } });
    expect(untouched.aiMarkingGuide).toBeNull();
  });

  it("blocks a student", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("student-block");
    mockAuth.mockResolvedValue(sessionFor(studentAId, "STUDENT", institutionId));
    const res = await markingGuidesRoute.PATCH(jsonRequest("PATCH", { guides: [{ questionId: questionA.id, aiMarkingGuide: "Should never work" }] }), {
      params: Promise.resolve({ examId: exam.id }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/lecturer/submissions/[id]/answers/[questionId]/ai-mark — automatically reuses the question's saved guide", () => {
  it("Student A's and Student B's answers to the same Question A both use the guide saved for that question", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("shared-guide");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Shared guide for Question A." } });
    const submissionA = await makeSubmission(exam.id, questionA.id, studentAId, "Student A's answer.");
    const submissionB = await makeSubmission(exam.id, questionA.id, studentBId, "Student B's answer.");
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const resA = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submissionA.id, questionId: questionA.id }) });
    const resB = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submissionB.id, questionId: questionA.id }) });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    expect(mockMarkEssay).toHaveBeenCalledTimes(2);
    for (const call of mockMarkEssay.mock.calls) {
      expect(call[0].rubric).toEqual([{ criterion: "Lecturer marking guide", description: "Shared guide for Question A.", maxMarks: 10 }]);
    }

    const answerA = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submissionA.id, questionId: questionA.id } } });
    const answerB = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submissionB.id, questionId: questionA.id } } });
    expect(JSON.parse(answerA.aiReasoning!).lecturerGuideText).toBe("Shared guide for Question A.");
    expect(JSON.parse(answerB.aiReasoning!).lecturerGuideText).toBe("Shared guide for Question A.");
  });

  it("Question B uses its own saved guide, never Question A's", async () => {
    const { exam, questionA, questionB } = await makeExamWithTwoEssays("distinct-guides");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Guide for photosynthesis." } });
    await prisma.question.update({ where: { id: questionB.id }, data: { aiMarkingGuide: "Guide for mitosis." } });
    const submissionA = await makeSubmission(exam.id, questionA.id, studentAId);
    await prisma.answer.create({ data: { submissionId: submissionA.id, questionId: questionB.id, response: "Mitosis answer." } });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submissionA.id, questionId: questionA.id }) });
    await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submissionA.id, questionId: questionB.id }) });

    expect(mockMarkEssay.mock.calls[0][0].rubric[0].description).toBe("Guide for photosynthesis.");
    expect(mockMarkEssay.mock.calls[1][0].rubric[0].description).toBe("Guide for mitosis.");
  });

  it("no guide configured falls back to the default rubric", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("no-guide");
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: questionA.id }) });
    expect(res.status).toBe(200);

    expect(mockMarkEssay).toHaveBeenCalledWith(
      expect.objectContaining({
        rubric: [
          { criterion: "Content & accuracy", description: "Response demonstrates understanding and accuracy", maxMarks: 6 },
          { criterion: "Clarity & structure", description: "Response is well-organised and clearly expressed", maxMarks: 4 },
        ],
      }),
    );
    const updated = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    expect(JSON.parse(updated.aiReasoning!).rubricSource).toBe("DEFAULT");
  });

  it("works with no request body at all — the endpoint never depends on caller-supplied guide text", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("no-body");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Saved guide." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(new Request("http://test.local/route", { method: "POST" }), {
      params: Promise.resolve({ id: submission.id, questionId: questionA.id }),
    });
    expect(res.status).toBe(200);
    expect(mockMarkEssay).toHaveBeenCalledWith(expect.objectContaining({ rubric: [{ criterion: "Lecturer marking guide", description: "Saved guide.", maxMarks: 10 }] }));
  });

  it("changing the question's guide later does NOT mutate an existing AI draft's saved snapshot", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("no-retroactive-mutation");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Original guide." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: questionA.id }) });

    const draftBefore = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    expect(JSON.parse(draftBefore.aiReasoning!).lecturerGuideText).toBe("Original guide.");

    // Lecturer edits the question's guide afterward.
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Updated guide." } });

    const draftAfter = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    expect(JSON.parse(draftAfter.aiReasoning!).lecturerGuideText).toBe("Original guide."); // unchanged
    expect(draftAfter.aiDraftScore).toBe(draftBefore.aiDraftScore); // never silently recomputed
  });

  it("regenerating (calling the endpoint again) uses the latest saved guide, not the one the previous draft used", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regenerate-latest");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Original guide." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    mockMarkEssay.mockResolvedValue(VALID_RESULT);
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));

    await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: questionA.id }) });
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Updated guide." } });

    // Regenerate.
    await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: questionA.id }) });

    expect(mockMarkEssay).toHaveBeenCalledTimes(2);
    expect(mockMarkEssay.mock.calls[0][0].rubric[0].description).toBe("Original guide.");
    expect(mockMarkEssay.mock.calls[1][0].rubric[0].description).toBe("Updated guide.");

    const finalDraft = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    expect(JSON.parse(finalDraft.aiReasoning!).lecturerGuideText).toBe("Updated guide.");
  });

  it("blocks a non-owning lecturer", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("non-owner-single");
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    mockAuth.mockResolvedValue(sessionFor(otherLecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: questionA.id }) });
    expect(res.status).toBe(404);
    expect(mockMarkEssay).not.toHaveBeenCalled();
  });

  it("never finalizes or changes Submission.status/totalScore", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("no-finalize");
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    mockMarkEssay.mockResolvedValue(VALID_RESULT);
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: questionA.id }) });

    const stillSubmission = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stillSubmission.status).toBe("SUBMITTED");
    expect(stillSubmission.totalScore).toBeNull();
  });
});

describe("bulk 'Generate missing AI suggestions' — automatically reuses the question's saved guide, exam-wide, never overwrites an existing draft", () => {
  it("marks two students' answers to the same question with the same saved guide", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("bulk-shared-guide");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Bulk shared guide." } });
    await makeSubmission(exam.id, questionA.id, studentAId, "Student A.");
    await makeSubmission(exam.id, questionA.id, studentBId, "Student B.");
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await bulkMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eligible).toBe(2);
    expect(body.generated).toBe(2);
    expect(body.alreadySuggested).toBe(0);
    expect(body.failed).toBe(0);

    expect(mockMarkEssay).toHaveBeenCalledTimes(2);
    for (const call of mockMarkEssay.mock.calls) {
      expect(call[0].rubric[0].description).toBe("Bulk shared guide.");
    }
  });

  it("no guide configured falls back to the default rubric", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("bulk-no-guide");
    await makeSubmission(exam.id, questionA.id, studentAId);
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await bulkMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });

    expect(mockMarkEssay).toHaveBeenCalledWith(
      expect.objectContaining({
        rubric: [
          { criterion: "Content & accuracy", description: "Response demonstrates understanding and accuracy", maxMarks: 6 },
          { criterion: "Clarity & structure", description: "Response is well-organised and clearly expressed", maxMarks: 4 },
        ],
      }),
    );
  });

  it("still skips an essay answer that already has an AI draft — never overwrites it — and reports it clearly instead of silently omitting it", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("bulk-skips-existing");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "A guide." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } },
      data: { aiDraftScore: 7, aiReasoning: JSON.stringify({ ...VALID_RESULT, rubricSource: "LECTURER", rubric: [], lecturerGuideText: "Pre-existing" }), aiGradedAt: new Date() },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await bulkMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();
    // Never "0, 0" with no explanation — the pre-existing draft is
    // explicitly counted, not silently excluded from every number.
    expect(body.eligible).toBe(1);
    expect(body.generated).toBe(0);
    expect(body.alreadySuggested).toBe(1);
    expect(mockMarkEssay).not.toHaveBeenCalled();

    const unchanged = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    expect(unchanged.aiDraftScore).toBe(7);
    expect(JSON.parse(unchanged.aiReasoning!).lecturerGuideText).toBe("Pre-existing");
  });

  it("reports failed and requires LECTURER authorization", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("bulk-partial-failure");
    await makeSubmission(exam.id, questionA.id, studentAId, "Answer that fails.");
    mockMarkEssay.mockRejectedValue(new Error("Anthropic API request failed: timeout"));

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await bulkMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(body.generated).toBe(0);

    mockAuth.mockResolvedValue(sessionFor(studentAId, "STUDENT", institutionId));
    const studentRes = await bulkMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(studentRes.status).toBe(401);
  });
});

describe("bulk 'Regenerate AI suggestions' — deliberately overwrites every eligible essay answer's existing draft using the CURRENT saved guide", () => {
  it("replaces an existing AI draft (unlike the missing-only action) — this is the whole point of regeneration", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regen-replaces-existing");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "New guide added after the draft existed." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } },
      data: { aiDraftScore: 3, aiReasoning: JSON.stringify({ ...VALID_RESULT, rubricSource: "DEFAULT", rubric: [], lecturerGuideText: null }), aiGradedAt: new Date(0) },
    });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eligible).toBe(1);
    expect(body.regenerated).toBe(1);
    expect(mockMarkEssay).toHaveBeenCalledTimes(1);

    const updated = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    const stored = JSON.parse(updated.aiReasoning!);
    expect(stored.rubricSource).toBe("LECTURER");
    expect(stored.lecturerGuideText).toBe("New guide added after the draft existed.");
    // The stale timestamp is genuinely replaced, not preserved.
    expect(updated.aiGradedAt!.getTime()).toBeGreaterThan(0);
  });

  it("regenerated draft uses the LATEST Question.aiMarkingGuide, not whatever the stale draft used", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regen-latest-guide");
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } },
      data: { aiDraftScore: 3, aiReasoning: JSON.stringify({ ...VALID_RESULT, rubricSource: "LECTURER", rubric: [], lecturerGuideText: "Old guide, no longer current." }), aiGradedAt: new Date() },
    });
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Brand new current guide." } });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });

    expect(mockMarkEssay).toHaveBeenCalledWith(expect.objectContaining({ rubric: [{ criterion: "Lecturer marking guide", description: "Brand new current guide.", maxMarks: 10 }] }));
  });

  it("different questions use different guides during the same regeneration run", async () => {
    const { exam, questionA, questionB } = await makeExamWithTwoEssays("regen-distinct-guides");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Guide A." } });
    await prisma.question.update({ where: { id: questionB.id }, data: { aiMarkingGuide: "Guide B." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: questionB.id, response: "Answer B." } });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });

    const descriptions = mockMarkEssay.mock.calls.map((c) => c[0].rubric[0].description).sort();
    expect(descriptions).toEqual(["Guide A.", "Guide B."]);
  });

  it("no guide configured falls back to the default rubric, and reports the affected question count", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regen-no-guide");
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } },
      data: { aiDraftScore: 3, aiReasoning: JSON.stringify(VALID_RESULT), aiGradedAt: new Date() },
    });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();
    expect(body.defaultRubricQuestionCount).toBe(1);
    expect(mockMarkEssay).toHaveBeenCalledWith(
      expect.objectContaining({
        rubric: [
          { criterion: "Content & accuracy", description: "Response demonstrates understanding and accuracy", maxMarks: 6 },
          { criterion: "Clarity & structure", description: "Response is well-organised and clearly expressed", maxMarks: 4 },
        ],
      }),
    );
  });

  it("never touches the lecturer's manual score/feedback or the student's answer text, even on an eligible (still-SUBMITTED) answer", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regen-preserves-manual-score");
    const submission = await makeSubmission(exam.id, questionA.id, studentAId, "The student's original answer text.");
    // A lecturer who jotted down a manual score/feedback before also
    // requesting an AI opinion — the submission itself is still
    // SUBMITTED (eligible), so this exercises the real overwrite path,
    // not just "wasn't eligible anyway".
    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } },
      data: { score: 9, feedback: "Lecturer's own manual feedback." },
    });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();
    expect(body.regenerated).toBe(1); // confirms the answer WAS processed

    const answer = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    expect(answer.score).toBe(9);
    expect(answer.feedback).toBe("Lecturer's own manual feedback.");
    expect(answer.response).toBe("The student's original answer text.");
    expect(answer.aiDraftScore).toBe(VALID_RESULT.totalScore); // the AI field DID get written

    const stillSubmission = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stillSubmission.status).toBe("SUBMITTED");
    expect(stillSubmission.totalScore).toBeNull();
  });

  it("never finalizes a submission or changes Submission.status/totalScore, even when a manually-graded submission exists elsewhere in the exam", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regen-does-not-finalize");
    const eligibleSubmission = await makeSubmission(exam.id, questionA.id, studentAId);
    const gradedSubmission = await makeSubmission(exam.id, questionA.id, studentBId, "Already graded.");
    await prisma.submission.update({ where: { id: gradedSubmission.id }, data: { status: "GRADED", totalScore: 9, gradedAt: new Date() } });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });

    // The already-GRADED submission is untouched — not eligible, and
    // never finalized/mutated by this route regardless.
    const stillGraded = await prisma.submission.findUniqueOrThrow({ where: { id: gradedSubmission.id } });
    expect(stillGraded.status).toBe("GRADED");
    expect(stillGraded.totalScore).toBe(9);
    // The eligible one gets a fresh AI draft but is never finalized.
    const stillEligible = await prisma.submission.findUniqueOrThrow({ where: { id: eligibleSubmission.id } });
    expect(stillEligible.status).toBe("SUBMITTED");
    expect(stillEligible.totalScore).toBeNull();
  });

  it("never affects a non-ESSAY answer on the same submission", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regen-mcq-untouched");
    const mcq = await prisma.question.create({ data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "2+2=?", points: 1, options: ["3", "4"], correctAnswer: "4" } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: mcq.id, response: "4", score: 1, isCorrect: true } });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });

    const mcqAnswer = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: mcq.id } } });
    expect(mcqAnswer.aiDraftScore).toBeNull();
    expect(mcqAnswer.score).toBe(1);
    expect(mcqAnswer.response).toBe("4");
  });

  it("reports failed clearly on a partial regeneration failure, without aborting the rest of the batch", async () => {
    const { exam, questionA, questionB } = await makeExamWithTwoEssays("regen-partial-failure");
    const submission = await makeSubmission(exam.id, questionA.id, studentAId, "Answer A.");
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: questionB.id, response: "Answer B." } });
    mockMarkEssay.mockRejectedValueOnce(new Error("Anthropic API request failed: timeout")).mockResolvedValueOnce(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();
    expect(body.eligible).toBe(2);
    expect(body.regenerated).toBe(1);
    expect(body.failed).toBe(1);
  });

  it("requires LECTURER authorization for the owning exam", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regen-auth");
    await makeSubmission(exam.id, questionA.id, studentAId);

    mockAuth.mockResolvedValue(sessionFor(otherLecturerId, "LECTURER", institutionId));
    const otherLecturerRes = await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(otherLecturerRes.status).toBe(404);
    expect(mockMarkEssay).not.toHaveBeenCalled();

    mockAuth.mockResolvedValue(sessionFor(studentAId, "STUDENT", institutionId));
    const studentRes = await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(studentRes.status).toBe(401);
  });

  it("only regenerates because the lecturer explicitly called this dedicated route — the missing-only route never mutates the same existing snapshot", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("regen-vs-missing-only-contrast");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Current guide." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);
    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } },
      data: { aiDraftScore: 3, aiReasoning: JSON.stringify({ ...VALID_RESULT, rubricSource: "DEFAULT", rubric: [], lecturerGuideText: null }), aiGradedAt: new Date() },
    });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));

    // The missing-only action leaves the existing (now stale) snapshot untouched.
    await bulkMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const afterMissingOnly = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    expect(JSON.parse(afterMissingOnly.aiReasoning!).rubricSource).toBe("DEFAULT");

    // Only the explicit regenerate call replaces it.
    await regenerateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const afterRegenerate = await prisma.answer.findUniqueOrThrow({ where: { submissionId_questionId: { submissionId: submission.id, questionId: questionA.id } } });
    expect(JSON.parse(afterRegenerate.aiReasoning!).rubricSource).toBe("LECTURER");
  });
});

describe("student-facing endpoints never expose Question.aiMarkingGuide", () => {
  it("GET /api/exams/[id] never returns the guide to a student, in any attempt state", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("student-leak-exam-route");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Top secret marking guide." } });

    mockAuth.mockResolvedValue(sessionFor(studentAId, "STUDENT", institutionId));
    const res = await examRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: exam.id }) });
    const raw = await res.text();
    expect(raw).not.toMatch(/Top secret marking guide|aiMarkingGuide/);
  });

  it("GET /api/submissions/[id] never returns the guide to the student, even during their own IN_PROGRESS full-paper delivery", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("student-leak-submission-inprogress");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Top secret marking guide." } });

    mockAuth.mockResolvedValue(sessionFor(studentAId, "STUDENT", institutionId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();

    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const raw = await res.text();
    expect(raw).not.toMatch(/Top secret marking guide|aiMarkingGuide/);
  });

  it("the owning lecturer DOES see the guide via GET /api/submissions/[id] for the same submission", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("lecturer-sees-guide");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "Visible to lecturer only." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await submissionRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    const q = body.exam.questions.find((qq: { id: string }) => qq.id === questionA.id);
    expect(q.aiMarkingGuide).toBe("Visible to lecturer only.");
  });
});

describe("existing manual grading is unaffected by question-level marking guides", () => {
  it("PATCH /api/submissions/[id]/grade still saves scores/feedback normally for a question that has a saved guide", async () => {
    const { exam, questionA } = await makeExamWithTwoEssays("manual-grading-unaffected");
    await prisma.question.update({ where: { id: questionA.id }, data: { aiMarkingGuide: "A guide, irrelevant to manual grading." } });
    const submission = await makeSubmission(exam.id, questionA.id, studentAId);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await gradeRoute.PATCH(
      jsonRequest("PATCH", { answers: [{ questionId: questionA.id, score: 8, feedback: "Well done." }], finalize: true }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(200);
    const updated = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(updated.status).toBe("GRADED");
    expect(updated.totalScore).toBe(8);
  });
});
