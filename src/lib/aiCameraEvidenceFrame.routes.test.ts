/**
 * Add privacy-minimised AI camera evidence frames — see
 * docs/on-device-ai-integrity-detection-v1.md.
 *
 * DB-backed route tests for:
 *  - POST /api/submissions/[id]/integrity-events/[eventId]/evidence-frame
 *  - GET  /api/integrity-evidence/[evidenceAssetId]
 *
 * Requires the local test Postgres instance. Pure logic (eligibility,
 * default-off, key generation, upload validation) is covered separately
 * in aiCameraEvidenceFrame.test.ts, with no DB dependency at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const uploadRoute = await import("../app/api/submissions/[id]/integrity-events/[eventId]/evidence-frame/route");
const viewRoute = await import("../app/api/integrity-evidence/[evidenceAssetId]/route");
const { buildEvidenceReport } = await import("./evidenceReport");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

function makeJpegFile(byteSize = 1000): File {
  const bytes = new Uint8Array(byteSize).fill(1);
  return new File([bytes], "evidence.jpg", { type: "image/jpeg" });
}

function uploadRequest(file: File | Blob | null) {
  const formData = new FormData();
  if (file) formData.append("file", file);
  return new Request("http://test.local/route", { method: "POST", body: formData });
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let instB: string;
let lecturerA: { id: string };
let lecturerB: { id: string };
let studentA: { id: string };
let studentB: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`evidence-frame-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`evidence-frame-b-${stamp}`);
  instA = a.id;
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "Evidence Lecturer A", email: `ev-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "Evidence Lecturer B", email: `ev-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "Evidence Student A", email: `ev-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  studentB = await prisma.user.create({
    data: { name: "Evidence Student B", email: `ev-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, lecturerB.id, studentA.id, studentB.id);
});

afterAll(async () => {
  await prisma.integrityEvidenceAsset.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExam(opts: { captureEnabled: boolean }) {
  const exam = await prisma.exam.create({
    data: {
      title: `Evidence Frame Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      createdById: lecturerA.id,
      institutionId: instA,
      published: true,
      secureSettings: {
        enableAiCameraIntegrityChecks: true,
        captureAiViolationEvidence: opts.captureEnabled,
      },
    },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

async function createSubmissionAndEvent(examId: string, studentId: string, eventType: string) {
  const submission = await prisma.submission.create({ data: { examId, studentId } });
  const event = await prisma.integrityEvent.create({
    data: {
      submissionId: submission.id,
      examId,
      studentId,
      eventType: eventType as never,
      severity: "MEDIUM",
      message: "test",
      occurredAt: new Date(),
    },
  });
  return { submission, event };
}

describe("POST /api/submissions/[id]/integrity-events/[eventId]/evidence-frame", () => {
  it("1. student can upload an evidence frame for their own submission's eligible event", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.evidenceAssetId).toBe("string");

    // 7/9. Raw storage key is never returned — the response body is only
    // { ok, evidenceAssetId }, never the ai-camera-evidence/... path.
    expect(Object.keys(body).sort()).toEqual(["evidenceAssetId", "ok"]);
    expect(body.storageKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("ai-camera-evidence/");
  });

  it("2. upload rejected if event belongs to another submission", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission: ownSubmission } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");
    const { event: otherEvent } = await createSubmissionAndEvent(exam.id, studentB.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: ownSubmission.id, eventId: otherEvent.id }),
    });
    expect(res.status).toBe(404);
  });

  it("a student cannot upload against someone else's submission id at all", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentB.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(404);
  });

  it("3. upload rejected for NO_PERSON_VISIBLE (not eligible for evidence capture in v1)", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "NO_PERSON_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(400);
  });

  it("3. upload rejected for CAMERA_TOO_DARK", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "CAMERA_TOO_DARK");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(400);
  });

  it("3. upload rejected for CAMERA_VIEW_BLOCKED", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "CAMERA_VIEW_BLOCKED");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(400);
  });

  it("upload rejected when captureAiViolationEvidence is not enabled for the exam", async () => {
    const exam = await createExam({ captureEnabled: false });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(403);
  });

  it("7. upload rejected with a non-sensitive JSON error when the file field is missing", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest(null), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    // Non-sensitive: no storage key, path, or stack trace in the error.
    expect(body.error).not.toMatch(/institution\/|storage|\.jpg|\.webp/i);
  });

  it("4. upload rejected for non-image content (text/html)", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const htmlFile = new File([new Uint8Array(100)], "evidence.html", { type: "text/html" });
    const res = await uploadRoute.POST(uploadRequest(htmlFile), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(400);
  });

  it("4. upload rejected for SVG content", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const svgFile = new File([new Uint8Array(100)], "evidence.svg", { type: "image/svg+xml" });
    const res = await uploadRoute.POST(uploadRequest(svgFile), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(400);
  });

  it("6. one evidence asset per integrity event — a second upload for the same event is rejected", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_SECOND_PERSON_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const first = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(first.status).toBe(201);

    const second = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(second.status).toBe(409);
  });

  it("a lecturer cannot use the student-only upload route", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/integrity-evidence/[evidenceAssetId]", () => {
  async function createEvidenceAsset() {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const uploadRes = await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    const { evidenceAssetId } = await uploadRes.json();
    return { exam, submission, event, evidenceAssetId };
  }

  it("5. lecturer with same-institution owner access can view the evidence frame", async () => {
    const { evidenceAssetId } = await createEvidenceAsset();

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await viewRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ evidenceAssetId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("6. an unauthorised lecturer (different institution) cannot view the evidence frame", async () => {
    const { evidenceAssetId } = await createEvidenceAsset();

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await viewRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ evidenceAssetId }),
    });
    expect(res.status).toBe(403);
  });

  it("a student can never view the evidence frame via this route", async () => {
    const { evidenceAssetId } = await createEvidenceAsset();

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await viewRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ evidenceAssetId }),
    });
    expect(res.status).toBe(401);
  });

  it("7. the response never includes the raw storageKey", async () => {
    const { evidenceAssetId } = await createEvidenceAsset();

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await viewRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ evidenceAssetId }),
    });
    expect(res.status).toBe(200);
    // The body is raw image bytes, not JSON containing a storageKey field —
    // confirm the content-type is the image type, not application/json.
    expect(res.headers.get("content-type")).not.toContain("json");
  });

  it("8. viewing evidence is audited in PlatformAuditLog", async () => {
    const { evidenceAssetId } = await createEvidenceAsset();

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await viewRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ evidenceAssetId }),
    });

    // Audit write is fire-and-forget (best-effort) — poll briefly for it.
    let logEntry = null;
    for (let attempt = 0; attempt < 10 && !logEntry; attempt++) {
      logEntry = await prisma.platformAuditLog.findFirst({
        where: { targetType: "IntegrityEvidenceAsset", targetId: evidenceAssetId },
      });
      if (!logEntry) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(logEntry).not.toBeNull();
    expect(logEntry?.actorId).toBe(lecturerA.id);
    expect(logEntry?.action).toBe("VIEW_AI_CAMERA_EVIDENCE_FRAME");
    // Never logs the image itself.
    expect(JSON.stringify(logEntry?.metadata ?? {})).not.toMatch(/^data:/);
    expect(JSON.stringify(logEntry?.metadata ?? {}).length).toBeLessThan(500);
  });

  it("returns 404 for a nonexistent evidence asset id", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await viewRoute.GET(new Request("http://test.local"), {
      params: Promise.resolve({ evidenceAssetId: "nonexistent-id" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("buildEvidenceReport — evidenceFrame mapping (lecturer evidence report)", () => {
  it("1/3. includes evidenceFrame with the event id when an IntegrityEvidenceAsset exists for POSSIBLE_PHONE_VISIBLE", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const uploadRes = await uploadRoute.POST(uploadRequest(makeJpegFile(2048)), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    expect(uploadRes.status).toBe(201);
    const { evidenceAssetId } = await uploadRes.json();

    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturerA.id, role: "LECTURER", institutionId: instA },
    } as never);

    const reportedEvent = report.events.find((e) => e.id === event.id);
    expect(reportedEvent).toBeDefined();
    expect(reportedEvent?.eventType).toBe("POSSIBLE_PHONE_VISIBLE");
    expect(reportedEvent?.evidenceFrame).toEqual({
      id: evidenceAssetId,
      contentType: "image/jpeg",
      byteSize: 2048,
      capturedAt: expect.any(String),
    });
  });

  it("2. never returns a storageKey anywhere in the report", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(
      exam.id,
      studentA.id,
      "POSSIBLE_SECOND_PERSON_VISIBLE",
    );

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });

    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturerA.id, role: "LECTURER", institutionId: instA },
    } as never);

    expect(JSON.stringify(report)).not.toMatch(/ai-camera-evidence\//);
    const reportedEvent = report.events.find((e) => e.id === event.id);
    expect((reportedEvent?.evidenceFrame as Record<string, unknown> | null)?.storageKey).toBeUndefined();
  });

  it("8. Possible second person visible event with an asset is displayed correctly", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(
      exam.id,
      studentA.id,
      "POSSIBLE_SECOND_PERSON_VISIBLE",
    );

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });

    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturerA.id, role: "LECTURER", institutionId: instA },
    } as never);

    const reportedEvent = report.events.find((e) => e.id === event.id);
    expect(reportedEvent?.eventType).toBe("POSSIBLE_SECOND_PERSON_VISIBLE");
    expect(reportedEvent?.evidenceFrame).not.toBeNull();
  });

  it("9. NO_PERSON_VISIBLE (never eligible for evidence capture) has no evidenceFrame", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "NO_PERSON_VISIBLE");

    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturerA.id, role: "LECTURER", institutionId: instA },
    } as never);

    const reportedEvent = report.events.find((e) => e.id === event.id);
    expect(reportedEvent?.eventType).toBe("NO_PERSON_VISIBLE");
    expect(reportedEvent?.evidenceFrame).toBeNull();
  });

  it("exposes a top-level evidenceFrames array so the lecturer report can surface a dedicated section", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(exam.id, studentA.id, "POSSIBLE_PHONE_VISIBLE");

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const uploadRes = await uploadRoute.POST(uploadRequest(makeJpegFile(4096)), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });
    const { evidenceAssetId } = await uploadRes.json();

    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturerA.id, role: "LECTURER", institutionId: instA },
    } as never);

    expect(report.evidenceFrames).toHaveLength(1);
    expect(report.evidenceFrames[0]).toEqual({
      id: evidenceAssetId,
      eventId: event.id,
      eventType: "POSSIBLE_PHONE_VISIBLE",
      occurredAt: expect.any(String),
      contentType: "image/jpeg",
      byteSize: 4096,
      capturedAt: expect.any(String),
    });
  });

  it("evidenceFrames is empty when no evidence was ever captured for the submission", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission } = await createSubmissionAndEvent(exam.id, studentA.id, "NO_PERSON_VISIBLE");

    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturerA.id, role: "LECTURER", institutionId: instA },
    } as never);

    expect(report.evidenceFrames).toEqual([]);
  });

  it("evidenceFrames never includes a storageKey or raw storage path", async () => {
    const exam = await createExam({ captureEnabled: true });
    const { submission, event } = await createSubmissionAndEvent(
      exam.id,
      studentA.id,
      "POSSIBLE_SECOND_PERSON_VISIBLE",
    );

    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await uploadRoute.POST(uploadRequest(makeJpegFile()), {
      params: Promise.resolve({ id: submission.id, eventId: event.id }),
    });

    const report = await buildEvidenceReport(submission.id, {
      user: { id: lecturerA.id, role: "LECTURER", institutionId: instA },
    } as never);

    expect(JSON.stringify(report.evidenceFrames)).not.toMatch(/ai-camera-evidence\//);
    expect((report.evidenceFrames[0] as Record<string, unknown>).storageKey).toBeUndefined();
  });
});
