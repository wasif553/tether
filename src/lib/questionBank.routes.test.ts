import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const banksRoute = await import("../app/api/lecturer/question-banks/route");
const bankRoute = await import("../app/api/lecturer/question-banks/[bankId]/route");
const questionsRoute = await import("../app/api/lecturer/question-banks/[bankId]/questions/route");
const questionRoute = await import(
  "../app/api/lecturer/question-banks/[bankId]/questions/[questionId]/route"
);
const importRoute = await import("../app/api/lecturer/exams/[examId]/import-bank-questions/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT") {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId } };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let lecturerA: { id: string };
let lecturerB: { id: string };
let student: { id: string };
let exam: { id: string };

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "QB Lecturer A", email: `qb-lect-a-${Date.now()}@test.local`, passwordHash, role: "LECTURER" },
  });
  lecturerB = await prisma.user.create({
    data: { name: "QB Lecturer B", email: `qb-lect-b-${Date.now()}@test.local`, passwordHash, role: "LECTURER" },
  });
  student = await prisma.user.create({
    data: { name: "QB Student", email: `qb-stud-${Date.now()}@test.local`, passwordHash, role: "STUDENT" },
  });
  exam = await prisma.exam.create({
    data: { title: "QB Test Exam", durationMins: 30, createdById: lecturerA.id },
  });
});

afterAll(async () => {
  await prisma.question.deleteMany({ where: { examId: exam.id } });
  await prisma.exam.deleteMany({ where: { id: exam.id } });
  await prisma.bankQuestion.deleteMany({ where: { bank: { lecturerId: { in: [lecturerA.id, lecturerB.id] } } } });
  await prisma.questionBank.deleteMany({ where: { lecturerId: { in: [lecturerA.id, lecturerB.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturerA.id, lecturerB.id, student.id] } } });
  await prisma.$disconnect();
});

describe("question bank CRUD", () => {
  it("1. creates a question bank successfully", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));

    const res = await banksRoute.POST(jsonRequest("POST", { title: "Biology 101" }));
    expect(res.status).toBe(201);
    const bank = await res.json();
    expect(bank.title).toBe("Biology 101");
    expect(bank.lecturerId).toBe(lecturerA.id);
  });

  it("2. rejects creating a bank with no title (400)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));

    const res = await banksRoute.POST(jsonRequest("POST", { title: "" }));
    expect(res.status).toBe(400);
  });

  it("12. blocks a student from listing question banks (401)", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await banksRoute.GET();
    expect(res.status).toBe(401);
  });
});

describe("bank question CRUD", () => {
  it("3. adds an MCQ bank question successfully", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));
    const bank = await prisma.questionBank.create({
      data: { title: "MCQ bank", lecturerId: lecturerA.id },
    });

    const res = await questionsRoute.POST(
      jsonRequest("POST", {
        type: "MULTIPLE_CHOICE",
        text: "2+2=?",
        optionsJson: JSON.stringify(["3", "4", "5"]),
        correctAnswer: "4",
        points: 2,
      }),
      { params: Promise.resolve({ bankId: bank.id }) },
    );

    expect(res.status).toBe(201);
    const question = await res.json();
    expect(question.text).toBe("2+2=?");
    expect(question.type).toBe("MULTIPLE_CHOICE");
  });

  it("4. rejects an MCQ bank question missing options (400)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));
    const bank = await prisma.questionBank.create({
      data: { title: "MCQ bank 2", lecturerId: lecturerA.id },
    });

    const res = await questionsRoute.POST(
      jsonRequest("POST", { type: "MULTIPLE_CHOICE", text: "2+2=?", correctAnswer: "4", points: 2 }),
      { params: Promise.resolve({ bankId: bank.id }) },
    );

    expect(res.status).toBe(400);
  });

  it("5. adds an essay bank question with no correctAnswer required", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));
    const bank = await prisma.questionBank.create({
      data: { title: "Essay bank", lecturerId: lecturerA.id },
    });

    const res = await questionsRoute.POST(
      jsonRequest("POST", { type: "ESSAY", text: "Discuss photosynthesis.", points: 5 }),
      { params: Promise.resolve({ bankId: bank.id }) },
    );

    expect(res.status).toBe(201);
    const question = await res.json();
    expect(question.correctAnswer).toBeNull();
  });

  it("6. updates a bank question successfully", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));
    const bank = await prisma.questionBank.create({
      data: { title: "Update bank", lecturerId: lecturerA.id },
    });
    const question = await prisma.bankQuestion.create({
      data: { bankId: bank.id, type: "ESSAY", text: "Original text", points: 1 },
    });

    const res = await questionRoute.PATCH(
      jsonRequest("PATCH", { text: "Updated text", points: 4 }),
      { params: Promise.resolve({ bankId: bank.id, questionId: question.id }) },
    );

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.text).toBe("Updated text");
    expect(updated.points).toBe(4);
  });

  it("7. deletes a bank question successfully", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));
    const bank = await prisma.questionBank.create({
      data: { title: "Delete bank", lecturerId: lecturerA.id },
    });
    const question = await prisma.bankQuestion.create({
      data: { bankId: bank.id, type: "ESSAY", text: "To delete", points: 1 },
    });

    const res = await questionRoute.DELETE(jsonRequest("DELETE"), {
      params: Promise.resolve({ bankId: bank.id, questionId: question.id }),
    });
    expect(res.status).toBe(204);

    const stillThere = await prisma.bankQuestion.findUnique({ where: { id: question.id } });
    expect(stillThere).toBeNull();
  });

  it("8. another lecturer gets 404 reading the first lecturer's bank", async () => {
    const bank = await prisma.questionBank.create({
      data: { title: "Private bank", lecturerId: lecturerA.id },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER"));
    const res = await bankRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ bankId: bank.id }) });
    expect(res.status).toBe(404);
  });
});

