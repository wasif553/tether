import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const inviteStudentRoute = await import("../app/api/platform/institutions/[id]/invite-student/route");
const examRoute = await import("../app/api/exams/[id]/route");
const availableRoute = await import("../app/api/exams/available/route");
const startRoute = await import("../app/api/exams/[id]/start/route");

function sessionFor(
  userId: string,
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN",
  institutionId: string | null,
) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let instA: { id: string };
let instB: { id: string };
let lecturerA: { id: string };
let studentA: { id: string };
let studentB: { id: string };
let platformAdmin: { id: string };
const createdUserIds: string[] = [];
const createdExamIds: string[] = [];

beforeAll(async () => {
  instA = await getOrCreateTestInstitution("student-access-routes-a");
  instB = await getOrCreateTestInstitution("student-access-routes-b");
  const passwordHash = await bcrypt.hash("test-password", 4);
  const stamp = Date.now();

  lecturerA = await prisma.user.create({
    data: { name: "SA Lecturer A", email: `sa-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA.id },
  });
  studentA = await prisma.user.create({
    data: { name: "SA Student A", email: `sa-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA.id },
  });
  studentB = await prisma.user.create({
    data: { name: "SA Student B", email: `sa-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instB.id },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "SA Platform Admin", email: `sa-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: instA.id },
  });
  createdUserIds.push(lecturerA.id, studentA.id, studentB.id, platformAdmin.id);
});

afterAll(async () => {
  await prisma.submission.deleteMany({ where: { studentId: { in: createdUserIds } } });
  await prisma.platformAuditLog.deleteMany({ where: { actorId: platformAdmin.id } });
  await prisma.exam.deleteMany({ where: { id: { in: createdExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("1-7. POST /api/platform/institutions/[id]/invite-student", () => {
  it("rejects an unauthenticated request", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "X", email: "x@example.edu", password: "temporary-password" }),
      { params: Promise.resolve({ id: instA.id }) },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a normal lecturer", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "X", email: "x@example.edu", password: "temporary-password" }),
      { params: Promise.resolve({ id: instA.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("PLATFORM_ADMIN can invite a student into the selected institution", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const stamp = Date.now();
    const email = `invited-student-${stamp}@example.edu`;
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "Invited Student", email, password: "temporary-password" }),
      { params: Promise.resolve({ id: instA.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.role).toBe("STUDENT");
    expect(body.institutionId).toBe(instA.id);
    createdUserIds.push(body.id);
  });

  it("rejects a duplicate email with 409", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const existingStudent = await prisma.user.findUnique({ where: { id: studentA.id } });
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "Dup", email: existingStudent!.email, password: "temporary-password" }),
      { params: Promise.resolve({ id: instA.id }) },
    );
    expect(res.status).toBe(409);
  });

  it("never returns passwordHash", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const stamp = Date.now();
    const email = `no-hash-${stamp}@example.edu`;
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "No Hash", email, password: "temporary-password" }),
      { params: Promise.resolve({ id: instA.id }) },
    );
    const body = await res.json();
    expect(body).not.toHaveProperty("passwordHash");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("temporary-password");
    createdUserIds.push(body.id);
  });

  it("writes a student.invite audit log", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const stamp = Date.now();
    const email = `audited-student-${stamp}@example.edu`;
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "Audited Student", email, password: "temporary-password" }),
      { params: Promise.resolve({ id: instA.id }) },
    );
    const body = await res.json();
    createdUserIds.push(body.id);

    const log = await prisma.platformAuditLog.findFirst({
      where: { action: "student.invite", targetId: body.id },
    });
    expect(log).not.toBeNull();
    expect(log?.institutionId).toBe(instA.id);
  });

  it("the invited student has the correct institutionId in the database", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const stamp = Date.now();
    const email = `correct-inst-${stamp}@example.edu`;
    const res = await inviteStudentRoute.POST(
      jsonRequest("POST", { name: "Correct Inst", email, password: "temporary-password" }),
      { params: Promise.resolve({ id: instA.id }) },
    );
    const body = await res.json();
    createdUserIds.push(body.id);
    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    expect(dbUser?.institutionId).toBe(instA.id);
  });
});

