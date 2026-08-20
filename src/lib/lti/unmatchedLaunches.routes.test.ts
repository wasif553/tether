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
let testInstitutionB: { id: string };

function sessionFor(
  userId: string,
  role: "LECTURER" | "STUDENT",
  institutionId: string = testInstitution.id,
) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
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

// Cross-Tenant Isolation Fix v1 — a second, entirely separate institution,
// used only by the "Cross-institution isolation" describe block below.
let lecturerB: { id: string };
let examB: { id: string };
let platformB: { id: string };
let launchB: { id: string };
let existingLinkB: { id: string };
// A second Institution B launch with NO pre-existing LtiExamLink for its
// resource — used specifically so the D/F tests exercise the CREATE +
// backfill code path (not just the 409-conflict early-return that
// launchB/existingLinkB above would otherwise always take), proving the
// fix closes the write path too, not only the read/existence-oracle path.
let launchB2: { id: string };
const resourceLinkIdB2 = `unmatched-test-rl-b2-${Date.now()}`;
// Deliberately the SAME string as Institution A's resourceLinkId/canvasCourseId
// above (test L) — the fix's correctness must come from the platform
// relation, never from resourceLinkId/canvasCourseId string matching, so a
// superficial collision between two institutions' identifiers must not
// grant any cross-tenant access.
const canvasCourseIdShared = "course-999";

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("unmatched-launches-test");
  testInstitutionB = await getOrCreateTestInstitution("unmatched-launches-test-b");
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
      canvasCourseId: canvasCourseIdShared,
      canvasAssignmentId: "assignment-888",
      resourceLinkId,
      deploymentId: "deployment-777",
      launchRole: "STUDENT",
      launchClaimsJson: { sub: canvasSubject, email: "secret-student@example.com" },
      examId: null,
    },
  });
  launchId = launch.id;

  // Institution B fixtures — a lecturer, exam, platform, and an unmatched
  // launch that deliberately shares its resourceLinkId AND canvasCourseId
  // with Institution A's launch above, plus an existing LtiExamLink already
  // pointing at Institution B's own exam (used to prove Institution A can
  // neither read nor reassign it).
  lecturerB = await prisma.user.create({
    data: { name: "Unmatched Lecturer B", email: `unmatched-lect-b-${Date.now()}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitutionB.id },
  });
  examB = await prisma.exam.create({
    data: { title: "Institution B Exam", durationMins: 30, createdById: lecturerB.id, institutionId: testInstitutionB.id },
  });
  platformB = await prisma.ltiPlatform.create({
    data: {
      issuer: `https://unmatched-test-platform-b-${Date.now()}.example.com`,
      clientId: "test-client-b",
      authEndpoint: "https://example.com/auth",
      tokenEndpoint: "https://example.com/token",
      jwksUrl: "https://example.com/jwks",
      deploymentId: "test-deployment-b",
      institutionId: testInstitutionB.id,
    },
  });
  const launchBRow = await prisma.ltiLaunch.create({
    data: {
      platformId: platformB.id,
      canvasUserId: "canvas-sub-institution-b-0000",
      canvasCourseId: canvasCourseIdShared,
      canvasAssignmentId: "assignment-888",
      resourceLinkId,
      deploymentId: "deployment-777",
      launchRole: "STUDENT",
      examId: null,
    },
  });
  launchB = launchBRow;
  existingLinkB = await prisma.ltiExamLink.create({
    data: {
      examId: examB.id,
      platformId: platformB.id,
      resourceLinkId,
      canvasCourseId: canvasCourseIdShared,
    },
  });

  const launchB2Row = await prisma.ltiLaunch.create({
    data: {
      platformId: platformB.id,
      canvasUserId: "canvas-sub-institution-b-1111",
      canvasCourseId: "institution-b-course-unique",
      canvasAssignmentId: "assignment-unique-b2",
      resourceLinkId: resourceLinkIdB2,
      deploymentId: "deployment-777",
      launchRole: "STUDENT",
      examId: null,
    },
  });
  launchB2 = launchB2Row;
});

