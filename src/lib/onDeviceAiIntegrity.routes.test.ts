/**
 * Optional Student Verification + On-Device AI Camera Integrity
 * Detection v1 — see docs/on-device-ai-integrity-detection-v1.md.
 *
 * DB-backed route/evidence-report/risk-scoring tests. These require the
 * local test Postgres instance and can fail/be skipped independently of
 * the pure logic tests in onDeviceAiIntegrity.test.ts, which have no
 * Prisma dependency at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const examRoute = await import("../app/api/exams/[id]/route");
const integrityEventsRoute = await import("../app/api/submissions/[id]/integrity-events/route");
const { buildEvidenceReport } = await import("./evidenceReport");

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
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let instB: string;
let lecturerA: { id: string };
let lecturerB: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`ai-integrity-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`ai-integrity-b-${stamp}`);
  instA = a.id;
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "AI Lecturer A", email: `ai-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "AI Lecturer B", email: `ai-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "AI Student A", email: `ai-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, lecturerB.id, studentA.id);
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExam() {
  const exam = await prisma.exam.create({
    data: {
      title: `AI Integrity Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      createdById: lecturerA.id,
      institutionId: instA,
      published: true,
    },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

describe("settings: requireStudentVerification / enableAiCameraIntegrityChecks", () => {
  it("1/2. lecturer can enable both settings via the existing PATCH route", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await examRoute.PATCH(
      jsonRequest("PATCH", {
        secureSettings: { requireStudentVerification: true, enableAiCameraIntegrityChecks: true },
      }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secureSettings.requireStudentVerification).toBe(true);
    expect(body.secureSettings.enableAiCameraIntegrityChecks).toBe(true);
  });

  it("1/2. lecturer can disable both settings", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(
      jsonRequest("PATCH", {
        secureSettings: { requireStudentVerification: true, enableAiCameraIntegrityChecks: true },
      }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    const res = await examRoute.PATCH(
      jsonRequest("PATCH", {
        secureSettings: { requireStudentVerification: false, enableAiCameraIntegrityChecks: false },
      }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    const body = await res.json();
    expect(body.secureSettings.requireStudentVerification).toBe(false);
    expect(body.secureSettings.enableAiCameraIntegrityChecks).toBe(false);
  });

  it("3. a student can see the new settings flags but never accessCodeHash/correctAnswer alongside them", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await examRoute.PATCH(
      jsonRequest("PATCH", {
        published: true,
        secureSettings: { requireStudentVerification: true, enableAiCameraIntegrityChecks: true },
      }),
      { params: Promise.resolve({ id: exam.id }) },
    );

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await examRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secureSettings.requireStudentVerification).toBe(true);
    expect(body.secureSettings.enableAiCameraIntegrityChecks).toBe(true);
    expect(body.accessCodeHash).toBeUndefined();
  });

  it("a full secureSettings save (secureModeEnabled/requireCamera/blockCopyPaste) round-trips correctly through save-then-reload, as the lecturer edit page relies on", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const patchRes = await examRoute.PATCH(
      jsonRequest("PATCH", {
        secureSettings: {
          secureModeEnabled: true,
          requireCamera: true,
          blockCopyPaste: true,
          requireFullscreen: true,
        },
      }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(patchRes.status).toBe(200);

    // Simulate the lecturer navigating away and reopening the edit page —
    // a fresh GET, not just the PATCH response — since that's the path
    // the reported "toggles reset" symptom would show up on.
    const getRes = await examRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.secureSettings).toMatchObject({
      secureModeEnabled: true,
      requireCamera: true,
      blockCopyPaste: true,
      requireFullscreen: true,
    });
  });
});

describe("AI event types accepted, media metadata rejected", () => {
  it("7. an allowed AI event type (POSSIBLE_PHONE_VISIBLE) is accepted", async () => {
    const exam = await createExam();
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await integrityEventsRoute.POST(
      jsonRequest("POST", {
        eventType: "POSSIBLE_PHONE_VISIBLE",
        severity: "MEDIUM",
        message: "Possible mobile phone visible in camera view. Lecturer review required.",
        metadata: { source: "on_device_camera_ai", confidence: 0.8, confidenceBand: "high" },
        occurredAt: new Date().toISOString(),
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(201);
  });

  it("8. metadata containing an image-like key is rejected", async () => {
    const exam = await createExam();
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await integrityEventsRoute.POST(
      jsonRequest("POST", {
        eventType: "POSSIBLE_PHONE_VISIBLE",
        severity: "MEDIUM",
        message: "test",
        metadata: { frameImage: "irrelevant" },
        occurredAt: new Date().toISOString(),
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(400);

    const count = await prisma.integrityEvent.count({ where: { submissionId: submission.id } });
    expect(count).toBe(0);
  });

  it("8. metadata containing a base64/data-URL value is rejected", async () => {
    const exam = await createExam();
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await integrityEventsRoute.POST(
      jsonRequest("POST", {
        eventType: "CAMERA_VIEW_BLOCKED",
        severity: "MEDIUM",
        message: "test",
        metadata: { note: "data:image/png;base64,AAAABBBB" },
        occurredAt: new Date().toISOString(),
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("21. a student cannot submit an AI event for another student's submission", async () => {
    const exam = await createExam();
    const otherStudent = await prisma.user.create({
      data: { name: "Other Student", email: `ai-other-${stamp}@test.local`, passwordHash: "x", role: "STUDENT", institutionId: instA },
    });
    cleanup.users.push(otherStudent.id);
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });

    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT", instA));
    const res = await integrityEventsRoute.POST(
      jsonRequest("POST", {
        eventType: "POSSIBLE_PHONE_VISIBLE",
        severity: "MEDIUM",
        message: "test",
        occurredAt: new Date().toISOString(),
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("evidence report: neutral wording, AI summary, risk scoring", () => {
  async function createGradedSubmissionWithEvents(events: Array<{ eventType: string; severity: string; metadata?: object }>) {
    const exam = await createExam();
    const submission = await prisma.submission.create({
      data: { examId: exam.id, studentId: studentA.id, status: "GRADED" },
    });
    for (const e of events) {
      await prisma.integrityEvent.create({
        data: {
          submissionId: submission.id,
          examId: exam.id,
          studentId: studentA.id,
          eventType: e.eventType as never,
          severity: e.severity as never,
          message: "test message",
          metadataJson: e.metadata,
          occurredAt: new Date(),
        },
      });
    }
    return submission;
  }

  it("9/10/11/12. AI signals appear in the evidence report with neutral wording", async () => {
    const submission = await createGradedSubmissionWithEvents([
      { eventType: "POSSIBLE_PHONE_VISIBLE", severity: "MEDIUM", metadata: { confidenceBand: "high" } },
      { eventType: "POSSIBLE_SECOND_PERSON_VISIBLE", severity: "MEDIUM" },
      { eventType: "NO_PERSON_VISIBLE", severity: "MEDIUM" },
      { eventType: "CAMERA_VIEW_BLOCKED", severity: "MEDIUM" },
    ]);
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { id: lecturerA.id } });
    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturer.id, role: "LECTURER", institutionId: instA },
    } as never);

    expect(report.aiCameraIntegritySummary).toEqual({
      possiblePhoneCount: 1,
      possibleSecondPersonCount: 1,
      noPersonCount: 1,
      cameraBlockedOrDarkCount: 1,
      disclaimer: "AI camera signals are indicators for review. They are not automatic misconduct decisions.",
    });

    const allText = JSON.stringify(report.events).toLowerCase();
    expect(allText).not.toContain("cheating");
    expect(allText).not.toContain("confirmed");
    expect(allText).not.toContain("caught");
    expect(allText).not.toContain("proof");

    const phoneEvent = report.events.find((e) => e.eventType === "POSSIBLE_PHONE_VISIBLE");
    expect(phoneEvent?.confidenceBand).toBe("high");
    expect(phoneEvent?.eventLabel).toContain("Possible");
  });

  it("13. AI-unavailable events do not increase risk", async () => {
    const submission = await createGradedSubmissionWithEvents([
      { eventType: "AI_CAMERA_CHECK_UNAVAILABLE", severity: "INFO" },
    ]);
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { id: lecturerA.id } });
    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturer.id, role: "LECTURER", institutionId: instA },
    } as never);
    expect(report.riskScore).toBe(0);
    expect(report.riskLevel).toBe("CLEAN");
  });

  it("14. student verification confirmed does not increase risk", async () => {
    const submission = await createGradedSubmissionWithEvents([
      { eventType: "STUDENT_VERIFICATION_CONFIRMED", severity: "INFO" },
    ]);
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { id: lecturerA.id } });
    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturer.id, role: "LECTURER", institutionId: instA },
    } as never);
    expect(report.riskScore).toBe(0);
    expect(report.riskLevel).toBe("CLEAN");
  });

  it("15. repeated MEDIUM-severity phone/person signals raise risk conservatively (not to HIGH from a single event)", async () => {
    const single = await createGradedSubmissionWithEvents([
      { eventType: "POSSIBLE_PHONE_VISIBLE", severity: "MEDIUM" },
    ]);
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { id: lecturerA.id } });
    const singleReport = await buildEvidenceReport(single.id, {
      user: { id: lecturer.id, role: "LECTURER", institutionId: instA },
    } as never);
    expect(singleReport.riskLevel).not.toBe("HIGH");

    const repeated = await createGradedSubmissionWithEvents(
      Array.from({ length: 5 }, () => ({ eventType: "POSSIBLE_PHONE_VISIBLE", severity: "MEDIUM" })),
    );
    const repeatedReport = await buildEvidenceReport(repeated.id, {
      user: { id: lecturer.id, role: "LECTURER", institutionId: instA },
    } as never);
    expect(repeatedReport.riskScore).toBeGreaterThan(singleReport.riskScore);
  });

  it("camera-too-dark is weighted lower than phone/second-person signals", async () => {
    const dark = await createGradedSubmissionWithEvents([{ eventType: "CAMERA_TOO_DARK", severity: "LOW" }]);
    const phone = await createGradedSubmissionWithEvents([{ eventType: "POSSIBLE_PHONE_VISIBLE", severity: "MEDIUM" }]);
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { id: lecturerA.id } });
    const darkReport = await buildEvidenceReport(dark.id, {
      user: { id: lecturer.id, role: "LECTURER", institutionId: instA },
    } as never);
    const phoneReport = await buildEvidenceReport(phone.id, {
      user: { id: lecturer.id, role: "LECTURER", institutionId: instA },
    } as never);
    expect(darkReport.riskScore).toBeLessThan(phoneReport.riskScore);
  });

  it("22. cross-institution evidence access is blocked", async () => {
    const submission = await createGradedSubmissionWithEvents([]);
    const lecturerBUser = await prisma.user.findUniqueOrThrow({ where: { id: lecturerB.id } });
    await expect(
      buildEvidenceReport(submission.id, {
        user: { id: lecturerBUser.id, role: "LECTURER", institutionId: instB },
      } as never),
    ).rejects.toThrow();
  });
});

describe("student verification: no image/video capture", () => {
  it("5/6. a STUDENT_VERIFICATION_CONFIRMED event is metadata-only (no image/video fields)", async () => {
    const exam = await createExam();
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await integrityEventsRoute.POST(
      jsonRequest("POST", {
        eventType: "STUDENT_VERIFICATION_CONFIRMED",
        severity: "INFO",
        message: "Student confirmed identity before starting the exam.",
        occurredAt: new Date().toISOString(),
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(res.status).toBe(201);
    const event = await res.json();
    expect(event.metadataJson).toBeFalsy();
  });
});
