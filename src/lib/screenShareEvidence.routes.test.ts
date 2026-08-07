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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

// Audit-fix test — "failed evidence upload does not expose exam content or
// crash Tether". Wraps the REAL storage adapter's `put` behind a mock that
// delegates to it by default, so every other test in this file is
// unaffected; only a test that explicitly arms `mockStoragePut` with a
// rejection sees a failure.
const { mockStoragePut, realAdapterRef } = vi.hoisted(() => ({
  mockStoragePut: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realAdapterRef: { current: null as any },
}));
vi.mock("@/lib/evidenceStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./evidenceStorage")>();
  return {
    ...actual,
    resolveEvidenceStorageAdapter: (...args: Parameters<typeof actual.resolveEvidenceStorageAdapter>) => {
      const real = actual.resolveEvidenceStorageAdapter(...args);
      realAdapterRef.current = real;
      // `real` is a class instance — get/put/delete live on its
      // prototype, so `{ ...real }` would silently drop them (only the
      // `provider` field, an own instance property, would survive).
      // Bind the real methods explicitly instead of spreading.
      return {
        provider: real.provider,
        put: mockStoragePut,
        get: real.get.bind(real),
        delete: real.delete.bind(real),
      };
    },
  };
});

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const uploadRoute = await import("../app/api/submissions/[id]/screen-evidence/route");
const viewRoute = await import("../app/api/integrity-evidence/[evidenceAssetId]/route");
const integrityEventsRoute = await import("../app/api/submissions/[id]/integrity-events/route");
const integrityReviewRoute = await import("../app/api/lecturer/submissions/[id]/integrity-review/route");

beforeEach(() => {
  mockStoragePut.mockReset();
  mockStoragePut.mockImplementation((...args: unknown[]) => {
    if (!realAdapterRef.current) throw new Error("real adapter not resolved yet");
    return realAdapterRef.current.put(...args);
  });
});

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
let instB: string;
let lecturerA: { id: string };
let lecturerB: { id: string };
let studentA: { id: string };
let studentB: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`screen-evidence-a-${stamp}`);
  instA = a.id;
  const b = await getOrCreateTestInstitution(`screen-evidence-b-${stamp}`);
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "SS Lecturer A", email: `ss-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  // Audit-fix test fixture — "lecturers can access evidence only for
  // authorised exams" — a lecturer at a DIFFERENT institution, never the
  // owner of any exam created below.
  lecturerB = await prisma.user.create({
    data: { name: "SS Lecturer B", email: `ss-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "SS Student A", email: `ss-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  studentB = await prisma.user.create({
    data: { name: "SS Student B", email: `ss-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
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

  // Secure Exam Evidence Review audit v1 — "lecturers can access evidence
  // only for authorised exams". The exam-owner/same-institution checks
  // live in buildEvidenceReport() (used by both the JSON and CSV evidence
  // routes) and are already exercised for a DIFFERENT INSTITUTION in
  // multiTenant.routes.test.ts for camera evidence; this proves the same
  // guard for the signed-view route specifically, with screen-share
  // evidence, end to end.
  it("a lecturer at a different institution cannot view the evidence frame, even with a valid asset id", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const uploadRes = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    const { evidenceAssetId } = await uploadRes.json();

    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const viewRes = await viewRoute.GET(new Request("http://test.local/route"), {
      params: Promise.resolve({ evidenceAssetId }),
    });
    expect(viewRes.status).toBe(403);
  });
});

describe("Secure Exam Evidence Review audit v1 — screen-share interruptions create reviewable events", () => {
  it("a SCREEN_SHARE_INTERRUPTED event defaults to NEEDS_REVIEW and appears in the lecturer integrity-review response", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));

    const eventRes = await integrityEventsRoute.POST(
      new Request("http://test.local/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: "SCREEN_SHARE_INTERRUPTED",
          severity: "MEDIUM",
          message: "Screen sharing was interrupted.",
        }),
      }),
      { params: Promise.resolve({ id: submission.id }) },
    );
    expect(eventRes.status).toBe(201);
    const created = await eventRes.json();
    expect(created.reviewStatus).toBe("NEEDS_REVIEW");

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const reviewRes = await integrityReviewRoute.GET(new Request("http://test.local/route"), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(reviewRes.status).toBe(200);
    const review = await reviewRes.json();
    const reviewEvent = review.events.find((e: { id: string }) => e.id === created.id);
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent.reviewStatus).toBe("NEEDS_REVIEW");
    expect(review.summary.needsReviewCount).toBeGreaterThanOrEqual(1);
  });
});

