/**
 * AI question-generation schema follow-up — DB-backed route tests. See
 * src/lib/ai/questionGenerator.ts's own doc comments and
 * src/lib/ai/questionGenerator.test.ts for the focused, non-DB coverage
 * of normalization/repair/allocation. These tests cover what that file
 * cannot: the route's own translation of a generateQuestions() result
 * into an HTTP response — in particular, that a lecturer is NEVER shown
 * a raw Zod validation dump (the exact production report: "MCQ
 * correctAnswer must be one of ..." / "Invalid input: expected array,
 * received null"), and that a partial success is reported clearly
 * instead of silently discarded or treated as an all-or-nothing failure.
 *
 * Mocks @/lib/ai/questionGenerator's generateQuestions (never the
 * Anthropic SDK directly here — that's already covered by
 * questionGenerator.test.ts) so these tests exercise ownership/response-
 * shaping against a real database, never a live model.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { mockGenerateQuestions } = vi.hoisted(() => ({ mockGenerateQuestions: vi.fn() }));
vi.mock("@/lib/ai/questionGenerator", async () => {
  const actual = await vi.importActual<typeof import("./ai/questionGenerator")>("./ai/questionGenerator");
  return { ...actual, generateQuestions: mockGenerateQuestions };
});

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const generateRoute = await import("../app/api/lecturer/exams/[examId]/generate-questions/route");

function sessionFor(userId: string, institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role: "LECTURER" as const, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function jsonRequest(body: unknown) {
  return new Request("http://test.local/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };
let instA: string;
let lecturerA: { id: string };

beforeEach(() => {
  mockGenerateQuestions.mockReset();
});

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`ai-qgen-a-${stamp}`);
  instA = a.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "QGen Lecturer A", email: `qgen-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id);
});

afterAll(async () => {
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExam() {
  const exam = await prisma.exam.create({
    data: {
      title: `QGen Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: false,
      createdById: lecturerA.id,
      institutionId: instA,
    },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

const baseRequestBody = {
  sourceMaterial: "Python fundamentals: variables, loops, functions, classes.",
  subject: "Python programming",
  totalCount: 20,
  difficulty: { easy: 25, medium: 40, hard: 35 },
  types: ["MCQ"],
};

const validMcq = {
  type: "MCQ",
  body: "Which keyword defines a function in Python?",
  options: ["class", "def", "func", "lambda"],
  correctAnswer: "B",
  difficulty: "easy",
  explanation: "def declares a function.",
};

describe("a fully successful generation returns the questions with no warning", () => {
  it("200, questions present, warning is null", async () => {
    mockGenerateQuestions.mockResolvedValueOnce({
      questions: Array.from({ length: 20 }, () => ({ ...validMcq })),
      requestedCount: 20,
      producedCount: 20,
      failedCount: 0,
    });
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, instA));

    const res = await generateRoute.POST(jsonRequest(baseRequestBody), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.questions).toHaveLength(20);
    expect(body.requestedCount).toBe(20);
    expect(body.producedCount).toBe(20);
    expect(body.warning).toBeNull();
  });
});

describe("Part 7 — a partial success is reported clearly, never silently discarded and never an all-or-nothing failure", () => {
  it("18 of 20 valid — 200, questions present (only the valid 18), a clear plain-English warning, never a Zod-shaped message", async () => {
    mockGenerateQuestions.mockResolvedValueOnce({
      questions: Array.from({ length: 18 }, () => ({ ...validMcq })),
      requestedCount: 20,
      producedCount: 18,
      failedCount: 2,
    });
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, instA));

    const res = await generateRoute.POST(jsonRequest(baseRequestBody), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.questions).toHaveLength(18);
    expect(body.warning).toBe("18 of 20 questions were generated successfully. 2 could not be validated.");
    // Never a raw Zod-style message anywhere in the response.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/invalid input/i);
    expect(raw).not.toMatch(/expected array/i);
    expect(raw).not.toContain("correctAnswer must be one of");
  });
});

describe("Part 8 — a total failure (0 valid after normalization + the one bounded repair attempt) is a clean, non-technical error, never a raw schema dump", () => {
  it("502 with a plain message; no Zod issue text, path, or code anywhere in the response", async () => {
    mockGenerateQuestions.mockResolvedValueOnce({
      questions: [],
      requestedCount: 20,
      producedCount: 0,
      failedCount: 20,
    });
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, instA));

    const res = await generateRoute.POST(jsonRequest(baseRequestBody), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toMatch(/invalid input/i);
    expect(body.error).not.toMatch(/expected array/i);
    expect(body.error).not.toContain("correctAnswer must be one of");
    expect(body.error).not.toContain("ZodError");
    expect(body.error).not.toMatch(/"path":|"code":/);
  });

  it("a thrown AIGenerationError (e.g. a genuine transport failure) is also translated to a clean message, never its own raw internal text on Production", async () => {
    const { AIGenerationError } = await import("./ai/questionGenerator");
    mockGenerateQuestions.mockRejectedValueOnce(new AIGenerationError("Anthropic API request failed: socket hang up"));
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, instA));

    const res = await generateRoute.POST(jsonRequest(baseRequestBody), { params: Promise.resolve({ examId: exam.id }) });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe("Tether could not generate questions right now. Please try again.");
  });
});

describe("ownership — a lecturer cannot generate questions for an exam they do not own", () => {
  it("returns 404, never reaching generateQuestions at all", async () => {
    const otherLecturer = await prisma.user.create({
      data: { name: "QGen Other Lecturer", email: `qgen-other-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "LECTURER", institutionId: instA },
    });
    cleanup.users.push(otherLecturer.id);
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, instA));

    const res = await generateRoute.POST(jsonRequest(baseRequestBody), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(404);
    expect(mockGenerateQuestions).not.toHaveBeenCalled();
  });
});
