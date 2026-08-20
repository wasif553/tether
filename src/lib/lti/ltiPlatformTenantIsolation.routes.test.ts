/**
 * LTI P1 Tenant Isolation Hardening v1 — DB-backed route tests for the two
 * confirmed P1 cross-institution findings from the Australian cyber/privacy
 * release audit:
 *
 *   A. GET  /api/lecturer/lti-platforms            — unscoped findMany()
 *   B. POST /api/lecturer/exams/[examId]/lti-links — unscoped platform
 *      findUnique() lookup
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Follows the same two-institution fixture convention as
 * src/lib/lti/unmatchedLaunches.routes.test.ts (the P0 sibling fix).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("../prisma");
const { getOrCreateTestInstitution } = await import("../testInstitution");
const platformsRoute = await import("../../app/api/lecturer/lti-platforms/route");
const linksRoute = await import("../../app/api/lecturer/exams/[examId]/lti-links/route");

function sessionFor(
  userId: string,
  role: "LECTURER" | "STUDENT",
  institutionId: string | null,
) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
}

function jsonRequest(body?: unknown) {
  return new Request("http://test.local/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const stamp = Date.now();
let instA: { id: string };
let instB: { id: string };
let lecturerA: { id: string };
let lecturerA2: { id: string };
let studentA: { id: string };
let lecturerB: { id: string };
let examA: { id: string };
let examA2: { id: string };
let otherLecturerExam: { id: string };
let examB: { id: string };
let platformA: { id: string; issuer: string };
let platformB: { id: string; issuer: string };
let existingLinkB: { id: string };

const resourceLinkIdA = `tenant-a-rl-${stamp}`;
const resourceLinkIdShared = `shared-collision-rl-${stamp}`;

beforeAll(async () => {
  instA = await getOrCreateTestInstitution(`lti-platform-tenant-a-${stamp}`);
  instB = await getOrCreateTestInstitution(`lti-platform-tenant-b-${stamp}`);
  const passwordHash = await bcrypt.hash("test-password", 4);

  lecturerA = await prisma.user.create({
    data: { name: "Tenant Lecturer A", email: `tenant-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA.id },
  });
  lecturerA2 = await prisma.user.create({
    data: { name: "Tenant Lecturer A2", email: `tenant-lect-a2-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA.id },
  });
  studentA = await prisma.user.create({
    data: { name: "Tenant Student A", email: `tenant-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA.id },
  });
  lecturerB = await prisma.user.create({
    data: { name: "Tenant Lecturer B", email: `tenant-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB.id },
  });

  examA = await prisma.exam.create({
    data: { title: "Tenant A Exam", durationMins: 30, createdById: lecturerA.id, institutionId: instA.id },
  });
  examA2 = await prisma.exam.create({
    data: { title: "Tenant A Exam 2", durationMins: 30, createdById: lecturerA.id, institutionId: instA.id },
  });
  otherLecturerExam = await prisma.exam.create({
    data: { title: "Not Lecturer A's Exam", durationMins: 30, createdById: lecturerA2.id, institutionId: instA.id },
  });
  examB = await prisma.exam.create({
    data: { title: "Tenant B Exam", durationMins: 30, createdById: lecturerB.id, institutionId: instB.id },
  });

  platformA = await prisma.ltiPlatform.create({
    data: {
      issuer: `https://tenant-platform-a-${stamp}.example.com`,
      clientId: "test-client-a",
      authEndpoint: "https://example.com/auth",
      tokenEndpoint: "https://example.com/token",
      jwksUrl: "https://example.com/jwks",
      deploymentId: "test-deployment-a",
      institutionId: instA.id,
    },
  });
  platformB = await prisma.ltiPlatform.create({
    data: {
      issuer: `https://tenant-platform-b-${stamp}.example.com`,
      clientId: "test-client-b",
      authEndpoint: "https://example.com/auth",
      tokenEndpoint: "https://example.com/token",
      jwksUrl: "https://example.com/jwks",
      deploymentId: "test-deployment-b",
      institutionId: instB.id,
    },
  });

  // Deliberately the SAME resourceLinkId string institution A will use
  // below (test G/identifier-collision) — proves tenant isolation comes
  // from the platform relation, never from string matching.
  existingLinkB = await prisma.ltiExamLink.create({
    data: { examId: examB.id, platformId: platformB.id, resourceLinkId: resourceLinkIdShared },
  });
});

afterAll(async () => {
  await prisma.ltiExamLink.deleteMany({ where: { platformId: { in: [platformA.id, platformB.id] } } });
  await prisma.exam.deleteMany({ where: { id: { in: [examA.id, examA2.id, otherLecturerExam.id, examB.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturerA.id, lecturerA2.id, studentA.id, lecturerB.id] } } });
  await prisma.ltiPlatform.deleteMany({ where: { id: { in: [platformA.id, platformB.id] } } });
  await prisma.$disconnect();
});

describe("GET /api/lecturer/lti-platforms — tenant isolation", () => {
  it("A & B. a lecturer sees only their own institution's platform, never another institution's", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));

    const res = await platformsRoute.GET();
    expect(res.status).toBe(200);
    const platforms: Array<{ id: string; issuer: string }> = await res.json();

    expect(platforms.some((p) => p.id === platformA.id)).toBe(true);
    expect(platforms.some((p) => p.id === platformB.id)).toBe(false);
  });

  it("C. with platforms registered in both institutions, the returned list contains only the caller's own institution's platforms", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB.id));

    const res = await platformsRoute.GET();
    const platforms: Array<{ id: string; issuer: string }> = await res.json();

    const ids = platforms.map((p) => p.id);
    expect(ids).toContain(platformB.id);
    expect(ids).not.toContain(platformA.id);
  });

  it("D. rejects a STUDENT caller", async () => {
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA.id));

    const res = await platformsRoute.GET();
    expect(res.status).toBe(401);
  });

  it("E. rejects an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await platformsRoute.GET();
    expect(res.status).toBe(401);
  });

  it("F. a lecturer session missing institutionId fails closed via the existing institution-error convention", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", null));

    const res = await platformsRoute.GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Please log in again to continue.");
  });
});

describe("POST /api/lecturer/exams/[examId]/lti-links — tenant isolation", () => {
  it("A. a lecturer can create an LTI link using their own institution's platform and own exam", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));

    const res = await linksRoute.POST(
      jsonRequest({ platformId: platformA.id, resourceLinkId: resourceLinkIdA }),
      { params: Promise.resolve({ examId: examA.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.platformId).toBe(platformA.id);
    expect(body.examId).toBe(examA.id);
  });

  it("H. a legitimate same-tenant conflict (own resource already linked to a different own exam) still returns the existing safe 409", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));

    const res = await linksRoute.POST(
      jsonRequest({ platformId: platformA.id, resourceLinkId: resourceLinkIdA }),
      { params: Promise.resolve({ examId: examA2.id }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("This Canvas resource link is already linked to an exam");
  });

  it("B, C & F. a lecturer cannot use another institution's platformId — gets the identical response as a nonexistent platform id, never the 409 that institution B's own existing link would otherwise trigger", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));

    const crossTenantRes = await linksRoute.POST(
      jsonRequest({ platformId: platformB.id, resourceLinkId: resourceLinkIdShared }),
      { params: Promise.resolve({ examId: examA.id }) },
    );
    const crossTenantBody = await crossTenantRes.json();

    const nonexistentRes = await linksRoute.POST(
      jsonRequest({ platformId: "definitely-not-a-real-platform-id", resourceLinkId: resourceLinkIdShared }),
      { params: Promise.resolve({ examId: examA.id }) },
    );
    const nonexistentBody = await nonexistentRes.json();

    expect(crossTenantRes.status).toBe(400);
    expect(nonexistentRes.status).toBe(400);
    expect(crossTenantBody).toEqual(nonexistentBody);
    expect(crossTenantBody.error).toBe("Unknown Canvas platform");
    // Never the 409 that Institution B's own pre-existing link on this
    // exact resourceLinkId would trigger for a same-tenant caller.
    expect(crossTenantRes.status).not.toBe(409);
  });

  it("D. the rejected cross-institution attempt creates no LtiExamLink on Institution A's platform", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));

    const before = await prisma.ltiExamLink.count({ where: { platformId: platformA.id } });

    await linksRoute.POST(
      jsonRequest({ platformId: platformB.id, resourceLinkId: resourceLinkIdShared }),
      { params: Promise.resolve({ examId: examA.id }) },
    );

    const after = await prisma.ltiExamLink.count({ where: { platformId: platformA.id } });
    expect(after).toBe(before);
  });

  it("E. the rejected cross-institution attempt does not modify Institution B's existing link", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));

    await linksRoute.POST(
      jsonRequest({ platformId: platformB.id, resourceLinkId: resourceLinkIdShared }),
      { params: Promise.resolve({ examId: examA.id }) },
    );

    const fresh = await prisma.ltiExamLink.findUnique({ where: { id: existingLinkB.id } });
    expect(fresh?.examId).toBe(examB.id);
  });

  it("G. the same resourceLinkId string in a different institution remains fully isolated (tenancy comes from the platform relation, not the string)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB.id));

    const res = await linksRoute.POST(
      // Reuses resourceLinkIdA — the exact string Institution A already
      // linked on platformA above — but on Institution B's own platform.
      jsonRequest({ platformId: platformB.id, resourceLinkId: resourceLinkIdA }),
      { params: Promise.resolve({ examId: examB.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.platformId).toBe(platformB.id);
    expect(body.examId).toBe(examB.id);
  });

  it("I. another lecturer's exam (even in the same institution) remains unauthorized", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA.id));

    const res = await linksRoute.POST(
      jsonRequest({ platformId: platformA.id, resourceLinkId: `unauthorized-exam-rl-${stamp}` }),
      { params: Promise.resolve({ examId: otherLecturerExam.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("J. rejects a STUDENT caller", async () => {
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA.id));

    const res = await linksRoute.POST(
      jsonRequest({ platformId: platformA.id, resourceLinkId: `student-rl-${stamp}` }),
      { params: Promise.resolve({ examId: examA.id }) },
    );
    expect(res.status).toBe(401);
  });

  it("K. rejects an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await linksRoute.POST(
      jsonRequest({ platformId: platformA.id, resourceLinkId: `unauth-rl-${stamp}` }),
      { params: Promise.resolve({ examId: examA.id }) },
    );
    expect(res.status).toBe(401);
  });

  it("L. a lecturer session missing institutionId fails closed via the existing institution-error convention", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", null));

    const res = await linksRoute.POST(
      jsonRequest({ platformId: platformA.id, resourceLinkId: `missing-inst-rl-${stamp}` }),
      { params: Promise.resolve({ examId: examA.id }) },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Please log in again to continue.");
  });
});
