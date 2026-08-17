/**
 * Individual Exam Timing & Accommodations v1 — see
 * src/lib/examTimeAccommodation.ts and
 * docs/exam-time-accommodations-v1.md. Covers attempt-start integration
 * (POST /api/exams/[id]/start resolving/freezing the effective duration)
 * and lecturer-management authorization
 * (GET/POST/DELETE /api/exams/[id]/time-accommodations[/[accommodationId]]).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupExamIds: string[] = [];

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: "test@test.invalid", name: "Test", role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

async function createUser(email: string, role: "LECTURER" | "STUDENT", institutionId: string) {
  const passwordHash = await bcrypt.hash("password", 4);
  const u = await prisma.user.create({ data: { name: "Test", email, passwordHash, role, institutionId } });
  cleanupUserIds.push(u.id);
  return u;
}

async function createExam(opts: { institutionId: string; createdById: string; durationMins?: number }) {
  const exam = await prisma.exam.create({
    data: {
      title: `Exam ${stamp}-${Math.random()}`,
      durationMins: opts.durationMins ?? 60,
      published: true,
      createdById: opts.createdById,
      institutionId: opts.institutionId,
      courseId: null, // legacy institution-wide — every same-institution STUDENT is eligible
    },
  });
  cleanupExamIds.push(exam.id);
  return exam;
}

async function startExam(examId: string, studentId: string, institutionId: string) {
  mockAuth.mockResolvedValue(sessionFor(studentId, "STUDENT", institutionId));
  const { POST } = await import("@/app/api/exams/[id]/start/route");
  const req = new Request(`http://localhost/api/exams/${examId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policyAcknowledged: true }),
  });
  return POST(req, { params: Promise.resolve({ id: examId }) });
}

function jsonRequest(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let instA: string;
let instB: string;
let lecturerA: string;
let lecturerAOther: string;
let lecturerB: string;
let studentA1: string;
let studentA2: string;
let studentB: string;

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`time-accommodation-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`time-accommodation-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  lecturerA = (await createUser(`lect-a-${stamp}@test.invalid`, "LECTURER", instA)).id;
  lecturerAOther = (await createUser(`lect-a-other-${stamp}@test.invalid`, "LECTURER", instA)).id;
  lecturerB = (await createUser(`lect-b-${stamp}@test.invalid`, "LECTURER", instB)).id;
  studentA1 = (await createUser(`stud-a1-${stamp}@test.invalid`, "STUDENT", instA)).id;
  studentA2 = (await createUser(`stud-a2-${stamp}@test.invalid`, "STUDENT", instA)).id;
  studentB = (await createUser(`stud-b-${stamp}@test.invalid`, "STUDENT", instB)).id;
});

afterAll(async () => {
  await prisma.examTimeAccommodation.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

describe("POST /api/exams/[id]/start — effective duration resolution and freezing", () => {
  it("1. no accommodation: timingPolicy duration = standard duration", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    const res = await startExam(exam.id, studentA1, instA);
    expect(res.status).toBe(201);
    const submission = await res.json();
    const snapshot = submission.examPolicySnapshotJson as { timingPolicy: { durationMins: number }; timeAccommodation: unknown };
    expect(snapshot.timingPolicy.durationMins).toBe(60);
    expect(snapshot.timeAccommodation).toBeNull();
  });

  it("2. +50% accommodation: 60 -> frozen 90", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 50, createdById: lecturerA },
    });
    const res = await startExam(exam.id, studentA1, instA);
    expect(res.status).toBe(201);
    const submission = await res.json();
    const snapshot = submission.examPolicySnapshotJson as {
      timingPolicy: { durationMins: number };
      timeAccommodation: { standardDurationMins: number; adjustmentMode: string; adjustmentValue: number; effectiveDurationMins: number };
    };
    expect(snapshot.timingPolicy.durationMins).toBe(90);
    expect(snapshot.timeAccommodation).toEqual({
      standardDurationMins: 60,
      adjustmentMode: "PERCENT_EXTRA",
      adjustmentValue: 50,
      effectiveDurationMins: 90,
    });
  });

  it("3. extra-minute accommodation: 60 + 30 -> frozen 90", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "EXTRA_MINUTES", adjustmentValue: 30, createdById: lecturerA },
    });
    const res = await startExam(exam.id, studentA1, instA);
    const submission = await res.json();
    expect((submission.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(90);
  });

  it("4. custom total: standard 60, custom 100 -> frozen 100", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "TOTAL_DURATION", adjustmentValue: 100, createdById: lecturerA },
    });
    const res = await startExam(exam.id, studentA1, instA);
    const submission = await res.json();
    expect((submission.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(100);
  });

  it("5. an existing IN_PROGRESS attempt is resumed without recomputing duration", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    const firstRes = await startExam(exam.id, studentA1, instA);
    expect(firstRes.status).toBe(201);
    const first = await firstRes.json();

    // Add an accommodation AFTER the attempt already started.
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 100, createdById: lecturerA },
    });

    const resumeRes = await startExam(exam.id, studentA1, instA);
    expect(resumeRes.status).toBe(200); // idempotent resume, not a new 201
    const resumed = await resumeRes.json();
    expect(resumed.id).toBe(first.id);
    expect((resumed.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(60);
  });

  it("6. changing exam duration after attempt start does not alter that attempt", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    const res = await startExam(exam.id, studentA1, instA);
    const submission = await res.json();
    expect((submission.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(60);

    await prisma.exam.update({ where: { id: exam.id }, data: { durationMins: 200 } });

    const reloaded = await prisma.submission.findUnique({ where: { id: submission.id } });
    const snapshot = reloaded?.examPolicySnapshotJson as { timingPolicy: { durationMins: number } };
    expect(snapshot.timingPolicy.durationMins).toBe(60);
  });

  it("7. changing accommodation after attempt start does not alter that attempt", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "EXTRA_MINUTES", adjustmentValue: 20, createdById: lecturerA },
    });
    const res = await startExam(exam.id, studentA1, instA);
    const submission = await res.json();
    expect((submission.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(80);

    await prisma.examTimeAccommodation.update({
      where: { examId_studentId: { examId: exam.id, studentId: studentA1 } },
      data: { adjustmentValue: 999 },
    });

    const reloaded = await prisma.submission.findUnique({ where: { id: submission.id } });
    const snapshot = reloaded?.examPolicySnapshotJson as { timingPolicy: { durationMins: number } };
    expect(snapshot.timingPolicy.durationMins).toBe(80);
  });

  it("8. a later NEW attempt uses the updated accommodation (multiple attempts resolved independently)", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    await prisma.exam.update({ where: { id: exam.id }, data: { secureSettings: { maxAttempts: 5 } } });
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 50, createdById: lecturerA },
    });
    const firstRes = await startExam(exam.id, studentA1, instA);
    const first = await firstRes.json();
    expect((first.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(90);

    // Finalize attempt 1 so attempt 2 is allowed to start fresh.
    await prisma.submission.update({ where: { id: first.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    await prisma.examTimeAccommodation.update({
      where: { examId_studentId: { examId: exam.id, studentId: studentA1 } },
      data: { adjustmentValue: 100 },
    });

    const secondRes = await startExam(exam.id, studentA1, instA);
    expect(secondRes.status).toBe(201);
    const second = await secondRes.json();
    expect(second.id).not.toBe(first.id);
    expect((second.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(120);
  });

  it("9. removing an accommodation affects only a later attempt, never the one already started", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    await prisma.exam.update({ where: { id: exam.id }, data: { secureSettings: { maxAttempts: 5 } } });
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "EXTRA_MINUTES", adjustmentValue: 45, createdById: lecturerA },
    });
    const firstRes = await startExam(exam.id, studentA1, instA);
    const first = await firstRes.json();
    expect((first.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(105);

    await prisma.submission.update({ where: { id: first.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    await prisma.examTimeAccommodation.delete({ where: { examId_studentId: { examId: exam.id, studentId: studentA1 } } });

    const secondRes = await startExam(exam.id, studentA1, instA);
    const second = await secondRes.json();
    expect((second.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(60);

    // First attempt's own frozen snapshot is still untouched.
    const reloadedFirst = await prisma.submission.findUnique({ where: { id: first.id } });
    const firstSnapshot = reloadedFirst?.examPolicySnapshotJson as { timingPolicy: { durationMins: number } };
    expect(firstSnapshot.timingPolicy.durationMins).toBe(105);
  });
});

describe("Time accommodation management API — authorization", () => {
  it("owning lecturer may create an accommodation", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/exams/[id]/time-accommodations/route");
    const res = await POST(
      jsonRequest("POST", "http://localhost/x", { studentId: studentA1, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(201);
  });

  it("another lecturer (same institution, not the owner) may not manage it", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerAOther, "LECTURER", instA));
    const { POST } = await import("@/app/api/exams/[id]/time-accommodations/route");
    const res = await POST(
      jsonRequest("POST", "http://localhost/x", { studentId: studentA1, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("a cross-institution lecturer may not manage it, and a cross-institution student is rejected as ineligible", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });

    mockAuth.mockResolvedValue(sessionFor(lecturerB, "LECTURER", instB));
    const { POST } = await import("@/app/api/exams/[id]/time-accommodations/route");
    const crossInstRes = await POST(
      jsonRequest("POST", "http://localhost/x", { studentId: studentA1, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(crossInstRes.status).toBe(404);

    // Owning lecturer, but targeting a student from a DIFFERENT institution.
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const crossStudentRes = await POST(
      jsonRequest("POST", "http://localhost/x", { studentId: studentB, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(crossStudentRes.status).toBe(400);
  });

  it("a non-eligible same-institution student (e.g. not enrolled once course-scoped) is rejected", async () => {
    const course = await prisma.course.create({ data: { institutionId: instA, name: `Course ${stamp}`, code: `TAC-${stamp}` } });
    const exam = await prisma.exam.create({
      data: {
        title: `Exam course-scoped ${stamp}`,
        durationMins: 60,
        published: true,
        createdById: lecturerA,
        institutionId: instA,
        courseId: course.id,
        assignmentMode: "COURSE",
      },
    });
    cleanupExamIds.push(exam.id);
    // studentA2 is deliberately NOT enrolled in `course`.
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/exams/[id]/time-accommodations/route");
    const res = await POST(
      jsonRequest("POST", "http://localhost/x", { studentId: studentA2, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(400);
    await prisma.course.delete({ where: { id: course.id } });
  });

  it("a STUDENT session may not call the lecturer management endpoint", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(studentA1, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/time-accommodations/route");
    const res = await POST(
      jsonRequest("POST", "http://localhost/x", { studentId: studentA1, adjustmentMode: "PERCENT_EXTRA", adjustmentValue: 25 }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(401);
  });

  it("GET returns standardDurationMins, accommodations, and eligibleStudents for the owning lecturer", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 45 });
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "TOTAL_DURATION", adjustmentValue: 70, createdById: lecturerA },
    });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { GET } = await import("@/app/api/exams/[id]/time-accommodations/route");
    const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.standardDurationMins).toBe(45);
    expect(body.accommodations.find((a: { studentId: string }) => a.studentId === studentA1)).toMatchObject({
      adjustmentMode: "TOTAL_DURATION",
      adjustmentValue: 70,
      effectiveDurationMins: 70,
    });
    expect(Array.isArray(body.eligibleStudents)).toBe(true);
  });

  it("DELETE removes an accommodation and never touches an already-started attempt", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, durationMins: 60 });
    await prisma.examTimeAccommodation.create({
      data: { examId: exam.id, studentId: studentA1, adjustmentMode: "EXTRA_MINUTES", adjustmentValue: 15, createdById: lecturerA },
    });
    const startRes = await startExam(exam.id, studentA1, instA);
    const submission = await startRes.json();
    expect((submission.examPolicySnapshotJson as { timingPolicy: { durationMins: number } }).timingPolicy.durationMins).toBe(75);

    const created = await prisma.examTimeAccommodation.findUnique({ where: { examId_studentId: { examId: exam.id, studentId: studentA1 } } });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { DELETE } = await import("@/app/api/exams/[id]/time-accommodations/[accommodationId]/route");
    const delRes = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
      params: Promise.resolve({ id: exam.id, accommodationId: created!.id }),
    });
    expect(delRes.status).toBe(200);

    const stillExists = await prisma.examTimeAccommodation.findUnique({ where: { id: created!.id } });
    expect(stillExists).toBeNull();

    const reloadedSubmission = await prisma.submission.findUnique({ where: { id: submission.id } });
    const snapshot = reloadedSubmission?.examPolicySnapshotJson as { timingPolicy: { durationMins: number } };
    expect(snapshot.timingPolicy.durationMins).toBe(75);
  });
});
