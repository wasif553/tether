import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const linksRoute = await import("../app/api/lecturer/exams/[examId]/lti-links/route");
const linkRoute = await import("../app/api/lecturer/exams/[examId]/lti-links/[linkId]/route");
const pilotReadinessRoute = await import("../app/api/lecturer/pilot-readiness/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT") {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId } };
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

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Link Lecturer", email: `link-lect-${Date.now()}@test.local`, passwordHash, role: "LECTURER" },
  });
  student = await prisma.user.create({
    data: { name: "Link Student", email: `link-stud-${Date.now()}@test.local`, passwordHash, role: "STUDENT" },
  });
  exam = await prisma.exam.create({
    data: { title: "Link Test Exam", durationMins: 30, createdById: lecturer.id },
  });
  platform =
    (await prisma.ltiPlatform.findFirst()) ??
    (await prisma.ltiPlatform.create({
      data: {
        issuer: `https://test-platform-${Date.now()}.example.com`,
        clientId: "test-client",
        authEndpoint: "https://example.com/auth",
        tokenEndpoint: "https://example.com/token",
        jwksUrl: "https://example.com/jwks",
        deploymentId: "test-deployment",
      },
    }));
});

afterAll(async () => {
  await prisma.ltiExamLink.deleteMany({ where: { examId: exam.id } });
  await prisma.exam.deleteMany({ where: { id: exam.id } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturer.id, student.id] } } });
  await prisma.$disconnect();
});

describe("LTI exam link CRUD", () => {
  it("creates a link successfully", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await linksRoute.POST(
      jsonRequest("POST", { platformId: platform.id, resourceLinkId: "rl-001", label: "Test link" }),
      { params: Promise.resolve({ examId: exam.id }) },
    );

    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link.resourceLinkId).toBe("rl-001");
  });

  it("rejects a duplicate (platformId, resourceLinkId) pair with 409", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await linksRoute.POST(
      jsonRequest("POST", { platformId: platform.id, resourceLinkId: "rl-001" }),
      { params: Promise.resolve({ examId: exam.id }) },
    );

    expect(res.status).toBe(409);
  });

  it("lists links for the owning lecturer", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await linksRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(200);
    const links = await res.json();
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks a student from listing links (401)", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await linksRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ examId: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("removes a link", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const created = await prisma.ltiExamLink.create({
      data: { examId: exam.id, platformId: platform.id, resourceLinkId: "rl-to-delete" },
    });

    const res = await linkRoute.DELETE(jsonRequest("DELETE"), {
      params: Promise.resolve({ examId: exam.id, linkId: created.id }),
    });
    expect(res.status).toBe(204);

    const stillThere = await prisma.ltiExamLink.findUnique({ where: { id: created.id } });
    expect(stillThere).toBeNull();
  });
});

describe("pilot readiness privacy boundary", () => {
  it("blocks a student from reading pilot readiness data (401)", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await pilotReadinessRoute.GET();
    expect(res.status).toBe(401);
  });

  it("returns a structured readiness object for a lecturer", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const res = await pilotReadinessRoute.GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("coreExamFlow");
    expect(data).toHaveProperty("canvasLti");
    expect(data).toHaveProperty("integrityAndAnalytics");
    expect(data).toHaveProperty("aiFeatures");
    expect(data).toHaveProperty("deployment");
  });
});
