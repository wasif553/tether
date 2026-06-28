import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const evidenceRoute = await import("../app/api/lecturer/submissions/[id]/evidence/route");
const integrityEventsRoute = await import("../app/api/submissions/[id]/integrity-events/route");

let testInstitution: { id: string };

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

let lecturer: { id: string };
let student: { id: string };

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("camera-monitoring-test");
  const passwordHash = await bcrypt.hash("test-password", 4);
  const stamp = Date.now();
  lecturer = await prisma.user.create({
    data: { name: "Camera Lecturer", email: `cam-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitution.id },
  });
  student = await prisma.user.create({
    data: { name: "Camera Student", email: `cam-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
});

afterAll(async () => {
  const userIds = [lecturer.id, student.id];
  await prisma.integrityEvent.deleteMany({ where: { studentId: { in: userIds } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: userIds } } });
  await prisma.exam.deleteMany({ where: { createdById: lecturer.id } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("camera and keyboard/fullscreen events accepted by the integrity-events route", () => {
  it("accepts a CAMERA_PERMISSION_DENIED event tied to an existing submission", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "Camera Gate Exam",
        durationMins: 30,
        published: true,
        createdById: lecturer.id, institutionId: testInstitution.id,
        secureSettings: { secureModeEnabled: true, requireCamera: true },
      },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id },
    });

    const res = await integrityEventsRoute.POST(
      jsonRequest("POST", {
        eventType: "CAMERA_PERMISSION_DENIED",
        severity: "HIGH",
        message: "Camera access is required for this exam.",
        occurredAt: new Date().toISOString(),
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.eventType).toBe("CAMERA_PERMISSION_DENIED");
  });
});

describe("evidence report includes camera and browser-friction event types", () => {
  it("includes camera, keyboard-shortcut, and fullscreen-forced-return events with friendly labels", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "Evidence Camera Exam",
        durationMins: 30,
        published: true,
        createdById: lecturer.id, institutionId: testInstitution.id,
        secureSettings: { secureModeEnabled: true, requireCamera: true },
      },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: student.id },
    });

    const events: Array<{ eventType: string; severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" }> = [
      { eventType: "CAMERA_PERMISSION_GRANTED", severity: "INFO" },
      { eventType: "CAMERA_STARTED", severity: "INFO" },
      { eventType: "CAMERA_HEARTBEAT_MISSED", severity: "MEDIUM" },
      { eventType: "KEYBOARD_SHORTCUT_BLOCKED", severity: "INFO" },
      { eventType: "FULLSCREEN_FORCED_RETURN", severity: "LOW" },
    ];
    for (const e of events) {
      await prisma.integrityEvent.create({
        data: {
          submissionId: submission.id,
          examId: exam.id,
          studentId: student.id,
          eventType: e.eventType as never,
          severity: e.severity,
          message: "test event",
          occurredAt: new Date(),
        },
      });
    }

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const res = await evidenceRoute.GET(jsonRequest("GET"), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const eventTypes = body.events.map((e: { eventType: string }) => e.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "CAMERA_PERMISSION_GRANTED",
        "CAMERA_STARTED",
        "CAMERA_HEARTBEAT_MISSED",
        "KEYBOARD_SHORTCUT_BLOCKED",
        "FULLSCREEN_FORCED_RETURN",
      ]),
    );

    const labels = body.events.map((e: { eventLabel: string }) => e.eventLabel);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Camera permission granted",
        "Camera monitoring started",
        "Camera heartbeat missed",
        "Keyboard shortcut blocked",
        "Fullscreen restored",
      ]),
    );
  });
});

describe("non-camera secure exam settings are unaffected by the camera additions", () => {
  it("an exam with secureModeEnabled true but requireCamera unset still defaults requireCamera to false", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const exam = await prisma.exam.create({
      data: {
        title: "No Camera Exam",
        durationMins: 30,
        published: true,
        createdById: lecturer.id, institutionId: testInstitution.id,
        secureSettings: { secureModeEnabled: true },
      },
    });
    expect((exam.secureSettings as Record<string, unknown>).requireCamera).toBeUndefined();
  });
});
