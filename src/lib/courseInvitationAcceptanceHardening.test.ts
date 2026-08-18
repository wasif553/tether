/**
 * Tether Course Invitation + Acceptance v1 — hardening pass. See
 * docs/tether-course-invitation-acceptance-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Covers two defects found during review before manual Preview QA:
 *  1. Stale JWT session after acceptance — src/auth.ts's applyJwtUpdate.
 *  2. Cross-institution User-row race — the accept route's atomic
 *     User-row claim.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { applyJwtUpdate } = await import("./sessionRefresh");
const {
  generateCourseInvitationToken,
  hashCourseInvitationToken,
  COURSE_INVITATION_EXPIRY_MS,
} = await import("./courseInvitationToken");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string | null) {
  return {
    user: { id: userId, email: `${userId}@test.invalid`, name: "Test", role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

function jsonRequest(body?: unknown, method = "POST") {
  return new Request("http://localhost/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupCourseIds: string[] = [];

async function createUser(email: string, role: "LECTURER" | "STUDENT", institutionId: string | null) {
  const passwordHash = await bcrypt.hash("password", 4);
  const u = await prisma.user.create({ data: { name: "Test", email, passwordHash, role, institutionId } });
  cleanupUserIds.push(u.id);
  return u;
}

async function createCourse(institutionId: string, code: string) {
  const c = await prisma.course.create({ data: { institutionId, name: `Course ${code}`, code } });
  cleanupCourseIds.push(c.id);
  return c;
}

async function createInvitationRow(opts: { courseId: string; studentId: string; invitedById: string }) {
  const token = generateCourseInvitationToken();
  const invitation = await prisma.courseEnrollmentInvitation.create({
    data: {
      courseId: opts.courseId,
      studentId: opts.studentId,
      invitedById: opts.invitedById,
      tokenHash: hashCourseInvitationToken(token),
      expiresAt: new Date(Date.now() + COURSE_INVITATION_EXPIRY_MS),
    },
  });
  return { invitation, token };
}

let instA: string;
let instB: string;
let lecturerA: string;
let lecturerB: string;
let courseA: string;
let courseB: string;

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`ci-hardening-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`ci-hardening-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  lecturerA = (await createUser(`hard-lect-a-${stamp}@test.invalid`, "LECTURER", instA)).id;
  lecturerB = (await createUser(`hard-lect-b-${stamp}@test.invalid`, "LECTURER", instB)).id;

  const cA = await createCourse(instA, `HARD-A-${stamp}`);
  courseA = cA.id;
  await prisma.courseEnrollment.create({ data: { courseId: courseA, userId: lecturerA, role: "LECTURER" } });

  const cB = await createCourse(instB, `HARD-B-${stamp}`);
  courseB = cB.id;
  await prisma.courseEnrollment.create({ data: { courseId: courseB, userId: lecturerB, role: "LECTURER" } });
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  await prisma.courseEnrollmentInvitation.deleteMany({ where: { courseId: { in: cleanupCourseIds } } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: cleanupCourseIds } } });
  await prisma.course.deleteMany({ where: { id: { in: cleanupCourseIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

// ── Defect 1: stale JWT session after acceptance ──────────────────────────

describe("src/auth.ts applyJwtUpdate — session refresh after acceptance", () => {
  it("a self-service student's token starts with institutionId null", async () => {
    const student = await createUser(`sess-a-${stamp}@test.invalid`, "STUDENT", null);
    expect(student.institutionId).toBeNull();
  });

  it("acceptance changes DB institutionId, and an explicit session update reloads it", async () => {
    const student = await createUser(`sess-b-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    expect((await res.json()).ok).toBe(true);

    // The token this browser session was minted with still says null —
    // simulates the exact stale-JWT scenario the defect described.
    const staleToken = { id: student.id, role: "STUDENT", institutionId: null };
    const refreshed = await applyJwtUpdate({ ...staleToken }, "update");
    expect(refreshed.institutionId).toBe(instA);
  });

  it("client-supplied fake institutionId cannot override DB truth", async () => {
    const student = await createUser(`sess-c-${stamp}@test.invalid`, "STUDENT", null);
    // A token object already carrying a forged institutionId (simulating
    // a tampered/pre-existing claim) — applyJwtUpdate must overwrite it
    // with the database's actual value regardless, since it never reads
    // institutionId from its input, only `id`.
    const forgedToken = { id: student.id, role: "STUDENT", institutionId: "forged-institution-id" };
    const refreshed = await applyJwtUpdate(forgedToken, "update");
    expect(refreshed.institutionId).toBeNull();
    expect(refreshed.institutionId).not.toBe("forged-institution-id");
  });

  it("ordinary (non-update) requests never touch the database or change the token", async () => {
    const student = await createUser(`sess-d-${stamp}@test.invalid`, "STUDENT", null);
    // Institution changes in the DB after this token was minted...
    await prisma.user.update({ where: { id: student.id }, data: { institutionId: instA } });
    const token = { id: student.id, role: "STUDENT", institutionId: null };
    // ...but an ordinary request (trigger undefined, exactly what a
    // normal page load produces) must not silently refresh it — that
    // would defeat the "only on explicit update" narrowness requirement.
    const result = await applyJwtUpdate({ ...token }, undefined);
    expect(result.institutionId).toBeNull();
    expect(result).toEqual(token);
  });

  it("sign-in trigger is also left untouched by applyJwtUpdate (handled by the jwt callback's own user branch instead)", async () => {
    const token = { id: "irrelevant", role: "STUDENT", institutionId: "whatever-was-there" };
    const result = await applyJwtUpdate({ ...token }, "signIn");
    expect(result).toEqual(token);
  });

  it("immediate post-accept exam visibility reflects the refreshed institutionId, no logout/login required", async () => {
    const student = await createUser(`sess-e-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });

    // Simulates what the client does immediately after a successful
    // accept: call the session update, which re-derives institutionId
    // from the database via applyJwtUpdate, then use THAT value for the
    // very next request — never the stale pre-acceptance session.
    const refreshed = await applyJwtUpdate({ id: student.id, role: "STUDENT", institutionId: null }, "update");

    const exam = await prisma.exam.create({
      data: { title: `Hardening exam ${stamp}`, durationMins: 60, published: true, createdById: lecturerA, institutionId: instA, courseId: courseA, assignmentMode: "COURSE" },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", refreshed.institutionId as string | null));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const exams = await res.json();
    expect(exams.some((e: { id: string }) => e.id === exam.id)).toBe(true);

    await prisma.exam.delete({ where: { id: exam.id } });
  });
});

// ── Defect 2: cross-institution User-row race ─────────────────────────────

describe("Cross-institution User-row race — concurrent acceptance of two different institutions' invitations", () => {
  it("exactly one institution wins; the other rolls back entirely, with a consistent final state", async () => {
    const student = await createUser(`race-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation: invA, token: tokenA } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    const { invitation: invB, token: tokenB } = await createInvitationRow({ courseId: courseB, studentId: student.id, invitedById: lecturerB });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");

    const [resA, resB] = await Promise.all([
      accept(jsonRequest(), { params: Promise.resolve({ invitationId: invA.id, token: tokenA }) }),
      accept(jsonRequest(), { params: Promise.resolve({ invitationId: invB.id, token: tokenB }) }),
    ]);
    const bodyA = await resA.json();
    const bodyB = await resB.json();

    // Exactly one of the two succeeded.
    const outcomes = [bodyA, bodyB];
    const successes = outcomes.filter((b) => b.ok === true);
    const failures = outcomes.filter((b) => b.ok === false);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBe("different_institution");

    const winnerIsA = bodyA.ok === true;
    const winningInstitution = winnerIsA ? instA : instB;
    const losingCourse = winnerIsA ? courseB : courseA;
    const winningCourse = winnerIsA ? courseA : courseB;

    // User.institutionId equals the winning institution, and can never
    // have been overwritten to the other one afterward (nothing else in
    // this test touches it).
    const freshStudent = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(freshStudent.institutionId).toBe(winningInstitution);

    // CourseEnrollment exists ONLY for the winning course.
    const winningEnrollment = await prisma.courseEnrollment.findUnique({
      where: { courseId_userId: { courseId: winningCourse, userId: student.id } },
    });
    expect(winningEnrollment).not.toBeNull();
    const losingEnrollment = await prisma.courseEnrollment.findUnique({
      where: { courseId_userId: { courseId: losingCourse, userId: student.id } },
    });
    expect(losingEnrollment).toBeNull();

    // The losing invitation rolled back entirely — still pending, not
    // incorrectly marked accepted.
    const losingInvitation = await prisma.courseEnrollmentInvitation.findUniqueOrThrow({
      where: { id: winnerIsA ? invB.id : invA.id },
    });
    expect(losingInvitation.acceptedAt).toBeNull();
    expect(losingInvitation.tokenHash).not.toBeNull();

    // The winning invitation is correctly marked accepted.
    const winningInvitation = await prisma.courseEnrollmentInvitation.findUniqueOrThrow({
      where: { id: winnerIsA ? invA.id : invB.id },
    });
    expect(winningInvitation.acceptedAt).not.toBeNull();
    expect(winningInvitation.tokenHash).toBeNull();

    // Audit state is consistent: exactly one accepted-invitation audit
    // entry exists, for the winning invitation only.
    const logs = await prisma.platformAuditLog.findMany({
      where: { targetId: { in: [invA.id, invB.id] }, action: "course.invitation_accepted" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].targetId).toBe(winnerIsA ? invA.id : invB.id);
  });
});
