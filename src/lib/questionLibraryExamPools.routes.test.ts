/**
 * Question Bank / Exam Pools redesign v1 — see
 * docs/question-bank-exam-pools-v1.md.
 *
 * Covers the NEW surface added by this feature: the Bank -> Exam copy
 * route with delivery choice + duplicate detection (from-bank), the
 * Exam -> Bank reverse copy route (save-to-bank), pool population via
 * both required-question reassignment and bank copies, and cross-
 * lecturer/institution authorization on the new routes.
 *
 * Pre-existing coverage NOT duplicated here: plain bank CRUD and the
 * legacy import-bank-questions route (questionBank.routes.test.ts);
 * pure delivery/draw-count logic (questionDelivery.test.ts); provenance
 * stamping in mapBankQuestionToQuestionData (questionBank.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");

const fromBankRoute = await import("../app/api/lecturer/exams/[examId]/questions/from-bank/route");
const saveToBankRoute = await import(
  "../app/api/lecturer/exams/[examId]/questions/[questionId]/save-to-bank/route"
);
const questionRoute = await import("../app/api/exams/[id]/questions/[questionId]/route");
const poolsRoute = await import("../app/api/exams/[id]/question-pools/route");
const poolRoute = await import("../app/api/exams/[id]/question-pools/[poolId]/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const stamp = Date.now();
let instA: string;
let instB: string;
let lecturerA: { id: string };
let lecturerB: { id: string };
let student: { id: string };

const examIds: string[] = [];
const bankIds: string[] = [];
const userIds: string[] = [];

async function makeExam(lecturerId: string) {
  const exam = await prisma.exam.create({
    data: { title: `QLEP Exam ${examIds.length}`, durationMins: 30, createdById: lecturerId, institutionId: instA },
  });
  examIds.push(exam.id);
  return exam;
}

async function makeBank(lecturerId: string) {
  const bank = await prisma.questionBank.create({ data: { title: `QLEP Bank ${bankIds.length}`, lecturerId } });
  bankIds.push(bank.id);
  return bank;
}

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`qlep-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`qlep-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "QLEP Lecturer A", email: `qlep-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "QLEP Lecturer B", email: `qlep-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  student = await prisma.user.create({
    data: { name: "QLEP Student", email: `qlep-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  userIds.push(lecturerA.id, lecturerB.id, student.id);
});

afterAll(async () => {
  await prisma.question.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.questionPool.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  await prisma.bankQuestion.deleteMany({ where: { bankId: { in: bankIds } } });
  await prisma.questionBank.deleteMany({ where: { id: { in: bankIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("from-bank: required-question delivery", () => {
  it("copies selected bank questions as required (no pool) and independent of the source", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);
    const bq = await prisma.bankQuestion.create({
      data: { bankId: bank.id, type: "SHORT_ANSWER", text: "Required Q", correctAnswer: "orig", points: 2 },
    });

    const res = await fromBankRoute.POST(
      jsonRequest("POST", { bankId: bank.id, bankQuestionIds: [bq.id], delivery: { kind: "REQUIRED" } }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.poolId).toBeNull();

    const created = await prisma.question.findFirst({ where: { examId: exam.id, text: "Required Q" } });
    expect(created).not.toBeNull();
    expect(created?.questionPoolId).toBeNull();
    expect(created?.source).toBe("QUESTION_BANK");
    expect(created?.sourceBankQuestionId).toBe(bq.id);

    // Independence: editing the bank question afterward never touches the copy.
    await prisma.bankQuestion.update({ where: { id: bq.id }, data: { text: "Edited", correctAnswer: "changed" } });
    const unchanged = await prisma.question.findUnique({ where: { id: created!.id } });
    expect(unchanged?.text).toBe("Required Q");
    expect(unchanged?.correctAnswer).toBe("orig");
  });

  it("copies multiple bank questions in one call", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);
    const bq1 = await prisma.bankQuestion.create({ data: { bankId: bank.id, type: "ESSAY", text: "Multi 1", points: 1 } });
    const bq2 = await prisma.bankQuestion.create({ data: { bankId: bank.id, type: "ESSAY", text: "Multi 2", points: 1 } });

    const res = await fromBankRoute.POST(
      jsonRequest("POST", { bankId: bank.id, bankQuestionIds: [bq1.id, bq2.id], delivery: { kind: "REQUIRED" } }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(2);
  });

  it("does not re-copy a bank question already added to this exam (duplicate protection)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);
    const bq = await prisma.bankQuestion.create({ data: { bankId: bank.id, type: "ESSAY", text: "Dup Q", points: 1 } });

    const first = await fromBankRoute.POST(
      jsonRequest("POST", { bankId: bank.id, bankQuestionIds: [bq.id], delivery: { kind: "REQUIRED" } }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect((await first.json()).created).toBe(1);

    const second = await fromBankRoute.POST(
      jsonRequest("POST", { bankId: bank.id, bankQuestionIds: [bq.id], delivery: { kind: "REQUIRED" } }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    const secondBody = await second.json();
    expect(secondBody.created).toBe(0);
    expect(secondBody.skippedAsDuplicate).toEqual([bq.id]);

    const count = await prisma.question.count({ where: { examId: exam.id, sourceBankQuestionId: bq.id } });
    expect(count).toBe(1);
  });
});

describe("from-bank: pool delivery", () => {
  it("adds copies to an existing pool", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);
    const bq = await prisma.bankQuestion.create({ data: { bankId: bank.id, type: "ESSAY", text: "Pooled Q", points: 1 } });

    const poolRes = await poolsRoute.POST(jsonRequest("POST", { name: "Existing pool" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    const pool = await poolRes.json();

    const res = await fromBankRoute.POST(
      jsonRequest("POST", {
        bankId: bank.id,
        bankQuestionIds: [bq.id],
        delivery: { kind: "EXISTING_POOL", poolId: pool.id },
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.poolId).toBe(pool.id);

    const created = await prisma.question.findFirst({ where: { examId: exam.id, text: "Pooled Q" } });
    expect(created?.questionPoolId).toBe(pool.id);
  });

  it("creates a new pool inline and assigns the copies to it", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);
    const bq = await prisma.bankQuestion.create({ data: { bankId: bank.id, type: "ESSAY", text: "New pool Q", points: 1 } });

    const res = await fromBankRoute.POST(
      jsonRequest("POST", {
        bankId: bank.id,
        bankQuestionIds: [bq.id],
        delivery: { kind: "NEW_POOL", name: "Brand new pool", drawCount: 1 },
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    const body = await res.json();
    expect(body.created).toBe(1);
    expect(body.poolId).not.toBeNull();

    const pool = await prisma.questionPool.findUnique({ where: { id: body.poolId } });
    expect(pool?.name).toBe("Brand new pool");
    expect(pool?.drawCount).toBe(1);
  });

  it("worked example: required + pool selections combine correctly (Part 15)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);
    const required = await Promise.all(
      [1, 2, 3].map((n) => prisma.bankQuestion.create({ data: { bankId: bank.id, type: "ESSAY", text: `Req ${n}`, points: 1 } })),
    );
    const pooled = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        prisma.bankQuestion.create({ data: { bankId: bank.id, type: "ESSAY", text: `Pool ${i}`, points: 1 } }),
      ),
    );

    await fromBankRoute.POST(
      jsonRequest("POST", {
        bankId: bank.id,
        bankQuestionIds: required.map((q) => q.id),
        delivery: { kind: "REQUIRED" },
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    const poolRes = await fromBankRoute.POST(
      jsonRequest("POST", {
        bankId: bank.id,
        bankQuestionIds: pooled.map((q) => q.id),
        delivery: { kind: "NEW_POOL", name: "Random pool", drawCount: 2 },
      }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    const poolId = (await poolRes.json()).poolId;

    const requiredCount = await prisma.question.count({ where: { examId: exam.id, questionPoolId: null } });
    const pooledCount = await prisma.question.count({ where: { examId: exam.id, questionPoolId: poolId } });
    expect(requiredCount).toBe(3);
    expect(pooledCount).toBe(5);
  });
});

describe("save-to-bank: exam question -> new bank copy", () => {
  it("creates an independent BankQuestion snapshot of an exam question", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "SHORT_ANSWER", text: "Save me", correctAnswer: "orig", points: 3, order: 0, source: "MANUAL" },
    });

    const res = await saveToBankRoute.POST(jsonRequest("POST", { bankId: bank.id }), {
      params: Promise.resolve({ examId: exam.id, questionId: question.id }),
    });
    expect(res.status).toBe(201);
    const bankQuestion = await res.json();
    expect(bankQuestion.text).toBe("Save me");
    expect(bankQuestion.bankId).toBe(bank.id);

    // Independence both directions.
    await prisma.question.update({ where: { id: question.id }, data: { text: "Changed in exam" } });
    const bankCopyAfter = await prisma.bankQuestion.findUnique({ where: { id: bankQuestion.id } });
    expect(bankCopyAfter?.text).toBe("Save me");

    await prisma.bankQuestion.update({ where: { id: bankQuestion.id }, data: { text: "Changed in bank" } });
    const examQuestionAfter = await prisma.question.findUnique({ where: { id: question.id } });
    expect(examQuestionAfter?.text).toBe("Changed in exam");
  });

  it("rejects saving another lecturer's exam question (404)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const examA = await makeExam(lecturerA.id);
    const bankA = await makeBank(lecturerA.id);
    const question = await prisma.question.create({
      data: { examId: examA.id, type: "ESSAY", text: "Owned by A", points: 1, order: 0 },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await saveToBankRoute.POST(jsonRequest("POST", { bankId: bankA.id }), {
      params: Promise.resolve({ examId: examA.id, questionId: question.id }),
    });
    expect(res.status).toBe(404);
  });
});

describe("pool population via required <-> pool reassignment (Part 12/14)", () => {
  it("moves a required exam question into a pool, then back to required", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "ESSAY", text: "Movable", points: 1, order: 0, source: "MANUAL" },
    });
    const poolRes = await poolsRoute.POST(jsonRequest("POST", { name: "Movable pool" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    const pool = await poolRes.json();

    const toPool = await questionRoute.PATCH(jsonRequest("PATCH", { questionPoolId: pool.id }), {
      params: Promise.resolve({ id: exam.id, questionId: question.id }),
    });
    expect(toPool.status).toBe(200);
    expect((await toPool.json()).questionPoolId).toBe(pool.id);

    const backToRequired = await questionRoute.PATCH(jsonRequest("PATCH", { questionPoolId: null }), {
      params: Promise.resolve({ id: exam.id, questionId: question.id }),
    });
    expect(backToRequired.status).toBe(200);
    expect((await backToRequired.json()).questionPoolId).toBeNull();
  });

  it("rejects assigning a question to a pool belonging to a different exam", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const examA = await makeExam(lecturerA.id);
    const examC = await makeExam(lecturerA.id);
    const question = await prisma.question.create({
      data: { examId: examA.id, type: "ESSAY", text: "Cross-exam", points: 1, order: 0 },
    });
    const foreignPoolRes = await poolsRoute.POST(jsonRequest("POST", { name: "Foreign pool" }), {
      params: Promise.resolve({ id: examC.id }),
    });
    const foreignPool = await foreignPoolRes.json();

    const res = await questionRoute.PATCH(jsonRequest("PATCH", { questionPoolId: foreignPool.id }), {
      params: Promise.resolve({ id: examA.id, questionId: question.id }),
    });
    expect(res.status).toBe(400);
  });

  it("deleting a pool un-pools its questions rather than deleting them", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const poolRes = await poolsRoute.POST(jsonRequest("POST", { name: "To delete" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    const pool = await poolRes.json();
    const question = await prisma.question.create({
      data: { examId: exam.id, type: "ESSAY", text: "In deleted pool", points: 1, order: 0, questionPoolId: pool.id },
    });

    const res = await poolRoute.DELETE(jsonRequest("DELETE"), {
      params: Promise.resolve({ id: exam.id, poolId: pool.id }),
    });
    expect(res.status).toBe(200);

    const stillExists = await prisma.question.findUnique({ where: { id: question.id } });
    expect(stillExists).not.toBeNull();
    expect(stillExists?.questionPoolId).toBeNull();
  });
});

describe("drawCount validation (Part 18)", () => {
  it("rejects a non-positive drawCount on pool creation", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const res = await poolsRoute.POST(jsonRequest("POST", { name: "Bad draw count", drawCount: 0 }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(400);
  });

  it("allows a drawCount greater than the pool's current size (no error; all available are used at delivery)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const poolRes = await poolsRoute.POST(jsonRequest("POST", { name: "Small pool", drawCount: 10 }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(poolRes.status).toBe(201);
    const pool = await poolRes.json();
    expect(pool.drawCount).toBe(10);
    expect(pool.questionCount).toBe(0);
  });

  it("updates an existing pool's drawCount", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const poolRes = await poolsRoute.POST(jsonRequest("POST", { name: "Adjustable" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    const pool = await poolRes.json();

    const res = await poolRoute.PATCH(jsonRequest("PATCH", { drawCount: 4 }), {
      params: Promise.resolve({ id: exam.id, poolId: pool.id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).drawCount).toBe(4);
  });
});

describe("authorization (Part 21)", () => {
  it("rejects from-bank when the exam belongs to another lecturer (404)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const examA = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);
    const bq = await prisma.bankQuestion.create({ data: { bankId: bank.id, type: "ESSAY", text: "Cross-lecturer", points: 1 } });

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await fromBankRoute.POST(
      jsonRequest("POST", { bankId: bank.id, bankQuestionIds: [bq.id], delivery: { kind: "REQUIRED" } }),
      { params: Promise.resolve({ examId: examA.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("rejects from-bank when the bank belongs to another lecturer, even on the caller's own exam (404)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const examB = await makeExam(lecturerB.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const bankA = await makeBank(lecturerA.id);
    const bq = await prisma.bankQuestion.create({ data: { bankId: bankA.id, type: "ESSAY", text: "Not B's bank", points: 1 } });

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await fromBankRoute.POST(
      jsonRequest("POST", { bankId: bankA.id, bankQuestionIds: [bq.id], delivery: { kind: "REQUIRED" } }),
      { params: Promise.resolve({ examId: examB.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("blocks a student from calling from-bank (401)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const exam = await makeExam(lecturerA.id);
    const bank = await makeBank(lecturerA.id);

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instA));
    const res = await fromBankRoute.POST(
      jsonRequest("POST", { bankId: bank.id, bankQuestionIds: ["irrelevant"], delivery: { kind: "REQUIRED" } }),
      { params: Promise.resolve({ examId: exam.id }) },
    );
    expect(res.status).toBe(401);
  });

  it("rejects save-to-bank into another lecturer's bank (403 or 404)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const examA = await makeExam(lecturerA.id);
    const question = await prisma.question.create({
      data: { examId: examA.id, type: "ESSAY", text: "Owner A question", points: 1, order: 0 },
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const bankB = await makeBank(lecturerB.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await saveToBankRoute.POST(jsonRequest("POST", { bankId: bankB.id }), {
      params: Promise.resolve({ examId: examA.id, questionId: question.id }),
    });
    expect([403, 404]).toContain(res.status);
  });
});