describe("mid-exam remote-session monitoring v1 — INTEGRITY_EVENT-triggered capture", () => {
  it("is accepted and stored with trigger INTEGRITY_EVENT when screen evidence capture is enabled", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({ trigger: "INTEGRITY_EVENT" }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    const asset = await prisma.integrityEvidenceAsset.findUnique({ where: { id: body.evidenceAssetId } });
    expect(asset).not.toBeNull();
    const event = await prisma.integrityEvent.findUnique({ where: { id: asset!.integrityEventId } });
    expect((event?.metadataJson as { trigger?: string } | null)?.trigger).toBe("INTEGRITY_EVENT");
  });

  it("respects exam policy exactly like every other trigger — rejected when captureEvidence is disabled", async () => {
    const { submission } = await createExamAndSubmission({ screenShareMode: "REQUIRED", captureEvidence: false });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({ trigger: "INTEGRITY_EVENT" }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });

  it("respects exam policy exactly like every other trigger — rejected when screen-share mode is OFF", async () => {
    const { submission } = await createExamAndSubmission({ screenShareMode: "OFF" });
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await uploadRoute.POST(uploadRequest({ trigger: "INTEGRITY_EVENT" }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(403);
  });

  it("a storage failure on an INTEGRITY_EVENT-triggered capture is non-fatal — 503, no orphaned state, submission untouched", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    mockStoragePut.mockRejectedValueOnce(new Error("simulated storage backend outage"));

    const res = await uploadRoute.POST(uploadRequest({ trigger: "INTEGRITY_EVENT" }), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(503);
    const assetCount = await prisma.integrityEvidenceAsset.count({ where: { submissionId: submission.id } });
    expect(assetCount).toBe(0);
    const stillInProgress = await prisma.submission.findUnique({ where: { id: submission.id }, select: { status: true } });
    expect(stillInProgress?.status).toBe("IN_PROGRESS");
  });
});

describe("Secure Exam Evidence Review audit v1 — failed evidence upload does not expose exam content or crash Tether", () => {
  it("a storage-adapter failure returns 503, creates no orphaned event or asset, and never echoes internal error details", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));

    mockStoragePut.mockRejectedValueOnce(new Error("simulated storage backend outage — internal detail that must never reach the client"));

    const res = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    // The response must be a calm, generic message — never the raw
    // Error#message (which could describe internal infrastructure), and
    // never any exam content (question/answer text is never touched by
    // this route at all, but the response body is still checked to be
    // exactly the bounded shape the route documents).
    expect(JSON.stringify(body)).not.toContain("simulated storage backend outage");
    expect(Object.keys(body)).toEqual(["error"]);

    const eventCount = await prisma.integrityEvent.count({
      where: { submissionId: submission.id, eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED" },
    });
    expect(eventCount).toBe(0);
    const assetCount = await prisma.integrityEvidenceAsset.count({ where: { submissionId: submission.id } });
    expect(assetCount).toBe(0);

    // The submission itself is untouched — a failed capture never fails
    // the attempt.
    const stillInProgress = await prisma.submission.findUnique({ where: { id: submission.id }, select: { status: true } });
    expect(stillInProgress?.status).toBe("IN_PROGRESS");
  });

  it("a subsequent upload after the storage backend recovers succeeds normally (the failure was not sticky)", async () => {
    const { submission } = await createExamAndSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));

    mockStoragePut.mockRejectedValueOnce(new Error("transient outage"));
    const failed = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(failed.status).toBe(503);

    // beforeEach already re-arms mockStoragePut to delegate to the real
    // adapter for the NEXT call, but mockRejectedValueOnce above already
    // consumed itself — this call uses the real adapter directly.
    const succeeded = await uploadRoute.POST(uploadRequest({}), { params: Promise.resolve({ id: submission.id }) });
    expect(succeeded.status).toBe(201);
  });
});
