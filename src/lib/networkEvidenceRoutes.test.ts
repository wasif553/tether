/**
 * Integration tests for Academic Integrity Network Evidence v1.
 * Tests exam-start evidence capture, review signal generation in evidence
 * report, cross-institution isolation, and CSV export.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";

// ── Auth mock (must be hoisted before any imports) ───────────────────────────

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

// ── DB helpers ────────────────────────────────────────────────────────────────

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupSubmissionIds: string[] = [];

function sessionFor(
  userId: string,
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN",
  institutionId: string,
) {
  return {
    user: { id: userId, email: "test@test.invalid", name: "Test", role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

async function createUser(
  email: string,
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN",
  institutionId: string,
) {
  const passwordHash = await bcrypt.hash("password", 4);
  const u = await prisma.user.create({
    data: { name: "NE Test", email, passwordHash, role, institutionId },
  });
  cleanupUserIds.push(u.id);
  return u;
}

async function createExam(title: string, lecturerId: string, institutionId: string) {
  return prisma.exam.create({
    data: { title, durationMins: 60, createdById: lecturerId, institutionId, published: true },
  });
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

let instId: string;
let lecturerId: string;
let studentId: string;
let inst2Id: string;
let otherLecturerId: string;

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`ne-routes-test-${stamp}`);
  instId = inst.id;
  const inst2 = await getOrCreateTestInstitution(`ne-routes-other-${stamp}`);
  inst2Id = inst2.id;

  const lecturer = await createUser(`ne-lect-${stamp}@test.invalid`, "LECTURER", instId);
  lecturerId = lecturer.id;
  const student = await createUser(`ne-stud-${stamp}@test.invalid`, "STUDENT", instId);
  studentId = student.id;
  const otherLecturer = await createUser(`ne-other-lect-${stamp}@test.invalid`, "LECTURER", inst2Id);
  otherLecturerId = otherLecturer.id;
});

afterAll(async () => {
  // Delete exams (and their submissions via cascade) before users to
  // avoid FK constraint on Exam.createdById.
  await prisma.exam.deleteMany({
    where: { createdById: { in: cleanupUserIds } },
  });
  if (cleanupUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
});

// ── Exam start evidence capture ───────────────────────────────────────────────

describe("Network evidence — exam start (POST /api/exams/[id]/start)", () => {
  it("creates a NetworkEvidence row with source EXAM_START", async () => {
    const exam = await createExam(`NE Start Exam ${stamp}`, lecturerId, instId);
    mockAuth.mockResolvedValue(sessionFor(studentId, "STUDENT", instId));

    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, {
      method: "POST",
      headers: {
        "x-forwarded-for": "203.0.113.42",
        "user-agent": "Mozilla/5.0 Chrome/120",
      },
    });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    const submissionId = body.id;
    cleanupSubmissionIds.push(submissionId);

    // Evidence is fire-and-forget — give async path time to settle.
    await new Promise((r) => setTimeout(r, 80));

    const evidence = await prisma.networkEvidence.findFirst({
      where: { submissionId, source: "EXAM_START" },
    });
    expect(evidence).not.toBeNull();
    expect(evidence?.ipAddress).toBe("203.0.113.42");
    expect(evidence?.source).toBe("EXAM_START");
    expect(evidence?.studentId).toBe(studentId);
    expect(evidence?.examId).toBe(exam.id);
  });

  it("does not expose IP in the start route response", async () => {
    const exam = await createExam(`NE No IP Leak ${stamp}`, lecturerId, instId);
    mockAuth.mockResolvedValue(sessionFor(studentId, "STUDENT", instId));

    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    cleanupSubmissionIds.push(body.id);
    expect(JSON.stringify(body)).not.toContain("203.0.113.99");
  });
});

// ── Evidence report: network evidence section ─────────────────────────────────

describe("Network evidence — evidence report (buildEvidenceReport)", () => {
  async function makeSubmissionWithEvidence(opts: {
    examId: string;
    startCountry?: string | null;
    submitCountry?: string | null;
    networkChanged?: boolean;
  }) {
    const sub = await prisma.submission.create({
      data: { examId: opts.examId, studentId, status: "GRADED" },
    });
    cleanupSubmissionIds.push(sub.id);
    await prisma.networkEvidence.create({
      data: {
        submissionId: sub.id, examId: opts.examId, studentId, institutionId: instId,
        source: "EXAM_START", ipAddress: "1.1.1.1", ipHash: "h-start",
        locationAccuracy: opts.startCountry ? "IP_APPROXIMATE" : "UNAVAILABLE",
        country: opts.startCountry ?? null,
      },
    });
    await prisma.networkEvidence.create({
      data: {
        submissionId: sub.id, examId: opts.examId, studentId, institutionId: instId,
        source: "EXAM_SUBMIT", ipAddress: "2.2.2.2", ipHash: "h-submit",
        locationAccuracy: opts.submitCountry ? "IP_APPROXIMATE" : "UNAVAILABLE",
        country: opts.submitCountry ?? null,
        networkChanged: opts.networkChanged ?? false,
      },
    });
    return sub;
  }

  it("includes networkEvidence section with start IP", async () => {
    const exam = await createExam(`NE Report Basic ${stamp}`, lecturerId, instId);
    const sub = await prisma.submission.create({
      data: { examId: exam.id, studentId, status: "GRADED" },
    });
    cleanupSubmissionIds.push(sub.id);
    await prisma.networkEvidence.create({
      data: {
        submissionId: sub.id, examId: exam.id, studentId, institutionId: instId,
        source: "EXAM_START", ipAddress: "203.0.113.1", ipHash: "testhash",
        locationAccuracy: "UNAVAILABLE",
      },
    });

    const { buildEvidenceReport } = await import("@/lib/evidenceReport");
    const report = await buildEvidenceReport(sub.id, sessionFor(lecturerId, "LECTURER", instId));

    expect(report.networkEvidence).toBeDefined();
    expect(report.networkEvidence.start).not.toBeNull();
    expect(report.networkEvidence.start?.ipAddress).toBe("203.0.113.1");
    expect(report.networkEvidence.reviewSignal).toBe("Normal");
    expect(report.networkEvidence.networkEvidenceDisclaimer).toBeTruthy();
  });

  it("returns High review signal when start/submit countries differ", async () => {
    const exam = await createExam(`NE Report High ${stamp}`, lecturerId, instId);
    const sub = await makeSubmissionWithEvidence({
      examId: exam.id,
      startCountry: "AU",
      submitCountry: "US",
      networkChanged: true,
    });

    const { buildEvidenceReport } = await import("@/lib/evidenceReport");
    const report = await buildEvidenceReport(sub.id, sessionFor(lecturerId, "LECTURER", instId));

    expect(report.networkEvidence.reviewSignal).toBe("High review signal");
    expect(report.networkEvidence.submit?.networkChanged).toBe(true);
  });

  it("returns Needs review when IP changed but country unknown", async () => {
    const exam = await createExam(`NE Report Medium ${stamp}`, lecturerId, instId);
    const sub = await makeSubmissionWithEvidence({
      examId: exam.id,
      startCountry: null,
      submitCountry: null,
      networkChanged: true,
    });

    const { buildEvidenceReport } = await import("@/lib/evidenceReport");
    const report = await buildEvidenceReport(sub.id, sessionFor(lecturerId, "LECTURER", instId));

    expect(report.networkEvidence.reviewSignal).toBe("Needs review");
  });

  it("returns Normal when same country and no change", async () => {
    const exam = await createExam(`NE Report Normal ${stamp}`, lecturerId, instId);
    const sub = await makeSubmissionWithEvidence({
      examId: exam.id,
      startCountry: "AU",
      submitCountry: "AU",
      networkChanged: false,
    });

    const { buildEvidenceReport } = await import("@/lib/evidenceReport");
    const report = await buildEvidenceReport(sub.id, sessionFor(lecturerId, "LECTURER", instId));

    expect(report.networkEvidence.reviewSignal).toBe("Normal");
  });

  it("throws EvidenceForbiddenError for a different institution's lecturer", async () => {
    const exam = await createExam(`NE Report Forbidden ${stamp}`, lecturerId, instId);
    const sub = await prisma.submission.create({
      data: { examId: exam.id, studentId, status: "GRADED" },
    });
    cleanupSubmissionIds.push(sub.id);

    const { buildEvidenceReport, EvidenceForbiddenError } = await import("@/lib/evidenceReport");
    await expect(
      buildEvidenceReport(sub.id, sessionFor(otherLecturerId, "LECTURER", inst2Id)),
    ).rejects.toThrow(EvidenceForbiddenError);
  });

  it("includes network evidence section in CSV export", async () => {
    const exam = await createExam(`NE CSV Export ${stamp}`, lecturerId, instId);
    const sub = await prisma.submission.create({
      data: { examId: exam.id, studentId, status: "GRADED" },
    });
    cleanupSubmissionIds.push(sub.id);
    await prisma.networkEvidence.create({
      data: {
        submissionId: sub.id, examId: exam.id, studentId, institutionId: instId,
        source: "EXAM_START", ipAddress: "9.9.9.9", locationAccuracy: "UNAVAILABLE",
        ipHash: "h-csv",
      },
    });

    const { buildEvidenceReport, evidenceReportToCsv } = await import("@/lib/evidenceReport");
    const report = await buildEvidenceReport(sub.id, sessionFor(lecturerId, "LECTURER", instId));
    const csv = evidenceReportToCsv(report);

    expect(csv).toContain("Network Evidence");
    expect(csv).toContain("Network review signal");
    expect(csv).toContain("9.9.9.9");
    expect(csv).toContain("IP-based location is approximate");
  });
});
