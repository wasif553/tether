import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("../prisma");
const { getOrCreateTestInstitution } = await import("../testInstitution");
const unmatchedRoute = await import("../../app/api/lecturer/lti/unmatched-launches/route");
const linkRoute = await import("../../app/api/lecturer/lti/unmatched-launches/[id]/link/route");
const pilotReadinessRoute = await import("../../app/api/lecturer/pilot-readiness/route");
const { maskSubject } = await import("./unmatchedLaunches");

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
let exam: { id: string };
let platform: { id: string };
const resourceLinkId = `unmatched-test-rl-${Date.now()}`;
const canvasSubject = "canvas-sub-1234567890abcdef";
let launchId: string;

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("unmatched-launches-test");
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Unmatched Lecturer", email: `unmatched-lect-${Date.now()}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitution.id },
  });
  student = await prisma.user.create({
    data: { name: "Unmatched Student", email: `unmatched-stud-${Date.now()}@test.local`, passwordHash, role: "STUDENT", institutionId: testInstitution.id },
  });
  exam = await prisma.exam.create({
    data: { title: "Unmatched Test Exam", durationMins: 30, createdById: lecturer.id, institutionId: testInstitution.id },
  });
  platform =
    (await prisma.ltiPlatform.findFirst({ where: { institutionId: testInstitution.id } })) ??
    (await prisma.ltiPlatform.create({
      data: {
        issuer: `https://unmatched-test-platform-${Date.now()}.example.com`,
        clientId: "test-client",
        authEndpoint: "https://example.com/auth",
        tokenEndpoint: "https://example.com/token",
        jwksUrl: "https://example.com/jwks",
        deploymentId: "test-deployment",
        institutionId: testInstitution.id,
      },
    }));

  const launch = await prisma.ltiLaunch.create({
    data: {
      platformId: platform.id,
      canvasUserId: canvasSubject,
      canvasCourseId: "course-999",
      canvasAssignmentId: "assignment-888",
      resourceLinkId,
      deploymentId: "deployment-777",
      launchRole: "STUDENT",
      launchClaimsJson: { sub: canvasSubject, email: "secret-student@example.com" },
      examId: null,
    },
  });
  launchId = launch.id;
});

afterAll(async () => {
  await prisma.canvasGradePassback.deleteMany({ where: { submission: { studentId: { in: [lecturer.id, student.id] } } } });
  await prisma.ltiExamLink.deleteMany({ where: { resourceLinkId } });
  await prisma.ltiLaunch.deleteMany({ where: { resourceLinkId } });
  await prisma.exam.deleteMany({ where: { id: exam.id } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturer.id, student.id] } } });
  await prisma.$disconnect();
});

describe("maskSubject", () => {
  it("never returns the full raw subject", () => {
    const masked = maskSubject(canvasSubject);
    expect(masked).not.toBe(canvasSubject);
    expect(masked.length).toBeLessThan(canvasSubject.length);
  });
});

describe("GET /api/lecturer/lti/unmatched-launches", () => {
  it("records and lists the unmatched launch safely, without raw claims", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await unmatchedRoute.GET();
    expect(res.status).toBe(200);
    const launches = await res.json();
    const found = launches.find((l: { resourceLinkId: string }) => l.resourceLinkId === resourceLinkId);
    expect(found).toBeDefined();
    expect(found.subject).not.toBe(canvasSubject);

    const serialized = JSON.stringify(launches);
    expect(serialized).not.toContain(canvasSubject);
    expect(serialized).not.toContain("secret-student@example.com");
    expect(serialized).not.toContain("launchClaimsJson");
  });

  it("is lecturer-only (401 for a student)", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await unmatchedRoute.GET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/lecturer/lti/unmatched-launches/[id]/link", () => {
  it("links the unmatched launch to an exam and backfills its examId", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await linkRoute.POST(jsonRequest("POST", { examId: exam.id }), {
      params: Promise.resolve({ id: launchId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.examId).toBe(exam.id);

    const updatedLaunch = await prisma.ltiLaunch.findUnique({ where: { id: launchId } });
    expect(updatedLaunch?.examId).toBe(exam.id);

    const listRes = await unmatchedRoute.GET();
    const launches = await listRes.json();
    expect(launches.some((l: { resourceLinkId: string }) => l.resourceLinkId === resourceLinkId)).toBe(false);
  });

  it("reuses the existing link when linking the same resource to the same exam again", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await linkRoute.POST(jsonRequest("POST", { examId: exam.id }), {
      params: Promise.resolve({ id: launchId }),
    });
    expect(res.status).toBe(200);
  });

  it("returns a safe 409 when the resource is already linked to a different exam", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const otherExam = await prisma.exam.create({
      data: { title: "Other Exam", durationMins: 30, createdById: lecturer.id, institutionId: testInstitution.id },
    });

    const res = await linkRoute.POST(jsonRequest("POST", { examId: otherExam.id }), {
      params: Promise.resolve({ id: launchId }),
    });
    expect(res.status).toBe(409);

    await prisma.exam.delete({ where: { id: otherExam.id } });
  });
});

describe("pilot readiness unmatched-launch warning", () => {
  it("includes an unmatched Canvas launches item", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await pilotReadinessRoute.GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    const item = data.canvasOptional.find((i: { label: string }) => i.label === "Unmatched Canvas launches");
    expect(item).toBeDefined();
    expect(["READY", "WARNING"]).toContain(item.status);
  });
});
