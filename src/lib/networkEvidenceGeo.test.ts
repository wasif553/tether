/**
 * Tests that exam start/submit succeed even when geolocation fails, and
 * that country/region/city are stored when the provider returns them.
 * Fetch is mocked — no internet access required.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import bcrypt from "bcryptjs";

// ── Auth mock ─────────────────────────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");

const stamp = Date.now();
const createdUserIds: string[] = [];
const createdExamIds: string[] = [];

let instId: string;
let lecturerId: string;
let studentId: string;

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

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`ne-geo-test-${stamp}`);
  instId = inst.id;
  const hash = await bcrypt.hash("pw", 4);
  const lect = await prisma.user.create({
    data: { name: "GeoL", email: `geo-lect-${stamp}@test.invalid`, passwordHash: hash, role: "LECTURER", institutionId: instId },
  });
  lecturerId = lect.id;
  createdUserIds.push(lect.id);
  const stud = await prisma.user.create({
    data: { name: "GeoS", email: `geo-stud-${stamp}@test.invalid`, passwordHash: hash, role: "STUDENT", institutionId: instId },
  });
  studentId = stud.id;
  createdUserIds.push(stud.id);
});

afterAll(async () => {
  await prisma.exam.deleteMany({ where: { id: { in: createdExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GEOLOCATION_PROVIDER;
  delete process.env.GEOLOCATION_API_KEY;
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function makeExam(title: string) {
  const exam = await prisma.exam.create({
    data: { title, durationMins: 60, createdById: lecturerId, institutionId: instId, published: true },
  });
  createdExamIds.push(exam.id);
  return exam;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Exam start — geolocation failure does not block student", () => {
  it("returns 201 and creates submission even if geolocation provider errors", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    // Make all fetch calls fail (simulates provider outage).
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("provider down"));

    const exam = await makeExam(`Geo Fail Start ${stamp}`);
    mockAuth.mockResolvedValue(sessionFor(studentId, "STUDENT", instId));

    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });

    // Student must NOT be blocked.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();

    // Give fire-and-forget evidence a moment to attempt/fail.
    await new Promise((r) => setTimeout(r, 80));
  });
});

describe("Exam start — country stored when provider returns it", () => {
  it("stores country/region/city in NetworkEvidence when provider responds", async () => {
    process.env.GEOLOCATION_PROVIDER = "ipapi";
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          country_name: "Australia",
          country_code: "AU",
          region: "Victoria",
          city: "Melbourne",
          timezone: "Australia/Melbourne",
          proxy: false,
          vpn: false,
        }),
        { status: 200 },
      ),
    );

    const exam = await makeExam(`Geo Country Start ${stamp}`);
    mockAuth.mockResolvedValue(sessionFor(studentId, "STUDENT", instId));

    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const req = new Request(`http://localhost/api/exams/${exam.id}/start`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.11" },
    });
    const res = await POST(req, { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const { id: subId } = await res.json();

    // Evidence is fire-and-forget — wait a bit longer to let it settle.
    await new Promise((r) => setTimeout(r, 150));

    const evidence = await prisma.networkEvidence.findFirst({
      where: { submissionId: subId, source: "EXAM_START" },
    });
    expect(evidence).not.toBeNull();
    expect(evidence?.country).toBe("Australia");
    expect(evidence?.region).toBe("Victoria");
    expect(evidence?.city).toBe("Melbourne");
    expect(evidence?.locationAccuracy).toBe("IP_APPROXIMATE");
  });
});

describe("Exam submit — geolocation failure does not block student", () => {
  it("returns 200 for submission even if geolocation provider errors at submit time", async () => {
    // Set up a submission already in progress.
    const exam = await makeExam(`Geo Fail Submit ${stamp}`);
    const sub = await prisma.submission.create({
      data: { examId: exam.id, studentId, status: "IN_PROGRESS" },
    });

    process.env.GEOLOCATION_PROVIDER = "ipapi";
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("provider down at submit"));

    mockAuth.mockResolvedValue(sessionFor(studentId, "STUDENT", instId));

    const { POST } = await import("@/app/api/submissions/[id]/submit/route");
    const req = new Request(`http://localhost/api/submissions/${sub.id}/submit`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.20" },
    });
    const res = await POST(req, { params: Promise.resolve({ id: sub.id }) });

    // Submit must NOT be blocked by geo failure.
    expect([200, 201]).toContain(res.status);
    const body = await res.json();
    expect(body.status).toMatch(/GRADED|SUBMITTED/);

    await new Promise((r) => setTimeout(r, 80));
  });
});
