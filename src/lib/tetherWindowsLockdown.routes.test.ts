/**
 * Tether Windows Lockdown Hardening v1 — DB-backed route tests. See
 * docs/tether-windows-lockdown-hardening-v1.md.
 *
 * SAFE EXECUTION ONLY: run this file exclusively via `npm run
 * release:validate` — never a direct `npx vitest run` against this
 * repository's committed DATABASE_URL. See
 * src/lib/prismaDbSafetyGuard.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { Prisma } from "@/generated/prisma/client";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const policyRoute = await import("../app/api/tether/lockdown/policy/route");
const auditEventRoute = await import("../app/api/tether/lockdown/audit-event/route");
const integrityEventsRoute = await import("../app/api/submissions/[id]/integrity-events/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");

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
let otherStudent: { id: string };
const stamp = Date.now();
const cleanupExamIds: string[] = [];
const cleanupUserIds: string[] = [];

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("tether-lockdown-test");
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Lockdown Lecturer", email: `lockdown-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitution.id },
  });
  student = await prisma.user.create({
    data: { name: "Lockdown Student", email: `lockdown-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
  otherStudent = await prisma.user.create({
    data: { name: "Lockdown Other Student", email: `lockdown-stud2-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
  cleanupUserIds.push(student.id, otherStudent.id);
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.platformAuditLog.deleteMany({ where: { actorId: { in: [...cleanupUserIds] } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturer.id, ...cleanupUserIds] } } });
  await prisma.$disconnect();
});

async function createExam(title: string, extraSettings: Record<string, unknown> = {}) {
  const exam = await prisma.exam.create({
    data: {
      title: `${title} ${stamp}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturer.id,
      institutionId: testInstitution.id,
      secureSettings: extraSettings as Prisma.InputJsonValue,
    },
  });
  cleanupExamIds.push(exam.id);
  await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });
  return exam;
}

async function startAsStudent(examId: string, studentUser: { id: string } = student) {
  mockAuth.mockResolvedValue(sessionFor(studentUser.id, "STUDENT"));
  const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: examId }) });
  expect(res.status).toBeLessThan(300);
  return res.json();
}

describe("GET /api/tether/lockdown/policy", () => {
  it("returns the four documented boolean toggles for an authenticated student", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const res = await policyRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      blockRemoteControl: expect.any(Boolean),
      blockScreenCaptureTools: expect.any(Boolean),
      blockDebugTools: expect.any(Boolean),
      blockVirtualMachines: expect.any(Boolean),
    });
  });

  it("401s for an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await policyRoute.GET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/tether/lockdown/audit-event — PlatformAuditLog only, never IntegrityEvent", () => {
  it("creates a PlatformAuditLog entry scoped to the submission when submissionId is provided", async () => {
    const exam = await createExam("Lockdown Audit Submission Scope", { deliveryMode: "TETHER_CLIENT_REQUIRED" });
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await auditEventRoute.POST(
      jsonRequest("POST", { action: "TETHER_LOCKDOWN_PREFLIGHT_BLOCKED", submissionId: submission.id, metadata: { capabilityCount: 1 } }),
    );
    expect(res.status).toBe(201);

    const log = await prisma.platformAuditLog.findFirst({
      where: { action: "TETHER_LOCKDOWN_PREFLIGHT_BLOCKED", targetId: submission.id },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log?.targetType).toBe("Submission");
    expect(log?.actorId).toBe(student.id);

    // 30 — never an IntegrityEvent for a technical/administrative fact.
    const integrityCount = await prisma.integrityEvent.count({ where: { submissionId: submission.id } });
    expect(integrityCount).toBe(0);
  });

  it("creates a PlatformAuditLog entry scoped to the exam when only examId is provided (a pre-submission fact)", async () => {
    const exam = await createExam("Lockdown Audit Exam Scope", { deliveryMode: "TETHER_CLIENT_REQUIRED" });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await auditEventRoute.POST(jsonRequest("POST", { action: "TETHER_LOCKDOWN_PROCESS_INSPECTION_UNAVAILABLE", examId: exam.id }));
    expect(res.status).toBe(201);

    const log = await prisma.platformAuditLog.findFirst({
      where: { action: "TETHER_LOCKDOWN_PROCESS_INSPECTION_UNAVAILABLE", targetId: exam.id },
      orderBy: { createdAt: "desc" },
    });
    expect(log?.targetType).toBe("Exam");
  });

  it("rejects an action not on the fixed allow-list", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const res = await auditEventRoute.POST(jsonRequest("POST", { action: "SOMETHING_NOT_ALLOWED" }));
    expect(res.status).toBe(400);
  });

  it("a student cannot write an audit fact against another student's submission (ownership check)", async () => {
    const exam = await createExam("Lockdown Audit Cross Student", { deliveryMode: "TETHER_CLIENT_REQUIRED" });
    const submission = await startAsStudent(exam.id, student);
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT"));

    const res = await auditEventRoute.POST(jsonRequest("POST", { action: "TETHER_LOCKDOWN_PREFLIGHT_BLOCKED", submissionId: submission.id }));
    expect(res.status).toBe(404);
  });

  it("29. metadata never persists more than bounded primitive values (no full process list / command-line arguments)", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const res = await auditEventRoute.POST(
      jsonRequest("POST", {
        action: "TETHER_LOCKDOWN_DETECTION_SERVICE_FAILURE",
        metadata: { reason: "TIMEOUT", rawProcessList: ["a".repeat(10_000)] },
      }),
    );
    // The array value is rejected by the metadata schema (only string/number/boolean values allowed) — 400, never silently persisted.
    expect(res.status).toBe(400);
  });
});

describe("POST /api/submissions/[id]/integrity-events — Part 4/11, new lockdown event types", () => {
  it("31. accepts REMOTE_CONTROL_SOFTWARE_DETECTED as a reviewable (MEDIUM) integrity event during an active exam", async () => {
    const exam = await createExam("Lockdown Integrity Event Remote Control", { deliveryMode: "TETHER_CLIENT_REQUIRED" });
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await integrityEventsRoute.POST(
      jsonRequest("POST", {
        eventType: "REMOTE_CONTROL_SOFTWARE_DETECTED",
        severity: "MEDIUM",
        message: "TeamViewer was detected.",
        metadata: { capabilityId: "TEAMVIEWER", category: "REMOTE_CONTROL", policyAction: "BLOCK_DURING_EXAM" },
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.eventType).toBe("REMOTE_CONTROL_SOFTWARE_DETECTED");
    expect(body.severity).toBe("MEDIUM");
  });

  it("10. accepts PROHIBITED_APPLICATION_CLOSED as an INFO-tier resolution event", async () => {
    const exam = await createExam("Lockdown Integrity Event Closed", { deliveryMode: "TETHER_CLIENT_REQUIRED" });
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await integrityEventsRoute.POST(
      jsonRequest("POST", {
        eventType: "PROHIBITED_APPLICATION_CLOSED",
        severity: "INFO",
        message: "TeamViewer was closed.",
        metadata: { capabilityId: "TEAMVIEWER", durationMs: 4500 },
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.severity).toBe("INFO");
  });

  it("9. duplicate scans within the debounce window create one logical integrity event, not a new row every time", async () => {
    const exam = await createExam("Lockdown Integrity Event Dedup", { deliveryMode: "TETHER_CLIENT_REQUIRED" });
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const payload = {
      eventType: "DEBUGGING_TOOL_DETECTED",
      severity: "MEDIUM",
      message: "Visual Studio was detected.",
      metadata: { capabilityId: "VISUAL_STUDIO_DEBUGGER" },
    };

    const first = await integrityEventsRoute.POST(jsonRequest("POST", payload), { params: Promise.resolve({ id: submission.id }) });
    expect(first.status).toBe(201);
    const second = await integrityEventsRoute.POST(jsonRequest("POST", payload), { params: Promise.resolve({ id: submission.id }) });
    expect(second.status).toBe(200); // debounced — returns the existing event, not a new 201

    const rows = await prisma.integrityEvent.count({ where: { submissionId: submission.id, eventType: "DEBUGGING_TOOL_DETECTED" } });
    expect(rows).toBe(1);
  });

  it("14/F.14 (pre-merge audit finding). concurrent duplicate detection requests for the same (submission, eventType) pair never create duplicate IntegrityEvent rows", async () => {
    // Repeated across many iterations (a single race can get lucky) with
    // genuinely concurrent Promise.all calls, each targeting a FRESH
    // submission so no request ever benefits from a prior committed row
    // acting as an accidental guard — mirrors the established pattern
    // for this exact class of bug (see answers/route.ts's own "3b/4b"
    // concurrent-revision regression test).
    const ITERATIONS = 15;
    for (let i = 0; i < ITERATIONS; i++) {
      const iterExam = await createExam(`Lockdown Concurrent Dedup Iter ${i}`, { deliveryMode: "TETHER_CLIENT_REQUIRED" });
      const iterSubmission = await startAsStudent(iterExam.id);
      mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
      const payload = {
        eventType: "REMOTE_CONTROL_SOFTWARE_DETECTED",
        severity: "MEDIUM",
        message: "TeamViewer was detected.",
        metadata: { capabilityId: "TEAMVIEWER", category: "REMOTE_CONTROL", policyAction: "BLOCK_DURING_EXAM" },
      };

      const [a, b, c] = await Promise.all([
        integrityEventsRoute.POST(jsonRequest("POST", payload), { params: Promise.resolve({ id: iterSubmission.id }) }),
        integrityEventsRoute.POST(jsonRequest("POST", payload), { params: Promise.resolve({ id: iterSubmission.id }) }),
        integrityEventsRoute.POST(jsonRequest("POST", payload), { params: Promise.resolve({ id: iterSubmission.id }) }),
      ]);
      expect([a.status, b.status, c.status].every((s) => s === 200 || s === 201)).toBe(true);
      // Exactly one of the three genuinely created the row (201); the
      // other two must observe it and dedupe (200) — never three 201s.
      const createdCount = [a.status, b.status, c.status].filter((s) => s === 201).length;
      expect(createdCount).toBe(1);

      const rows = await prisma.integrityEvent.count({ where: { submissionId: iterSubmission.id, eventType: "REMOTE_CONTROL_SOFTWARE_DETECTED" } });
      expect(rows).toBe(1);
    }
  });

  it("32. non-final / non-Tether assessment behaviour is completely unaffected by the new event types existing", async () => {
    const exam = await prisma.exam.create({
      data: { title: `Lockdown Regression Standard Web ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: testInstitution.id },
    });
    cleanupExamIds.push(exam.id);
    await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });
    const submission = await startAsStudent(exam.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submitRes = await submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(submitRes.status).toBe(200);
    const submitBody = await submitRes.json();
    expect(submitBody.status).toBe("GRADED");
  });
});