describe("import into exam", () => {
  it("9 & 10. imports selected bank questions, copying their content", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));
    const bank = await prisma.questionBank.create({
      data: { title: "Import bank", lecturerId: lecturerA.id },
    });
    const bq1 = await prisma.bankQuestion.create({
      data: {
        bankId: bank.id,
        type: "MULTIPLE_CHOICE",
        text: "Capital of France?",
        optionsJson: JSON.stringify(["Paris", "London", "Rome"]),
        correctAnswer: "Paris",
        points: 3,
      },
    });
    const bq2 = await prisma.bankQuestion.create({
      data: { bankId: bank.id, type: "ESSAY", text: "Explain gravity.", points: 5 },
    });

    const res = await importRoute.POST(
      jsonRequest("POST", { bankQuestionIds: [bq1.id, bq2.id] }),
      { params: Promise.resolve({ examId: exam.id }) },
    );

    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.imported).toBe(2);

    const createdQuestions = await prisma.question.findMany({
      where: { examId: exam.id, text: { in: [bq1.text, bq2.text] } },
    });
    expect(createdQuestions).toHaveLength(2);
    const mcq = createdQuestions.find((q) => q.type === "MULTIPLE_CHOICE");
    expect(mcq?.text).toBe(bq1.text);
    expect(mcq?.correctAnswer).toBe("Paris");
    expect(mcq?.options).toEqual(["Paris", "London", "Rome"]);
  });

  it("11. imported questions are independent — editing the BankQuestion afterward leaves the Question unchanged", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));
    const bank = await prisma.questionBank.create({
      data: { title: "Independence bank", lecturerId: lecturerA.id },
    });
    const bq = await prisma.bankQuestion.create({
      data: { bankId: bank.id, type: "SHORT_ANSWER", text: "Before edit", correctAnswer: "original", points: 1 },
    });

    await importRoute.POST(jsonRequest("POST", { bankQuestionIds: [bq.id] }), {
      params: Promise.resolve({ examId: exam.id }),
    });

    const importedQuestion = await prisma.question.findFirst({ where: { examId: exam.id, text: "Before edit" } });
    expect(importedQuestion).not.toBeNull();

    await prisma.bankQuestion.update({
      where: { id: bq.id },
      data: { text: "After edit", correctAnswer: "changed" },
    });

    const unchangedQuestion = await prisma.question.findUnique({ where: { id: importedQuestion!.id } });
    expect(unchangedQuestion?.text).toBe("Before edit");
    expect(unchangedQuestion?.correctAnswer).toBe("original");
  });

  it("13. rejects importing another lecturer's bank questions (403)", async () => {
    const bankB = await prisma.questionBank.create({
      data: { title: "Lecturer B's bank", lecturerId: lecturerB.id },
    });
    const bqB = await prisma.bankQuestion.create({
      data: { bankId: bankB.id, type: "ESSAY", text: "Not yours", points: 1 },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER"));
    const res = await importRoute.POST(jsonRequest("POST", { bankQuestionIds: [bqB.id] }), {
      params: Promise.resolve({ examId: exam.id }),
    });

    expect(res.status).toBe(403);
  });
});
