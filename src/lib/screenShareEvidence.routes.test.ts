/**
 * Screen-share Evidence Mode v1 — DB-backed route tests. See
 * docs/screen-share-evidence-v1.md.
 *
 * DB-backed route tests for:
 *  - POST /api/submissions/[id]/screen-evidence
 *  - GET  /api/integrity-evidence/[evidenceAssetId] (reused, unchanged)
 *
 * Requires the local test Postgres instance. Pure policy/lifecycle/
 * evidence logic is covered separately (no DB dependency) in
 * screenSharePolicy.test.ts, screenShareLifecycle.test.ts, and
 * screenShareEvidence.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const uploadRoute = await import("../app/api/submissions/[id]/screen-evidence/route");
const viewRoute = await import("../app/api/integrity-evidence/[evidenceAssetId]/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function makeJpegFile(byteSize = 1000): File {
  const bytes = new Uint8Array(byteSize).fill(1);
  return new File([bytes], "evidence.jpg", { type: "image/jpeg" });
}

function uploadRequest(params: { file?: File | Blob | null; clientRequestId?: string; trigger?: string }) {
  const formData = new FormData();
  if (params.file !== null) formData.append("file", params.file ?? makeJpegFile());
  if (params.clientRequestId) formData.append("clientRequestId", params.clientRequestId);
  if (params.trigger) formData.append("trigger", params.trigger);
  return new Request("http://test.local/route", { method: "POST", body: formData });
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let lecturerA: { id: string };
let studentA: { id: string };
let studentB: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`screen-evidence-a-${stamp}`);
  instA = a.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "SS Lecturer A", email: `ss-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "SS Student A", email: `ss-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  studentB = await prisma.user.create({
    data: { name: "SS Student B", email: `ss-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, studentA.id, studentB.id);
});

afterAll(async () => {
  await prisma.integrityEvidenceAsset.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamAndSubmission(
  opts: {
    screenShareMode?: "OFF" | "REQUIRED";
    captureEvidence?: boolean;
    maxEvidenceFrames?: number;
    evidenceIntervalSeconds?: number;
    submissionStatus?: "IN_PROGRESS" | "SUBMITTED" | "GRADED";
    takeSnapshot?: boolean;
    studentId?: string;
  } = {},
) {
  const mode = opts.screenShareMode ?? "REQUIRED";
  const captureEvidence = opts.captureEvidence ?? true;
  const exam = await prisma.exam.create({
    data: {
      title: `Screen Evidence Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerA.id,
      institutionId: instA,
      secureSettings: {
        screenShareMode: mode,
        screenShareCaptureEvidence: captureEvidence,
        screenShareEvidenceIntervalSeconds: opts.evidenceIntervalSeconds ?? 30,
        screenShareMaxEvidenceFrames: opts.maxEvidenceFrames ?? 20,
      },
    },
  });
  cleanup.exams.push(exam.id);
  const submission = await prisma.submission.create({
    data: {
      examId: exam.id,
      studentId: opts.studentId ?? studentA.id,
      status: opts.submissionStatus ?? "IN_PROGRESS",
      screenSharePolicySnapshotJson:
        opts.takeSnapshot === false
          ? undefined
          : {
              schemaVersion: 1,
              policyVersion: "v1.0",
              mode,
              captureEvidence,
              evidenceIntervalSeconds: opts.evidenceIntervalSeconds ?? 30,
              maxEvidenceFrames: opts.maxEvidenceFrames ?? 20,
            },
    },
  });
  return { exam, submission };
}

describe("evidence upload authorisation", () => {
  it("mode OFF (or evidence disabled) rejects the upload", async () => {
    const { submission } = await createExamAndSubmission({ screenShareMode: "OFF" });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });

  it("captureEvidence disabled rejects the upload even though mode is REQUIRED", async () => {
    const { submission } = await createExamAndSubmission({ screenShareMode: "REQUIRED", captureEvidence: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });

  it("another student cannot upload evidence for a submission that isn't theirs", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("a valid upload for an enabled exam succeeds and creates one event + one asset", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const asset = await prisma.integrityEvidenceAsset.findUnique({ where: { id: body.evidenceAssetId } });
    expect(asset?.kind).toBe("SCREEN_SHARE_EVIDENCE_FRAME");
    const event = await prisma.integrityEvent.findFirst({
      where: { submissionId: submission.id, eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED" },
    });
    expect(event).not.toBeNull();
    expect(event?.severity).toBe("INFO");
  });
});

describe("upload denied after submission", () => {
  it("SUBMITTED status rejects further evidence uploads", async () => {
    const { submission } = await createExamAndSubmission({ submissionStatus: "SUBMITTED" });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(409);
  });
});

describe("legacy policy compatibility", () => {
  it("a submission with no snapshot (predates the feature) is always treated as disabled", async () => {
    const { submission } = await createExamAndSubmission({ takeSnapshot: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });
});

describe("MIME and size rejection", () => {
  it("rejects a disallowed content type", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const badFile = new File([new Uint8Array(10)], "evidence.svg", { type: "image/svg+xml" });
    const res = await uploadRoute.POST(uploadRequest({ file: badFile }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(400);
  });

  it("rejects a request with no file field", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({ file: null }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(400);
  });
});

describe("idempotency", () => {
  it("resubmitting the same clientRequestId replays the original outcome instead of creating a second asset", async () => {
    const { submission } = await createExamAndSubmission({ evidenceIntervalSeconds: 30 });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const clientRequestId = "22222222-2222-4222-8222-222222222222";

    const first = await uploadRoute.POST(uploadRequest({ clientRequestId }), { params: Promise.resolve({ id: submission.id }) });
    const firstBody = await first.json();
    expect(first.status).toBe(201);

    const second = await uploadRoute.POST(uploadRequest({ clientRequestId }), { params: Promise.resolve({ id: submission.id }) });
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody.evidenceAssetId).toBe(firstBody.evidenceAssetId);
    expect(secondBody.replay).toBe(true);

    const count = await prisma.integrityEvidenceAsset.count({ where: { submissionId: submission.id } });
    expect(count).toBe(1);
  });
});

describe("evidence maximum enforcement / concurrent final evidence-slot reservation", () => {
  it("cannot exceed the configured maximum, including under simultaneous requests", async () => {
    const { submission } = await createExamAndSubmission({ maxEvidenceFrames: 1, evidenceIntervalSeconds: 30 });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));

    const [resA, resB] = await Promise.all([
      uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) }),
      uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    // Exactly one succeeds (201); the other is rejected (409) — never both 201.
    expect(statuses).toEqual([201, 409]);

    const count = await prisma.integrityEvidenceAsset.count({ where: { submissionId: submission.id } });
    expect(count).toBe(1);
  });
});

describe("lecturer-only evidence access", () => {
  it("a lecturer (exam owner) can view the evidence frame via the signed-view route", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const uploadRes = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    const { evidenceAssetId } = await uploadRes.json();

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const viewRes = await viewRoute.GET(new Request("http://test.local/route"), {
      params: Promise.resolve({ evidenceAssetId }),
    });
    expect(viewRes.status).toBe(200);
    expect(viewRes.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("a student can never reach the lecturer view route (role check alone rejects it)", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const uploadRes = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    const { evidenceAssetId } = await uploadRes.json();

    const viewRes = await viewRoute.GET(new Request("http://test.local/route"), {
      params: Promise.resolve({ evidenceAssetId }),
    });
    expect(viewRes.status).toBe(401);
  });
});
