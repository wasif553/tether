/**
 * Tether Course Invitation + Acceptance v1 — DB-backed route tests. See
 * docs/tether-course-invitation-acceptance-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Covers, grouped to match the feature's own test matrix: Current
 * enrolment (1-7), Invitation creation (8-19), Acceptance (20-36),
 * Cross-institution (37-40), Post-acceptance (41-46), Platform/
 * regression (47), Audit (53-54).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const {
  generateCourseInvitationToken,
  hashCourseInvitationToken,
  COURSE_INVITATION_EXPIRY_MS,
} = await import("./courseInvitationToken");
const { isSafeCourseInvitationCallbackUrl, isSafeAppCallbackUrl } = await import("./safeCallbackUrl");

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
const cleanupExamIds: string[] = [];
const cleanupSubmissionIds: string[] = [];

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

/** Bypasses the API to create a known-shape invitation row directly, for tests that need precise control over token/expiry/revocation state. */
async function createInvitationRow(opts: {
  courseId: string;
  studentId: string;
  invitedById: string;
  token?: string;
  expiresAt?: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
}) {
  const token = opts.token ?? generateCourseInvitationToken();
  const invitation = await prisma.courseEnrollmentInvitation.create({
    data: {
      courseId: opts.courseId,
      studentId: opts.studentId,
      invitedById: opts.invitedById,
      tokenHash: hashCourseInvitationToken(token),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + COURSE_INVITATION_EXPIRY_MS),
      acceptedAt: opts.acceptedAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    },
  });
  return { invitation, token };
}

