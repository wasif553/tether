/**
 * Self-Service Account Onboarding v1 — DB-backed route tests. See
 * docs/self-service-account-onboarding-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const signupRoute = await import("../app/api/signup/route");
const availableRoute = await import("../app/api/exams/available/route");
const accessCheckRoute = await import("../app/api/exams/[id]/access-check/route");
const inviteLecturerRoute = await import("../app/api/platform/institutions/[id]/invite-lecturer/route");
const inviteStudentRoute = await import("../app/api/platform/institutions/[id]/invite-student/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string | null) {
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
const createdUserIds: string[] = [];
const createdInstitutionIds: string[] = [];

let instA: { id: string };
let lecturerA: { id: string };
let platformAdmin: { id: string };
let studentInInstA: { id: string };

beforeAll(async () => {
  instA = await getOrCreateTestInstitution(`self-service-onboarding-a-${stamp}`);
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "SSO Lecturer A", email: `sso-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA.id },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "SSO Platform Admin", email: `sso-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: instA.id },
  });
  studentInInstA = await prisma.user.create({
    data: { name: "SSO Student In Inst", email: `sso-stud-inst-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA.id },
  });
  createdUserIds.push(lecturerA.id, platformAdmin.id, studentInInstA.id);
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { OR: [{ actorId: { in: createdUserIds } }, { institutionId: { in: createdInstitutionIds } }] } });
  await prisma.exam.deleteMany({ where: { createdById: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.institution.deleteMany({ where: { id: { in: createdInstitutionIds } } });
});

describe("1-12. STUDENT self-signup — POST /api/signup", () => {
  it("1. anonymous STUDENT signup succeeds", async () => {
    const email = `student-signup-${stamp}-a@example.com`;
    const res = await signupRoute.POST(jsonRequest({ name: "New Student", email, password: "password123", role: "STUDENT" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    createdUserIds.push(body.id);
  });

  it("2. email is normalized to lowercase", async () => {
    const email = `Student-Signup-${stamp}-B@Example.com`;
    const res = await signupRoute.POST(jsonRequest({ name: "New Student", email, password: "password123", role: "STUDENT" }));
    const body = await res.json();
    createdUserIds.push(body.id);
    expect(body.email).toBe(email.toLowerCase());
    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    expect(dbUser?.email).toBe(email.toLowerCase());
  });

  it("3. bcrypt hash is stored, plaintext password is never stored", async () => {
    const email = `student-signup-${stamp}-c@example.com`;
    const password = "correct-horse-battery";
    const res = await signupRoute.POST(jsonRequest({ name: "New Student", email, password, role: "STUDENT" }));
    const body = await res.json();
    createdUserIds.push(body.id);
    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    expect(dbUser?.passwordHash).not.toBe(password);
    expect(await bcrypt.compare(password, dbUser!.passwordHash)).toBe(true);
  });

  it("4/5. role is exactly STUDENT and institutionId is null", async () => {
    const email = `student-signup-${stamp}-d@example.com`;
    const res = await signupRoute.POST(jsonRequest({ name: "New Student", email, password: "password123", role: "STUDENT" }));
    const body = await res.json();
    createdUserIds.push(body.id);
    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    expect(dbUser?.role).toBe("STUDENT");
    expect(dbUser?.institutionId).toBeNull();
  });

  it("6/7. no institution is created, and no default-institution assignment occurs", async () => {
    const institutionCountBefore = await prisma.institution.count();
    const email = `student-signup-${stamp}-e@example.com`;
    const res = await signupRoute.POST(jsonRequest({ name: "New Student", email, password: "password123", role: "STUDENT" }));
    const body = await res.json();
    createdUserIds.push(body.id);
    const institutionCountAfter = await prisma.institution.count();
    expect(institutionCountAfter).toBe(institutionCountBefore);
    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    expect(dbUser?.institutionId).toBeNull();
  });

  it("8. duplicate email returns 409", async () => {
    const email = `student-signup-${stamp}-f@example.com`;
    const first = await signupRoute.POST(jsonRequest({ name: "First", email, password: "password123", role: "STUDENT" }));
    const firstBody = await first.json();
    createdUserIds.push(firstBody.id);
    const second = await signupRoute.POST(jsonRequest({ name: "Second", email, password: "password123", role: "STUDENT" }));
    expect(second.status).toBe(409);
  });

  it("9. malformed email is rejected with 400", async () => {
    const res = await signupRoute.POST(jsonRequest({ name: "X", email: "not-an-email", password: "password123", role: "STUDENT" }));
    expect(res.status).toBe(400);
  });

  it("10. password under 8 characters is rejected with 400", async () => {
    const res = await signupRoute.POST(
      jsonRequest({ name: "X", email: `student-signup-${stamp}-g@example.com`, password: "short1", role: "STUDENT" }),
    );
    expect(res.status).toBe(400);
  });

  it("11. a caller-supplied institutionId is rejected, not silently ignored", async () => {
    const res = await signupRoute.POST(
      jsonRequest({
        name: "X",
        email: `student-signup-${stamp}-h@example.com`,
        password: "password123",
        role: "STUDENT",
        institutionId: instA.id,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("12. PLATFORM_ADMIN cannot be self-created", async () => {
    const res = await signupRoute.POST(
      jsonRequest({ name: "X", email: `student-signup-${stamp}-i@example.com`, password: "password123", role: "PLATFORM_ADMIN" }),
    );
    expect(res.status).toBe(400);
    const count = await prisma.user.count({ where: { email: `student-signup-${stamp}-i@example.com` } });
    expect(count).toBe(0);
  });
});

describe("13-24. LECTURER self-service workspace — POST /api/signup", () => {
  it("13/15/16/17. anonymous LECTURER signup creates an Institution and a LECTURER belonging to it", async () => {
    const email = `lecturer-signup-${stamp}-a@example.com`;
    const res = await signupRoute.POST(
      jsonRequest({ name: "New Lecturer", email, password: "password123", role: "LECTURER", organisationName: `Signup Org A ${stamp}` }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    createdUserIds.push(body.id);

    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    expect(dbUser?.role).toBe("LECTURER");
    expect(dbUser?.institutionId).not.toBeNull();
    createdInstitutionIds.push(dbUser!.institutionId!);

    const institution = await prisma.institution.findUnique({ where: { id: dbUser!.institutionId! } });
    expect(institution).not.toBeNull();
    expect(institution?.name).toBe(`Signup Org A ${stamp}`);
    expect(institution?.active).toBe(true);
  });

  it("14. organisationName is required for LECTURER — 400 without it", async () => {
    const res = await signupRoute.POST(
      jsonRequest({ name: "X", email: `lecturer-signup-${stamp}-b@example.com`, password: "password123", role: "LECTURER" }),
    );
    expect(res.status).toBe(400);
  });

  it("18. slug is generated server-side from the organisation name — never caller-controlled", async () => {
    const email = `lecturer-signup-${stamp}-c@example.com`;
    const res = await signupRoute.POST(
      jsonRequest({ name: "X", email, password: "password123", role: "LECTURER", organisationName: `Sanitize Me Inc ${stamp}` }),
    );
    const body = await res.json();
    createdUserIds.push(body.id);
    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    createdInstitutionIds.push(dbUser!.institutionId!);
    const institution = await prisma.institution.findUnique({ where: { id: dbUser!.institutionId! } });
    expect(institution?.slug).toMatch(/^sanitize-me-inc-\d+$/);
  });

  it("19. two lecturers signing up with the same organisation name get two DISTINCT institutions, not a shared one", async () => {
    const orgName = `Shared Name University ${stamp}`;
    const emailOne = `lecturer-signup-${stamp}-d1@example.com`;
    const emailTwo = `lecturer-signup-${stamp}-d2@example.com`;

    const resOne = await signupRoute.POST(jsonRequest({ name: "Lecturer One", email: emailOne, password: "password123", role: "LECTURER", organisationName: orgName }));
    const bodyOne = await resOne.json();
    createdUserIds.push(bodyOne.id);
    const resTwo = await signupRoute.POST(jsonRequest({ name: "Lecturer Two", email: emailTwo, password: "password123", role: "LECTURER", organisationName: orgName }));
    const bodyTwo = await resTwo.json();
    createdUserIds.push(bodyTwo.id);

    expect(resOne.status).toBe(201);
    expect(resTwo.status).toBe(201);

    const userOne = await prisma.user.findUnique({ where: { id: bodyOne.id } });
    const userTwo = await prisma.user.findUnique({ where: { id: bodyTwo.id } });
    createdInstitutionIds.push(userOne!.institutionId!, userTwo!.institutionId!);

    expect(userOne!.institutionId).not.toBe(userTwo!.institutionId);
    const instOne = await prisma.institution.findUnique({ where: { id: userOne!.institutionId! } });
    const instTwo = await prisma.institution.findUnique({ where: { id: userTwo!.institutionId! } });
    expect(instOne!.slug).not.toBe(instTwo!.slug);
  });

  it("20. a slug collision on the base slug is handled safely — no 500, a distinct suffixed slug is used", async () => {
    const orgName = `Collision Org ${stamp}`;
    // Pre-occupy the exact base slug the route would generate on attempt 0.
    const collidingSlug = orgName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const preExisting = await prisma.institution.create({ data: { name: "Pre-existing", slug: collidingSlug, plan: "pilot", active: true } });
    createdInstitutionIds.push(preExisting.id);

    const email = `lecturer-signup-${stamp}-e@example.com`;
    const res = await signupRoute.POST(jsonRequest({ name: "X", email, password: "password123", role: "LECTURER", organisationName: orgName }));
    expect(res.status).toBe(201);
    const body = await res.json();
    createdUserIds.push(body.id);

    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    createdInstitutionIds.push(dbUser!.institutionId!);
    expect(dbUser!.institutionId).not.toBe(preExisting.id);
    const institution = await prisma.institution.findUnique({ where: { id: dbUser!.institutionId! } });
    expect(institution?.slug).not.toBe(collidingSlug);
    expect(institution?.slug.startsWith(`${collidingSlug}-`)).toBe(true);
  });

  it("21/22. duplicate lecturer email returns 409, and no orphan institution is created for the rejected attempt", async () => {
    const email = `lecturer-signup-${stamp}-f@example.com`;
    const first = await signupRoute.POST(jsonRequest({ name: "First", email, password: "password123", role: "LECTURER", organisationName: `First Org ${stamp}` }));
    const firstBody = await first.json();
    createdUserIds.push(firstBody.id);
    const firstUser = await prisma.user.findUnique({ where: { id: firstBody.id } });
    createdInstitutionIds.push(firstUser!.institutionId!);

    const institutionCountBefore = await prisma.institution.count();
    const second = await signupRoute.POST(
      jsonRequest({ name: "Second", email, password: "password123", role: "LECTURER", organisationName: `Second Org ${stamp}` }),
    );
    expect(second.status).toBe(409);
    const institutionCountAfter = await prisma.institution.count();
    // The rejected attempt's pre-check fires before the transaction ever
    // runs, so no "Second Org" institution should exist at all.
    expect(institutionCountAfter).toBe(institutionCountBefore);
  });

  it("23. no password or password hash is ever returned in the response", async () => {
    const email = `lecturer-signup-${stamp}-g@example.com`;
    const password = "correct-horse-battery-2";
    const res = await signupRoute.POST(jsonRequest({ name: "X", email, password, role: "LECTURER", organisationName: `Org G ${stamp}` }));
    const body = await res.json();
    createdUserIds.push(body.id);
    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    createdInstitutionIds.push(dbUser!.institutionId!);
    expect(body).not.toHaveProperty("passwordHash");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain(password);
  });

  it("24. the audit log for self-service workspace creation never contains the password", async () => {
    const email = `lecturer-signup-${stamp}-h@example.com`;
    const password = "correct-horse-battery-3";
    const res = await signupRoute.POST(jsonRequest({ name: "X", email, password, role: "LECTURER", organisationName: `Org H ${stamp}` }));
    const body = await res.json();
    createdUserIds.push(body.id);
    const dbUser = await prisma.user.findUnique({ where: { id: body.id } });
    createdInstitutionIds.push(dbUser!.institutionId!);

    const log = await prisma.platformAuditLog.findFirst({
      where: { action: "institution.self_service_create", targetId: dbUser!.institutionId! },
    });
    expect(log).not.toBeNull();
    expect(log?.actorId).toBe(body.id);
    expect(log?.institutionId).toBe(dbUser!.institutionId);
    expect(JSON.stringify(log?.metadata)).not.toContain(password);
    expect(JSON.stringify(log?.metadata)).not.toContain(dbUser!.passwordHash);
  });
});

describe("25-27. Unaffiliated STUDENT dashboard behavior", () => {
  it("25. an authenticated STUDENT with institutionId null gets 200 [] from /api/exams/available", async () => {
    const passwordHash = await bcrypt.hash("test-password", 4);
    const unaffiliated = await prisma.user.create({
      data: { name: "Unaffiliated Student", email: `unaffiliated-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: null },
    });
    createdUserIds.push(unaffiliated.id);

    mockAuth.mockResolvedValue(sessionFor(unaffiliated.id, "STUDENT", null));
    const res = await availableRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("26. an existing institution-linked STUDENT's behavior is unchanged (still sees their institution's published exam)", async () => {
    const exam = await prisma.exam.create({
      data: { title: `Regression Exam ${stamp}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA.id },
    });

    mockAuth.mockResolvedValue(sessionFor(studentInInstA.id, "STUDENT", instA.id));
    const res = await availableRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.find((e: { id: string }) => e.id === exam.id)).toBeDefined();
  });

  it("27. an unaffiliated student opening an existing exam join link gets no_access, with no exam metadata leaked", async () => {
    const passwordHash = await bcrypt.hash("test-password", 4);
    const unaffiliated = await prisma.user.create({
      data: { name: "Unaffiliated Joiner", email: `unaffiliated-join-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: null },
    });
    createdUserIds.push(unaffiliated.id);

    const exam = await prisma.exam.create({
      data: { title: `Deep Link Exam ${stamp}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA.id },
    });

    mockAuth.mockResolvedValue(sessionFor(unaffiliated.id, "STUDENT", null));
    const res = await accessCheckRoute.GET(new Request("http://test.local/route"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: "no_access" });
    expect(JSON.stringify(body)).not.toContain(exam.title);
  });
});

describe("28-32. Regression — existing invited/institution-linked flows and role handling", () => {
  it("28. platform-admin lecturer invite still works exactly as before", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const email = `regression-invite-lecturer-${stamp}@example.com`;
    const res = await inviteLecturerRoute.POST(jsonRequest({ name: "Invited Lecturer", email, password: "temporary-password" }), {
      params: Promise.resolve({ id: instA.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    createdUserIds.push(body.id);
    expect(body.role).toBe("LECTURER");
    expect(body.institutionId).toBe(instA.id);
  });

  it("29. platform-admin student invite still works exactly as before", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA.id));
    const email = `regression-invite-student-${stamp}@example.com`;
    const res = await inviteStudentRoute.POST(jsonRequest({ name: "Invited Student", email, password: "temporary-password" }), {
      params: Promise.resolve({ id: instA.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    createdUserIds.push(body.id);
    expect(body.role).toBe("STUDENT");
    expect(body.institutionId).toBe(instA.id);
  });

  it("30/31. existing institution-linked lecturer and student accounts still authenticate (bcrypt round-trip unchanged)", async () => {
    const dbLecturer = await prisma.user.findUnique({ where: { id: lecturerA.id } });
    const dbStudent = await prisma.user.findUnique({ where: { id: studentInInstA.id } });
    expect(await bcrypt.compare("test-password", dbLecturer!.passwordHash)).toBe(true);
    expect(await bcrypt.compare("test-password", dbStudent!.passwordHash)).toBe(true);
  });

  it("32. role is stamped exactly as requested for both self-service paths, driving correct client-side redirect routing", async () => {
    const studentRes = await signupRoute.POST(
      jsonRequest({ name: "X", email: `role-check-student-${stamp}@example.com`, password: "password123", role: "STUDENT" }),
    );
    const studentBody = await studentRes.json();
    createdUserIds.push(studentBody.id);
    const dbStudent = await prisma.user.findUnique({ where: { id: studentBody.id } });
    expect(dbStudent?.role).toBe("STUDENT");

    const lecturerRes = await signupRoute.POST(
      jsonRequest({ name: "X", email: `role-check-lecturer-${stamp}@example.com`, password: "password123", role: "LECTURER", organisationName: `Role Check Org ${stamp}` }),
    );
    const lecturerBody = await lecturerRes.json();
    createdUserIds.push(lecturerBody.id);
    const dbLecturer = await prisma.user.findUnique({ where: { id: lecturerBody.id } });
    createdInstitutionIds.push(dbLecturer!.institutionId!);
    expect(dbLecturer?.role).toBe("LECTURER");
  });
});