describe("8-10. Exam access code set/clear via PATCH /api/exams/[id]", () => {
  it("lecturer can enable an access code on their own exam", async () => {
    const exam = await prisma.exam.create({
      data: { title: "Access Code Exam", durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA.id },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { accessCode: "ROOM-204" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessCodeRequired).toBe(true);

    const dbExam = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(dbExam?.accessCodeHash).not.toBeNull();
    expect(dbExam?.accessCodeHash).not.toBe("ROOM-204");
  });

  it("lecturer can clear the access code", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: "Clearable Exam",
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA.id,
        accessCodeHash: await bcrypt.hash("OLD-CODE", 4),
        accessCodeRequired: true,
      },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { accessCode: null }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessCodeRequired).toBe(false);

    const dbExam = await prisma.exam.findUnique({ where: { id: exam.id } });
    expect(dbExam?.accessCodeHash).toBeNull();
  });

  it("never returns accessCodeHash in the PATCH response", async () => {
    const exam = await prisma.exam.create({
      data: { title: "No Hash Leak Exam", durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA.id },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examRoute.PATCH(jsonRequest("PATCH", { accessCode: "SECRET-1" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    const body = await res.json();
    expect(body).not.toHaveProperty("accessCodeHash");
  });
});

describe("11-15. Student exam list and start with access codes", () => {
  it("student sees the same-institution published exam with accessCodeRequired true", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: "Visible Access Code Exam",
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA.id,
        accessCodeHash: await bcrypt.hash("CODE-123", 4),
        accessCodeRequired: true,
      },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA.id));
    const res = await availableRoute.GET();
    expect(res.status).toBe(200);
    const exams = await res.json();
    const found = exams.find((e: { id: string }) => e.id === exam.id);
    expect(found).toBeDefined();
    expect(found.accessCodeRequired).toBe(true);
    expect(found).not.toHaveProperty("accessCodeHash");
  });

  it("student cannot start an access-code exam without a code", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: "Start No Code Exam",
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA.id,
        accessCodeHash: await bcrypt.hash("CODE-ABC", 4),
        accessCodeRequired: true,
      },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA.id));
    const res = await startRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/access code/i);

    const submission = await prisma.submission.findFirst({
      where: { examId: exam.id, studentId: studentA.id },
    });
    expect(submission).toBeNull();
  });

  it("student cannot start with the wrong code", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: "Start Wrong Code Exam",
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA.id,
        accessCodeHash: await bcrypt.hash("RIGHT-CODE", 4),
        accessCodeRequired: true,
      },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA.id));
    const res = await startRoute.POST(jsonRequest("POST", { accessCode: "WRONG-CODE" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(403);

    const submission = await prisma.submission.findFirst({
      where: { examId: exam.id, studentId: studentA.id },
    });
    expect(submission).toBeNull();
  });

  it("student can start with the correct code", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: "Start Correct Code Exam",
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA.id,
        accessCodeHash: await bcrypt.hash("CORRECT-CODE", 4),
        accessCodeRequired: true,
      },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA.id));
    const res = await startRoute.POST(jsonRequest("POST", { accessCode: "CORRECT-CODE" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(201);
  });

  it("a student from another institution still cannot see or start the exam even with the correct code", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: "Cross Institution Code Exam",
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA.id,
        accessCodeHash: await bcrypt.hash("CROSS-CODE", 4),
        accessCodeRequired: true,
      },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT", instB.id));
    const listRes = await availableRoute.GET();
    const exams = await listRes.json();
    expect(exams.find((e: { id: string }) => e.id === exam.id)).toBeUndefined();

    const startRes = await startRoute.POST(jsonRequest("POST", { accessCode: "CROSS-CODE" }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect([403, 404]).toContain(startRes.status);

    const submission = await prisma.submission.findFirst({
      where: { examId: exam.id, studentId: studentB.id },
    });
    expect(submission).toBeNull();
  });
});

describe("16-17. Regression: exams without an access code, and existing secure-exam flow", () => {
  it("an exam without an access code still starts normally", async () => {
    const exam = await prisma.exam.create({
      data: { title: "No Code Exam", durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA.id },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA.id));
    const res = await startRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
  });

  it("an exam's secureSettings can still be read/updated alongside accessCodeRequired", async () => {
    const exam = await prisma.exam.create({
      data: { title: "Secure And Coded Exam", durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA.id },
    });
    createdExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));
    const res = await examRoute.PATCH(
      jsonRequest("PATCH", { secureSettings: { secureModeEnabled: true }, accessCode: "SEC-1" }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secureSettings.secureModeEnabled).toBe(true);
    expect(body.accessCodeRequired).toBe(true);
  });
});