let instA: string;
let instB: string;
let lecturerA: string;
let lecturerAOther: string;
let lecturerB: string;
let courseA: string;

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`course-invite-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`course-invite-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  lecturerA = (await createUser(`lect-ci-a-${stamp}@test.invalid`, "LECTURER", instA)).id;
  lecturerAOther = (await createUser(`lect-ci-a-other-${stamp}@test.invalid`, "LECTURER", instA)).id;
  lecturerB = (await createUser(`lect-ci-b-${stamp}@test.invalid`, "LECTURER", instB)).id;

  const course = await createCourse(instA, `CI-${stamp}`);
  courseA = course.id;
  await prisma.courseEnrollment.create({ data: { courseId: courseA, userId: lecturerA, role: "LECTURER" } });
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  await prisma.examTimeAccommodation.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.examAssignment.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.submission.deleteMany({ where: { id: { in: cleanupSubmissionIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.courseEnrollmentInvitation.deleteMany({ where: { courseId: { in: cleanupCourseIds } } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: cleanupCourseIds } } });
  await prisma.course.deleteMany({ where: { id: { in: cleanupCourseIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

// ── Current enrolment behavior (1-7) ─────────────────────────────────────

describe("POST /api/courses/[id]/enrolments — current enrolment behavior", () => {
  it("1. same-institution student still enrols directly", async () => {
    const student = await createUser(`ce1-${stamp}@test.invalid`, "STUDENT", instA);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/enrolments/route");
    const res = await POST(jsonRequest({ email: student.email, role: "STUDENT" }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("enrolled");
    const enrollment = await prisma.courseEnrollment.findUnique({ where: { courseId_userId: { courseId: courseA, userId: student.id } } });
    expect(enrollment?.role).toBe("STUDENT");
  });

  it("2. already-enrolled same-institution student stays idempotent", async () => {
    const student = await createUser(`ce2-${stamp}@test.invalid`, "STUDENT", instA);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/enrolments/route");
    await POST(jsonRequest({ email: student.email, role: "STUDENT" }), { params: Promise.resolve({ id: courseA }) });
    const res2 = await POST(jsonRequest({ email: student.email, role: "STUDENT" }), { params: Promise.resolve({ id: courseA }) });
    expect(res2.status).toBe(201);
    const count = await prisma.courseEnrollment.count({ where: { courseId: courseA, userId: student.id } });
    expect(count).toBe(1);
  });

  it("3. non-STUDENT target rejected", async () => {
    const otherLecturer = await createUser(`ce3-${stamp}@test.invalid`, "LECTURER", instA);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/enrolments/route");
    const res = await POST(jsonRequest({ email: otherLecturer.email, role: "STUDENT" }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NOT_A_STUDENT");
  });

  it("4. unknown email returns STUDENT_NOT_FOUND", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/enrolments/route");
    const res = await POST(jsonRequest({ email: `no-such-user-${stamp}@test.invalid`, role: "STUDENT" }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("STUDENT_NOT_FOUND");
  });

  it("5. different-institution student rejected", async () => {
    const student = await createUser(`ce5-${stamp}@test.invalid`, "STUDENT", instB);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/enrolments/route");
    const res = await POST(jsonRequest({ email: student.email, role: "STUDENT" }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DIFFERENT_INSTITUTION");
    const enrolled = await prisma.courseEnrollment.findUnique({ where: { courseId_userId: { courseId: courseA, userId: student.id } } });
    expect(enrolled).toBeNull();
  });

  it("6. null-institution student is NOT silently changed/enrolled", async () => {
    const student = await createUser(`ce6-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/enrolments/route");
    await POST(jsonRequest({ email: student.email, role: "STUDENT" }), { params: Promise.resolve({ id: courseA }) });
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(fresh.institutionId).toBeNull();
    const enrolled = await prisma.courseEnrollment.findUnique({ where: { courseId_userId: { courseId: courseA, userId: student.id } } });
    expect(enrolled).toBeNull();
  });

  it("7. null-institution state returns INVITATION_REQUIRED", async () => {
    const student = await createUser(`ce7-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/enrolments/route");
    const res = await POST(jsonRequest({ email: student.email, role: "STUDENT" }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("INVITATION_REQUIRED");
    expect(body.student.id).toBe(student.id);
  });
});

// ── Invitation creation (8-19) ───────────────────────────────────────────

describe("POST /api/courses/[id]/invitations — creation/regeneration", () => {
  it("8. authorized course lecturer can create invitation", async () => {
    const student = await createUser(`ic8-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invitationUrl).toMatch(new RegExp(`^/student/course-invitations/${body.invitationId}/[A-Za-z0-9_-]+$`));
  });

  it("9a. a lecturer from a different institution cannot create an invitation (cross-tenant)", async () => {
    const student = await createUser(`ic9a-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerB, "LECTURER", instB));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(403);
  });

  it("9b. a same-institution lecturer NOT teaching this course cannot create an invitation", async () => {
    const student = await createUser(`ic9b-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerAOther, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(403);
  });

  it("10. a STUDENT caller cannot create an invitation", async () => {
    mockAuth.mockResolvedValue(sessionFor(`some-student-${stamp}`, "STUDENT", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: `x-${stamp}@test.invalid` }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(403);
  });

  it("11. invitation is bound to the exact existing studentId, never a raw email string", async () => {
    const student = await createUser(`ic11-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    const body = await res.json();
    const row = await prisma.courseEnrollmentInvitation.findUniqueOrThrow({ where: { id: body.invitationId } });
    expect(row.studentId).toBe(student.id);
  });

  it("12. target must be STUDENT — a lecturer email is rejected", async () => {
    const otherLecturer = await createUser(`ic12-${stamp}@test.invalid`, "LECTURER", instA);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: otherLecturer.email }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NOT_A_STUDENT");
  });

  it("13. target must currently have institutionId null — same-institution student rejected here (use direct enrolment instead)", async () => {
    const student = await createUser(`ic13-${stamp}@test.invalid`, "STUDENT", instA);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ALREADY_SAME_INSTITUTION");
  });

  it("14. plaintext token is never stored in the database", async () => {
    const student = await createUser(`ic14-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    const body = await res.json();
    const plaintext = body.invitationUrl.split("/").pop();
    const row = await prisma.courseEnrollmentInvitation.findUniqueOrThrow({ where: { id: body.invitationId } });
    expect(row.tokenHash).not.toBe(plaintext);
    expect(JSON.stringify(row)).not.toContain(plaintext);
  });

  it("15. token hash is never exposed via GET /api/courses/[id]/invitations", async () => {
    const student = await createUser(`ic15-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    const { GET } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: courseA }) });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("tokenHash");
  });

  it("16. token has strong entropy (>= 32 URL-safe characters)", async () => {
    const student = await createUser(`ic16-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const res = await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    const body = await res.json();
    const token = body.invitationUrl.split("/").pop();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it("17. expiry is set to the fixed v1 duration (~7 days)", async () => {
    const student = await createUser(`ic17-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const before = Date.now();
    const res = await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) });
    const body = await res.json();
    const expiresAtMs = new Date(body.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThan(before + COURSE_INVITATION_EXPIRY_MS - 60_000);
    expect(expiresAtMs).toBeLessThan(before + COURSE_INVITATION_EXPIRY_MS + 60_000);
  });

  it("18. regeneration invalidates the old token — old fails, new succeeds", async () => {
    const student = await createUser(`ic18-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const first = await (await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) })).json();
    const oldToken = first.invitationUrl.split("/").pop();
    const second = await (await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) })).json();
    const newToken = second.invitationUrl.split("/").pop();
    expect(second.invitationId).toBe(first.invitationId);
    expect(newToken).not.toBe(oldToken);

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const oldRes = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: first.invitationId, token: oldToken }) });
    expect((await oldRes.json()).ok).toBe(false);
    const newRes = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: first.invitationId, token: newToken }) });
    expect((await newRes.json()).ok).toBe(true);
  });

  it("19. revoke blocks acceptance", async () => {
    const student = await createUser(`ic19-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/courses/[id]/invitations/route");
    const created = await (await POST(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) })).json();
    const token = created.invitationUrl.split("/").pop();

    const { DELETE } = await import("@/app/api/courses/[id]/invitations/[invitationId]/route");
    const revokeRes = await DELETE(jsonRequest(undefined, "DELETE"), { params: Promise.resolve({ id: courseA, invitationId: created.invitationId }) });
    expect(revokeRes.status).toBe(200);

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: created.invitationId, token }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("revoked");
  });
});

// ── Acceptance (20-36) ────────────────────────────────────────────────────

describe("GET preview + POST accept — /api/course-invitations/[invitationId]/[token]", () => {
  it("20. correct invited student can accept", async () => {
    const student = await createUser(`acc20-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    expect((await res.json()).ok).toBe(true);
  });

  it("21. a different logged-in student cannot accept a forwarded link", async () => {
    const student = await createUser(`acc21-${stamp}@test.invalid`, "STUDENT", null);
    const otherStudent = await createUser(`acc21b-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(otherStudent.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("wrong_account");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: otherStudent.id } });
    expect(fresh.institutionId).toBeNull();
  });

  it("22. isSafeCourseInvitationCallbackUrl accepts the invitation path and rejects malformed variants (open-redirect guard)", () => {
    expect(isSafeCourseInvitationCallbackUrl("/student/course-invitations/abc123/tok-abc_DEF")).toBe(true);
    expect(isSafeAppCallbackUrl("/student/course-invitations/abc123/tok-abc_DEF")).toBe(true);
    expect(isSafeCourseInvitationCallbackUrl("https://evil.example.com/student/course-invitations/abc/tok")).toBe(false);
    expect(isSafeCourseInvitationCallbackUrl("//evil.example.com")).toBe(false);
    expect(isSafeCourseInvitationCallbackUrl("/student/course-invitations/abc/tok?redirect=evil")).toBe(false);
    expect(isSafeCourseInvitationCallbackUrl(null)).toBe(false);
  });

  it("23 & 24. GET preview never mutates — invitation stays pending and unaccepted after repeated preview calls", async () => {
    const student = await createUser(`acc24-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { GET } = await import("@/app/api/course-invitations/[invitationId]/[token]/route");
    await GET(new Request("http://localhost"), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    await GET(new Request("http://localhost"), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    const fresh = await prisma.courseEnrollmentInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(fresh.acceptedAt).toBeNull();
    const student2 = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(student2.institutionId).toBeNull();
  });

  it("25. wrong token denied", async () => {
    const student = await createUser(`acc25-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token: "totally-wrong-token" }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("invalid");
  });

  it("26. expired token denied", async () => {
    const student = await createUser(`acc26-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({
      courseId: courseA, studentId: student.id, invitedById: lecturerA,
      expiresAt: new Date(Date.now() - 60_000),
    });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("expired");
  });

  it("27. revoked token denied", async () => {
    const student = await createUser(`acc27-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({
      courseId: courseA, studentId: student.id, invitedById: lecturerA,
      revokedAt: new Date(),
    });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("revoked");
  });

  it("28 & 29. acceptance sets institutionId null -> course institution AND creates CourseEnrollment STUDENT", async () => {
    const student = await createUser(`acc28-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(fresh.institutionId).toBe(instA);
    const enrollment = await prisma.courseEnrollment.findUniqueOrThrow({ where: { courseId_userId: { courseId: courseA, userId: student.id } } });
    expect(enrollment.role).toBe("STUDENT");
  });

  it("31 & 32. invitation marked accepted and tokenHash cleared (no longer usable)", async () => {
    const student = await createUser(`acc31-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });

    const fresh = await prisma.courseEnrollmentInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(fresh.acceptedAt).not.toBeNull();
    expect(fresh.tokenHash).toBeNull();
  });

  it("33. repeated acceptance by the SAME student is safe/idempotent", async () => {
    const student = await createUser(`acc33-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const first = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    expect((await first.json()).ok).toBe(true);
    const second = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    expect((await second.json()).ok).toBe(true);

    const count = await prisma.courseEnrollment.count({ where: { courseId: courseA, userId: student.id } });
    expect(count).toBe(1);
  });

  it("34. concurrent acceptance is safe — exactly one CourseEnrollment results", async () => {
    const student = await createUser(`acc34-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const [r1, r2] = await Promise.all([
      accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) }),
      accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) }),
    ]);
    expect((await r1.json()).ok).toBe(true);
    expect((await r2.json()).ok).toBe(true);
    const count = await prisma.courseEnrollment.count({ where: { courseId: courseA, userId: student.id } });
    expect(count).toBe(1);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(fresh.institutionId).toBe(instA);
  });

  it("35. a token invalidated by regeneration-vs-accept race is rejected, never accepted", async () => {
    const student = await createUser(`acc35-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token: staleToken } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    // Simulates a lecturer regenerating between the student loading the
    // page and clicking Accept — the row's tokenHash changes underneath
    // the stale token the student's browser still holds.
    await prisma.courseEnrollmentInvitation.update({
      where: { id: invitation.id },
      data: { tokenHash: hashCourseInvitationToken(generateCourseInvitationToken()) },
    });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token: staleToken }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(fresh.institutionId).toBeNull();
  });

  it("36. a token invalidated by revoke-vs-accept race is rejected, never accepted", async () => {
    const student = await createUser(`acc36-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    // Simulates a lecturer revoking between page load and Accept.
    await prisma.courseEnrollmentInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("revoked");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(fresh.institutionId).toBeNull();
  });
});

// ── Cross-institution (37-40) ─────────────────────────────────────────────

describe("Cross-institution conflict during acceptance", () => {
  it("37-40. if the student became linked to a different institution before acceptance, the whole transaction rolls back with no leak", async () => {
    const student = await createUser(`xi37-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });

    // Student became linked to instB (e.g. accepted a different
    // institution's invitation, or was directly enrolled there) after
    // this invitation was created but before they accepted it.
    await prisma.user.update({ where: { id: student.id }, data: { institutionId: instB } });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instB));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    const res = await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.reason).toBe("different_institution");
    // 40. does not leak the other institution's identity.
    expect(JSON.stringify(body)).not.toContain(instA);
    expect(JSON.stringify(body).toLowerCase()).not.toContain("course-invite-a");

    // 38/39. no enrolment created, no institution overwrite.
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(fresh.institutionId).toBe(instB);
    const enrolled = await prisma.courseEnrollment.findUnique({ where: { courseId_userId: { courseId: courseA, userId: student.id } } });
    expect(enrolled).toBeNull();
    // The invitation itself must be left exactly as it was (still
    // pending) — the transaction rolled back the claim too.
    const freshInvitation = await prisma.courseEnrollmentInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(freshInvitation.acceptedAt).toBeNull();

    // Cleanup: this test intentionally moves the student to instB.
    await prisma.user.update({ where: { id: student.id }, data: { institutionId: null } });
  });
});

// ── Post-acceptance (41-46) ────────────────────────────────────────────────

describe("Post-acceptance course exam visibility and removal semantics", () => {
  it("41. a COURSE-mode exam becomes visible under existing rules after acceptance", async () => {
    const student = await createUser(`pa41-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });

    const exam = await prisma.exam.create({
      data: { title: `PA41 Exam ${stamp}`, durationMins: 60, published: true, createdById: lecturerA, institutionId: instA, courseId: courseA, assignmentMode: "COURSE" },
    });
    cleanupExamIds.push(exam.id);

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const exams = await res.json();
    expect(exams.some((e: { id: string }) => e.id === exam.id)).toBe(true);
  });

  it("45 & 46. removing a CourseEnrollment does not clear User.institutionId and preserves Submission history", async () => {
    const student = await createUser(`pa45-${stamp}@test.invalid`, "STUDENT", null);
    const { invitation, token } = await createInvitationRow({ courseId: courseA, studentId: student.id, invitedById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    await accept(jsonRequest(), { params: Promise.resolve({ invitationId: invitation.id, token }) });

    const exam = await prisma.exam.create({
      data: { title: `PA45 Exam ${stamp}`, durationMins: 60, published: true, createdById: lecturerA, institutionId: instA, courseId: courseA, assignmentMode: "COURSE" },
    });
    cleanupExamIds.push(exam.id);
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: student.id, status: "SUBMITTED" } });
    cleanupSubmissionIds.push(submission.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { DELETE } = await import("@/app/api/courses/[id]/enrolments/[userId]/route");
    await DELETE(new Request("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: courseA, userId: student.id }) });

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(fresh.institutionId).toBe(instA);
    const stillThere = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(stillThere.studentId).toBe(student.id);
  });
});

// ── Platform Admin regression (47) ─────────────────────────────────────────

describe("Platform Admin invite-student route — unchanged", () => {
  it("47. platform admin can still directly create an institution-bound student", async () => {
    const admin = await createUser(`pa47-admin-${stamp}@test.invalid`, "LECTURER", instA);
    await prisma.user.update({ where: { id: admin.id }, data: { role: "PLATFORM_ADMIN" } });
    mockAuth.mockResolvedValue(sessionFor(admin.id, "PLATFORM_ADMIN", instA));
    const { POST } = await import("@/app/api/platform/institutions/[id]/invite-student/route");
    const res = await POST(
      jsonRequest({ name: "PA Student", email: `pa47-student-${stamp}@test.invalid`, password: "temporary-pass-123" }),
      { params: Promise.resolve({ id: instA }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.institutionId).toBe(instA);
    cleanupUserIds.push(body.id);
  });
});

// ── Audit (53-54) ───────────────────────────────────────────────────────

describe("Audit trail for the invitation lifecycle", () => {
  it("53 & 54. create/regenerate/revoke/accept each produce a safe audit entry with no token/hash in metadata", async () => {
    const student = await createUser(`audit53-${stamp}@test.invalid`, "STUDENT", null);
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: createInv } = await import("@/app/api/courses/[id]/invitations/route");
    const created = await (await createInv(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) })).json();
    await createInv(jsonRequest({ email: student.email }), { params: Promise.resolve({ id: courseA }) }); // regenerate

    const { DELETE } = await import("@/app/api/courses/[id]/invitations/[invitationId]/route");
    // Re-fetch current token after regeneration to revoke a live pending invitation for a fresh accept-audit check on a SEPARATE invitation.
    const student2 = await createUser(`audit53b-${stamp}@test.invalid`, "STUDENT", null);
    const created2 = await (await createInv(jsonRequest({ email: student2.email }), { params: Promise.resolve({ id: courseA }) })).json();
    const token2 = created2.invitationUrl.split("/").pop();
    await DELETE(jsonRequest(undefined, "DELETE"), { params: Promise.resolve({ id: courseA, invitationId: created.invitationId }) });

    mockAuth.mockResolvedValue(sessionFor(student2.id, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/course-invitations/[invitationId]/[token]/accept/route");
    await accept(jsonRequest(), { params: Promise.resolve({ invitationId: created2.invitationId, token: token2 }) });

    const logs = await prisma.platformAuditLog.findMany({
      where: { targetId: { in: [created.invitationId, created2.invitationId] } },
      orderBy: { createdAt: "asc" },
    });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("course.invitation_created");
    expect(actions).toContain("course.invitation_regenerated");
    expect(actions).toContain("course.invitation_revoked");
    expect(actions).toContain("course.invitation_accepted");

    for (const log of logs) {
      const metadataStr = JSON.stringify(log.metadata);
      expect(metadataStr.toLowerCase()).not.toContain("token");
      expect(metadataStr.toLowerCase()).not.toContain("hash");
    }
  });
});
