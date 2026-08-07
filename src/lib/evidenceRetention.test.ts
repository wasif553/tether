/**
 * Secure Exam Evidence Review audit v1 — "evidence retention and
 * deletion rules are enforced". See
 * docs/secure-exam-evidence-review-audit-v1.md, area 13: no time-based
 * retention window exists anywhere in this repo (documented, deferred
 * v1 limitation across several docs) — the one rule that IS actually
 * enforced today is cascade-delete: `IntegrityEvidenceAsset` has
 * `onDelete: Cascade` from `IntegrityEvent`/`Submission`/`Exam`
 * (prisma/schema.prisma). This file proves that rule directly against a
 * real database, rather than only trusting the schema declaration.
 *
 * Requires the local test Postgres instance.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { getOrCreateTestInstitution } from "./testInstitution";

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let lecturerA: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`evidence-retention-${stamp}`);
  instA = a.id;
  lecturerA = await prisma.user.create({
    data: { name: "ER Lecturer", email: `er-ret-lect-${stamp}@test.local`, passwordHash: "x", role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "ER Student", email: `er-ret-stud-${stamp}@test.local`, passwordHash: "x", role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, studentA.id);
});

afterAll(async () => {
  await prisma.integrityEvidenceAsset.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamSubmissionEventAndAsset() {
  const exam = await prisma.exam.create({
    data: {
      title: `Retention Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerA.id,
      institutionId: instA,
    },
  });
  cleanup.exams.push(exam.id);
  const submission = await prisma.submission.create({
    data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" },
  });
  const event = await prisma.integrityEvent.create({
    data: {
      submissionId: submission.id,
      examId: exam.id,
      studentId: studentA.id,
      eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED",
      severity: "INFO",
      message: "Evidence frame captured for retention test.",
      occurredAt: new Date(),
    },
  });
  const asset = await prisma.integrityEvidenceAsset.create({
    data: {
      integrityEventId: event.id,
      submissionId: submission.id,
      examId: exam.id,
      institutionId: instA,
      kind: "SCREEN_SHARE_EVIDENCE_FRAME",
      eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED",
      storageProvider: "local_dev",
      storageKey: `retention-test/${randomUUID()}.jpg`,
      contentType: "image/jpeg",
      byteSize: 1234,
    },
  });
  return { exam, submission, event, asset };
}

describe("evidence cascade-delete rules (prisma/schema.prisma onDelete: Cascade)", () => {
  it("deleting the IntegrityEvent removes its IntegrityEvidenceAsset", async () => {
    const { event, asset } = await createExamSubmissionEventAndAsset();
    await prisma.integrityEvent.delete({ where: { id: event.id } });
    const found = await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } });
    expect(found).toBeNull();
  });

  it("deleting the Submission removes its IntegrityEvent and IntegrityEvidenceAsset rows", async () => {
    const { submission, event, asset } = await createExamSubmissionEventAndAsset();
    await prisma.submission.delete({ where: { id: submission.id } });
    expect(await prisma.integrityEvent.findUnique({ where: { id: event.id } })).toBeNull();
    expect(await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } })).toBeNull();
  });

  it("deleting the Exam removes its Submission, IntegrityEvent, and IntegrityEvidenceAsset rows", async () => {
    const { exam, submission, event, asset } = await createExamSubmissionEventAndAsset();
    await prisma.exam.delete({ where: { id: exam.id } });
    expect(await prisma.submission.findUnique({ where: { id: submission.id } })).toBeNull();
    expect(await prisma.integrityEvent.findUnique({ where: { id: event.id } })).toBeNull();
    expect(await prisma.integrityEvidenceAsset.findUnique({ where: { id: asset.id } })).toBeNull();
    // This exam is already gone — don't try to delete it again in afterAll.
    cleanup.exams = cleanup.exams.filter((id) => id !== exam.id);
  });

  it("deleting an unrelated submission's event never removes another submission's evidence asset (no cross-submission leakage in the cascade)", async () => {
    const a = await createExamSubmissionEventAndAsset();
    const b = await createExamSubmissionEventAndAsset();
    await prisma.integrityEvent.delete({ where: { id: a.event.id } });
    const bAssetStillPresent = await prisma.integrityEvidenceAsset.findUnique({ where: { id: b.asset.id } });
    expect(bAssetStillPresent).not.toBeNull();
  });
});