afterAll(async () => {
  await prisma.canvasGradePassback.deleteMany({ where: { submission: { studentId: { in: [lecturer.id, student.id, lecturerB.id] } } } });
  await prisma.ltiExamLink.deleteMany({ where: { resourceLinkId: { in: [resourceLinkId, resourceLinkIdB2] } } });
  await prisma.ltiLaunch.deleteMany({ where: { resourceLinkId: { in: [resourceLinkId, resourceLinkIdB2] } } });
  await prisma.exam.deleteMany({ where: { id: { in: [exam.id, examB.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturer.id, student.id, lecturerB.id] } } });
  await prisma.ltiPlatform.deleteMany({ where: { id: platformB.id } });
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

describe("POST /api/lecturer/lti/unmatched-launches/[id]/link — cross-institution isolation (P0 fix)", () => {
  it("J. rejects an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await linkRoute.POST(jsonRequest("POST", { examId: exam.id }), {
      params: Promise.resolve({ id: launchB.id }),
    });
    expect(res.status).toBe(401);
  });

  it("I. rejects a STUDENT caller", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT"));

    const res = await linkRoute.POST(jsonRequest("POST", { examId: exam.id }), {
      params: Promise.resolve({ id: launchB.id }),
    });
    expect(res.status).toBe(401);
  });

  it("B, C & L. a lecturer from Institution A cannot link a launch belonging to Institution B, even supplying an exam they legitimately own — and gets the exact same response as a nonexistent launch id (identifiers deliberately collide with Institution A's own launch)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const crossTenantRes = await linkRoute.POST(jsonRequest("POST", { examId: exam.id }), {
      params: Promise.resolve({ id: launchB.id }),
    });
    const crossTenantBody = await crossTenantRes.json();

    const nonexistentRes = await linkRoute.POST(jsonRequest("POST", { examId: exam.id }), {
      params: Promise.resolve({ id: "definitely-not-a-real-launch-id" }),
    });
    const nonexistentBody = await nonexistentRes.json();

    expect(crossTenantRes.status).toBe(404);
    expect(nonexistentRes.status).toBe(404);
    expect(crossTenantBody).toEqual(nonexistentBody);
  });

  it("D & F. the rejected cross-institution attempt creates no LtiExamLink and backfills no LtiLaunch row", async () => {
    // Uses launchB2 specifically — it has NO pre-existing LtiExamLink, so
    // (against the pre-fix vulnerable code) this exercises the CREATE +
    // backfill branch, not the 409-conflict early-return that launchB
    // above would take. This proves the fix closes the write path, not
    // only the read/existence-oracle path already proven above.
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    const linksBefore = await prisma.ltiExamLink.count({ where: { platformId: platformB.id } });

    const res = await linkRoute.POST(jsonRequest("POST", { examId: exam.id }), {
      params: Promise.resolve({ id: launchB2.id }),
    });
    expect(res.status).toBe(404);

    const linksAfter = await prisma.ltiExamLink.count({ where: { platformId: platformB.id } });
    expect(linksAfter).toBe(linksBefore);

    const freshLaunchB2 = await prisma.ltiLaunch.findUnique({ where: { id: launchB2.id } });
    expect(freshLaunchB2?.examId).toBeNull();
  });

  it("E. the rejected cross-institution attempt does not modify Institution B's existing LtiExamLink", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));

    await linkRoute.POST(jsonRequest("POST", { examId: exam.id }), {
      params: Promise.resolve({ id: launchB.id }),
    });

    const freshLink = await prisma.ltiExamLink.findUnique({ where: { id: existingLinkB.id } });
    expect(freshLink?.examId).toBe(examB.id);
  });

  it("K. a lecturer cannot link using an exam owned by a different lecturer in their OWN institution", async () => {
    const otherLecturerSameInstitution = await prisma.user.create({
      data: {
        name: "Other Lecturer Same Institution",
        email: `unmatched-lect-other-${Date.now()}@test.local`,
        passwordHash: await bcrypt.hash("test-password", 4),
        role: "LECTURER",
        institutionId: testInstitution.id,
      },
    });
    const otherLecturerExam = await prisma.exam.create({
      data: { title: "Not Caller's Exam", durationMins: 30, createdById: otherLecturerSameInstitution.id, institutionId: testInstitution.id },
    });

    // Uses launchId (Institution A's own launch, this lecturer's own
    // institution) so this test isolates the exam-ownership check —
    // launch-level tenant scoping is not what's under test here (that's
    // covered by the B/C/D/E/F/L tests above, which use launchB).
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER"));
    const res = await linkRoute.POST(jsonRequest("POST", { examId: otherLecturerExam.id }), {
      params: Promise.resolve({ id: launchId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Exam not found");

    await prisma.exam.delete({ where: { id: otherLecturerExam.id } });
    await prisma.user.delete({ where: { id: otherLecturerSameInstitution.id } });
  });

  it("Institution B's own lecturer can still link Institution B's own launch normally (fix does not break same-tenant linking)", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", testInstitutionB.id));

    // existingLinkB already points launchB's resource at examB — same
    // resource, same exam is the idempotent case (mirrors test G above,
    // proven independently for Institution B).
    const res = await linkRoute.POST(jsonRequest("POST", { examId: examB.id }), {
      params: Promise.resolve({ id: launchB.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.examId).toBe(examB.id);
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
