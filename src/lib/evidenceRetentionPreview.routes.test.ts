/**
 * Production administration hardening v1, Part E — DB-backed tests for
 * the evidence-retention admin preview endpoint. See
 * docs/tether-evidence-retention-plan.md.
 *
 * SAFE EXECUTION ONLY: run via `npm run release:validate` (disposable
 * Postgres).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const previewRoute = await import("../app/api/platform/evidence-retention-preview/route");

function sessionFor(userId: string, role: string, institutionId: string) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
}

function getRequest(url: string) {
  return new Request(url);
}

let institution: { id: string };
let platformAdmin: { id: string };
let lecturer: { id: string };
let student: { id: string };
const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

beforeAll(async () => {
  institution = await getOrCreateTestInstitution(`ret-preview-${stamp}`);
  const passwordHash = await bcrypt.hash("test-password", 4);
  platformAdmin = await prisma.user.create({
    data: { name: "RetPreview Admin", email: `ret-preview-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: institution.id },
  });
  lecturer = await prisma.user.create({
    data: { name: "RetPreview Lecturer", email: `ret-preview-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: institution.id },
  });
  student = await prisma.user.create({
    data: { name: "RetPreview Student", email: `ret-preview-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: institution.id },
  });
  cleanup.users.push(platformAdmin.id, lecturer.id, student.id);
});

afterAll(async () => {
  await prisma.integrityEvidenceAsset.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
  await prisma.$disconnect();
});

async function createEvidenceAsset(capturedAt: Date, byteSize: number) {
  const exam = await prisma.exam.create({
    data: { title: `RetPreview Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: institution.id },
  });
  cleanup.exams.push(exam.id);
  const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: student.id, status: "IN_PROGRESS" } });
  const event = await prisma.integrityEvent.create({
    data: { submissionId: submission.id, examId: exam.id, studentId: student.id, eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED", severity: "INFO", message: "test", occurredAt: capturedAt },
  });
  return prisma.integrityEvidenceAsset.create({
    data: {
      integrityEventId: event.id,
      submissionId: submission.id,
      examId: exam.id,
      institutionId: institution.id,
      kind: "SCREEN_SHARE_EVIDENCE_FRAME",
      eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED",
      storageProvider: "local_dev",
      storageKey: `ret-preview-test/${randomUUID()}.jpg`,
      contentType: "image/jpeg",
      byteSize,
      capturedAt,
    },
  });
}

describe("GET /api/platform/evidence-retention-preview — authorization", () => {
  it("rejects STUDENT and LECTURER, allows PLATFORM_ADMIN", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", institution.id));
    expect((await previewRoute.GET(getRequest("http://test.local/api/platform/evidence-retention-preview"))).status).toBe(403);

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", institution.id));
    expect((await previewRoute.GET(getRequest("http://test.local/api/platform/evidence-retention-preview"))).status).toBe(403);

    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institution.id));
    expect((await previewRoute.GET(getRequest("http://test.local/api/platform/evidence-retention-preview"))).status).toBe(200);
  });
});

describe("GET /api/platform/evidence-retention-preview — dry-run-only reporting", () => {
  it("reports affected count, total bytes, oldest/newest, and never deletes anything", async () => {
    const now = new Date();
    const old1 = await createEvidenceAsset(new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000), 1000);
    const old2 = await createEvidenceAsset(new Date(now.getTime() - 150 * 24 * 60 * 60 * 1000), 2000);
    const recent = await createEvidenceAsset(new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), 4000);

    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institution.id));
    const res = await previewRoute.GET(getRequest(`http://test.local/api/platform/evidence-retention-preview?institutionId=${institution.id}&retentionDays=90`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.dryRun).toBe(true);
    expect(body.affectedCount).toBe(2);
    expect(body.totalBytes).toBe(3000);
    expect(body.institutionId).toBe(institution.id);

    // Never deleted — the assets are still present.
    expect(await prisma.integrityEvidenceAsset.findUnique({ where: { id: old1.id } })).not.toBeNull();
    expect(await prisma.integrityEvidenceAsset.findUnique({ where: { id: old2.id } })).not.toBeNull();
    expect(await prisma.integrityEvidenceAsset.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it("reports zero affected/zero bytes when nothing is eligible, never null/undefined", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institution.id));
    const res = await previewRoute.GET(getRequest(`http://test.local/api/platform/evidence-retention-preview?institutionId=${institution.id}&retentionDays=100000`));
    const body = await res.json();
    expect(body.affectedCount).toBe(0);
    expect(body.totalBytes).toBe(0);
    expect(body.oldestCapturedAt).toBeNull();
    expect(body.newestCapturedAt).toBeNull();
  });
});
