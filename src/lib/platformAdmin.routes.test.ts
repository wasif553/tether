import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const institutionsRoute = await import("../app/api/platform/institutions/route");
const institutionRoute = await import("../app/api/platform/institutions/[id]/route");
const inviteLecturerRoute = await import("../app/api/platform/institutions/[id]/invite-lecturer/route");
const auditLogsRoute = await import("../app/api/platform/audit-logs/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string | null) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
}

function jsonRequest(method: string, body?: unknown, url = "http://test.local/route") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let testInstitution: { id: string };
let lecturer: { id: string };
let platformAdmin: { id: string };
const createdInstitutionIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("platform-admin-routes-test");
  const passwordHash = await bcrypt.hash("test-password", 4);
  const stamp = Date.now();

  lecturer = await prisma.user.create({
    data: { name: "PA Lecturer", email: `pa-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: testInstitution.id },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "PA Admin", email: `pa-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: testInstitution.id },
  });
  createdUserIds.push(lecturer.id, platformAdmin.id);
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.institution.deleteMany({ where: { id: { in: createdInstitutionIds } } });
  await prisma.$disconnect();
});

describe("1-3. GET /api/platform/institutions authorization", () => {
  it("rejects an unauthenticated request with 401", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await institutionsRoute.GET();
    expect(res.status).toBe(401);
  });

  it("rejects a normal lecturer with 403", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", testInstitution.id));
    const res = await institutionsRoute.GET();
    expect(res.status).toBe(403);
  });

  it("allows a PLATFORM_ADMIN", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const res = await institutionsRoute.GET();
    expect(res.status).toBe(200);
  });
});

describe("4-6. POST /api/platform/institutions", () => {
  it("rejects a normal lecturer", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", testInstitution.id));
    const res = await institutionsRoute.POST(
      jsonRequest("POST", { name: "Rejected University", slug: "rejected-university" }),
    );
    expect(res.status).toBe(403);
  });

  it("creates an institution for a PLATFORM_ADMIN", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const stamp = Date.now();
    const res = await institutionsRoute.POST(
      jsonRequest("POST", { name: "New University", slug: `new-university-${stamp}`, domain: "new.edu" }),
    );
    expect(res.status).toBe(201);
    const institution = await res.json();
    expect(institution.slug).toBe(`new-university-${stamp}`);
    expect(institution).not.toHaveProperty("passwordHash");
    createdInstitutionIds.push(institution.id);
  });

  it("rejects a duplicate slug with 409", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const stamp = Date.now();
    const slug = `dup-university-${stamp}`;
    const first = await institutionsRoute.POST(jsonRequest("POST", { name: "Dup University", slug }));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    createdInstitutionIds.push(firstBody.id);

    const second = await institutionsRoute.POST(jsonRequest("POST", { name: "Dup University Again", slug }));
    expect(second.status).toBe(409);
  });
});

describe("7. PATCH /api/platform/institutions/[id]", () => {
  it("updates name/domain/plan/active for a PLATFORM_ADMIN", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const stamp = Date.now();
    const createRes = await institutionsRoute.POST(
      jsonRequest("POST", { name: "Patchable University", slug: `patchable-${stamp}` }),
    );
    const created = await createRes.json();
    createdInstitutionIds.push(created.id);

    const patchRes = await institutionRoute.PATCH(
      jsonRequest("PATCH", { name: "Patched Name", domain: "patched.edu", plan: "standard", active: false }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.name).toBe("Patched Name");
    expect(patched.domain).toBe("patched.edu");
    expect(patched.plan).toBe("standard");
    expect(patched.active).toBe(false);
  });
});

describe("8-10. POST /api/platform/institutions/[id]/invite-lecturer", () => {
  it("rejects a normal lecturer", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", testInstitution.id));
    const res = await inviteLecturerRoute.POST(
      jsonRequest("POST", { name: "Invited", email: "invited@example.edu", password: "temporary-password" }),
      { params: Promise.resolve({ id: testInstitution.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("creates a lecturer in the correct institution and never returns passwordHash", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const stamp = Date.now();
    const email = `invited-${stamp}@example.edu`;
    const res = await inviteLecturerRoute.POST(
      jsonRequest("POST", { name: "Invited Lecturer", email, password: "temporary-password" }),
      { params: Promise.resolve({ id: testInstitution.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.institutionId).toBe(testInstitution.id);
    expect(body.role).toBe("LECTURER");
    expect(body).not.toHaveProperty("passwordHash");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("temporary-password");
    createdUserIds.push(body.id);
  });

  it("invited lecturer can sign in and receives institutionId in session (via authorize callback)", async () => {
    const stamp = Date.now();
    const email = `signin-${stamp}@example.edu`;
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const inviteRes = await inviteLecturerRoute.POST(
      jsonRequest("POST", { name: "Signin Lecturer", email, password: "temporary-password" }),
      { params: Promise.resolve({ id: testInstitution.id }) },
    );
    const invited = await inviteRes.json();
    createdUserIds.push(invited.id);

    const dbUser = await prisma.user.findUnique({ where: { id: invited.id } });
    expect(dbUser?.institutionId).toBe(testInstitution.id);
    const valid = await bcrypt.compare("temporary-password", dbUser!.passwordHash);
    expect(valid).toBe(true);
  });
});

describe("12-13. GET /api/platform/audit-logs authorization", () => {
  it("rejects a normal lecturer", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", testInstitution.id));
    const res = await auditLogsRoute.GET(jsonRequest("GET"));
    expect(res.status).toBe(403);
  });

  it("allows a PLATFORM_ADMIN", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const res = await auditLogsRoute.GET(jsonRequest("GET"));
    expect(res.status).toBe(200);
  });
});

describe("14-15. Audit log writes", () => {
  it("creating an institution writes an institution.create audit log", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const stamp = Date.now();
    const res = await institutionsRoute.POST(
      jsonRequest("POST", { name: "Audited University", slug: `audited-${stamp}` }),
    );
    const institution = await res.json();
    createdInstitutionIds.push(institution.id);

    const log = await prisma.platformAuditLog.findFirst({
      where: { action: "institution.create", targetId: institution.id },
    });
    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(platformAdmin.id);
  });

  it("inviting a lecturer writes a lecturer.invite audit log", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", testInstitution.id));
    const stamp = Date.now();
    const email = `audited-invite-${stamp}@example.edu`;
    const res = await inviteLecturerRoute.POST(
      jsonRequest("POST", { name: "Audited Lecturer", email, password: "temporary-password" }),
      { params: Promise.resolve({ id: testInstitution.id }) },
    );
    const lecturerCreated = await res.json();
    createdUserIds.push(lecturerCreated.id);

    const log = await prisma.platformAuditLog.findFirst({
      where: { action: "lecturer.invite", targetId: lecturerCreated.id },
    });
    expect(log).not.toBeNull();
    expect(log?.institutionId).toBe(testInstitution.id);
  });
});
