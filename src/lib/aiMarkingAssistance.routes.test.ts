/**
 * AI Marking Assistance v1 — see docs/ai-marking-assistance-v1.md.
 *
 * DB-backed route tests for the new single-answer endpoint
 * (POST /api/lecturer/submissions/[id]/answers/[questionId]/ai-mark) and a
 * regression pass proving the existing exam-wide bulk endpoint
 * (POST /api/lecturer/exams/[examId]/ai-mark-essays) is unaffected by
 * sharing buildDefaultRubric() and the enriched aiReasoning record shape.
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
let studentId: string;
const cleanupExamIds: string[] = [];
const cleanupUserIds: string[] = [];

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`ai-marking-${stamp}`);
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
  const student = await prisma.user.create({
    data: { name: "AI Marking Student", email: `ai-mark-stud-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
  });
  studentId = student.id;
  cleanupUserIds.push(lecturerId, otherLecturerId, studentId);
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterAll(async () => {
  await prisma.answer.deleteMany({ where: { submission: { studentId } } });
  await prisma.submission.deleteMany({ where: { studentId } });
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

async function makeExamWithEssay(tag: string) {
  const exam = await prisma.exam.create({
    data: { title: `AI Marking Exam ${tag} ${stamp}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerId, institutionId },
  });
  cleanupExamIds.push(exam.id);
  const question = await prisma.question.create({
    data: { examId: exam.id, type: "ESSAY", text: "Explain photosynthesis.", points: 10, order: 0 },
  });
  const mcq = await prisma.question.create({
    data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "2+2=?", points: 1, order: 1, options: ["3", "4"], correctAnswer: "4" },
  });
  return { exam, question, mcq };
}

async function makeSubmission(
  examId: string,
  questionId: string,
  status: "IN_PROGRESS" | "SUBMITTED" | "GRADED",
  response: string | null = "Photosynthesis converts light into chemical energy.",
) {
  const submission = await prisma.submission.create({
    data: { examId, studentId, status, submittedAt: status === "IN_PROGRESS" ? null : new Date() },
  });
  if (response !== null) {
    await prisma.answer.create({ data: { submissionId: submission.id, questionId, response } });
  }
  return submission;
}

describe("POST /api/lecturer/submissions/[id]/answers/[questionId]/ai-mark — single-answer AI marking", () => {
  it("marks only the requested answer — a sibling MCQ answer on the same submission is untouched", async () => {
    const { exam, question, mcq } = await makeExamWithEssay("single");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED");
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: mcq.id, response: "4" } });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: question.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aiDraftScore).toBe(5);
    expect(body.questionId).toBe(question.id);

    const updated = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: question.id } } });
    expect(updated?.aiDraftScore).toBe(5);
    expect(updated?.aiGradedAt).not.toBeNull();

    const mcqAnswer = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: mcq.id } } });
    expect(mcqAnswer?.aiDraftScore).toBeNull();

    expect(mockMarkEssay).toHaveBeenCalledTimes(1);
  });

  it("uses the default rubric when no lecturer guide is supplied, and stores rubricSource DEFAULT", async () => {
    const { exam, question } = await makeExamWithEssay("default-rubric");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED");
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: question.id }) });
    expect(res.status).toBe(200);

    expect(mockMarkEssay).toHaveBeenCalledWith(
      expect.objectContaining({
        rubric: [
          { criterion: "Content & accuracy", description: "Response demonstrates understanding and accuracy", maxMarks: 6 },
          { criterion: "Clarity & structure", description: "Response is well-organised and clearly expressed", maxMarks: 4 },
        ],
      }),
    );

    const updated = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: question.id } } });
    const stored = JSON.parse(updated!.aiReasoning!);
    expect(stored.rubricSource).toBe("DEFAULT");
    expect(stored.lecturerGuideText).toBeNull();
  });

  it("uses the lecturer's marking guide as a single criterion capped at the question's points, and stores rubricSource LECTURER + the guide text", async () => {
    const { exam, question } = await makeExamWithEssay("lecturer-guide");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED");
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST", { lecturerGuide: "Award full marks only if chlorophyll is mentioned." }), {
      params: Promise.resolve({ id: submission.id, questionId: question.id }),
    });
    expect(res.status).toBe(200);

    expect(mockMarkEssay).toHaveBeenCalledWith(
      expect.objectContaining({
        rubric: [{ criterion: "Lecturer marking guide", description: "Award full marks only if chlorophyll is mentioned.", maxMarks: 10 }],
      }),
    );

    const updated = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: question.id } } });
    const stored = JSON.parse(updated!.aiReasoning!);
    expect(stored.rubricSource).toBe("LECTURER");
    expect(stored.lecturerGuideText).toBe("Award full marks only if chlorophyll is mentioned.");
  });

  it("blocks a non-owning lecturer", async () => {
    const { exam, question } = await makeExamWithEssay("non-owner");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED");
    mockAuth.mockResolvedValue(sessionFor(otherLecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: question.id }) });
    expect(res.status).toBe(404);
    expect(mockMarkEssay).not.toHaveBeenCalled();
  });

  it("blocks a student", async () => {
    const { exam, question } = await makeExamWithEssay("student-block");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED");
    mockAuth.mockResolvedValue(sessionFor(studentId, "STUDENT", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: question.id }) });
    expect(res.status).toBe(401);
    expect(mockMarkEssay).not.toHaveBeenCalled();
  });

  it("rejects a non-ESSAY question (MULTIPLE_CHOICE) — AI marking assistance is essay-only in this pass", async () => {
    const { exam, mcq } = await makeExamWithEssay("mcq-block");
    const submission = await makeSubmission(exam.id, mcq.id, "SUBMITTED", "4");
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: mcq.id }) });
    expect(res.status).toBe(400);
    expect(mockMarkEssay).not.toHaveBeenCalled();
  });

  it("rejects a submission that is still IN_PROGRESS — never marks a moving target", async () => {
    const { exam, question } = await makeExamWithEssay("in-progress-block");
    const submission = await makeSubmission(exam.id, question.id, "IN_PROGRESS");
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: question.id }) });
    expect(res.status).toBe(409);
    expect(mockMarkEssay).not.toHaveBeenCalled();
  });

  it("rejects when the essay has no student answer to mark", async () => {
    const { exam, question } = await makeExamWithEssay("no-answer");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: question.id }) });
    expect(res.status).toBe(400);
    expect(mockMarkEssay).not.toHaveBeenCalled();
  });

  it("never finalizes or changes Submission.status/totalScore — only the Answer draft fields", async () => {
    const { exam, question } = await makeExamWithEssay("no-finalize");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED");
    mockMarkEssay.mockResolvedValue(VALID_RESULT);
    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    await aiMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id, questionId: question.id }) });

    const stillSubmission = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stillSubmission.status).toBe("SUBMITTED");
    expect(stillSubmission.totalScore).toBeNull();
  });
});

describe("bulk 'Mark essays with AI' regression — unaffected by the new single-answer endpoint", () => {
  it("still marks every eligible essay exam-wide, still skips a non-essay answer, and now also stores the same enriched rubricSource metadata", async () => {
    const { exam, question, mcq } = await makeExamWithEssay("bulk-unaffected");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED");
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: mcq.id, response: "4" } });
    mockMarkEssay.mockResolvedValue(VALID_RESULT);

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await bulkMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.marked).toBe(1);
    expect(body.skipped).toBe(0);

    const updated = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: question.id } } });
    const stored = JSON.parse(updated!.aiReasoning!);
    expect(stored.rubricSource).toBe("DEFAULT");
    expect(stored.lecturerGuideText).toBeNull();

    const mcqAnswer = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: mcq.id } } });
    expect(mcqAnswer?.aiDraftScore).toBeNull(); // MCQ never touched by essay marking
  });

  it("skips an essay answer that already has an AI draft (e.g. from the single-answer endpoint) — never overwrites an existing draft", async () => {
    const { exam, question } = await makeExamWithEssay("bulk-skips-existing-draft");
    const submission = await makeSubmission(exam.id, question.id, "SUBMITTED");
    await prisma.answer.update({
      where: { submissionId_questionId: { submissionId: submission.id, questionId: question.id } },
      data: {
        aiDraftScore: 7,
        aiReasoning: JSON.stringify({ ...VALID_RESULT, rubricSource: "LECTURER", rubric: [], lecturerGuideText: "Pre-existing guide" }),
        aiGradedAt: new Date(),
      },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerId, "LECTURER", institutionId));
    const res = await bulkMarkRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();
    expect(body.marked).toBe(0);
    expect(mockMarkEssay).not.toHaveBeenCalled();

    const stillThere = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: question.id } } });
    expect(stillThere?.aiDraftScore).toBe(7);
  });
});
