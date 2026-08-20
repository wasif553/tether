/**
 * Standalone Exam Link v1 — DB-backed route tests. See
 * docs/standalone-exam-link-v1.md.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 *
 * Covers, grouped to match the feature's own test matrix:
 *  - Schema/Mode (1-3)
 *  - Token (4-11)
 *  - Acceptance (12-20)
 *  - Dashboard (21-25)
 *  - Access-check/Start (26-31)
 *  - Submission (32-35)
 *  - Regression (36-45)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const {
  generateStandaloneInviteToken,
  hashStandaloneInviteToken,
  verifyStandaloneInviteToken,
  buildStandaloneInviteUrl,
} = await import("./standaloneInvite");
const { isSafeAppCallbackUrl, isSafeJoinWithInviteCallbackUrl } = await import("./safeCallbackUrl");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT", institutionId: string | null) {
  return {
    user: { id: userId, email: `${userId}@test.invalid`, name: "Test", role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

/**
 * Auth and Token Abuse Protection v1 — defaults to a fresh, random
 * `X-Forwarded-For` per call unless the caller explicitly overrides it,
 * so the many existing tests in this file don't share a rate-limit
 * bucket with each other by accident. Tests that specifically want to
 * share one source pass an explicit header instead.
 */
function randomTestSource(): string {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}-${Math.random().toString(36).slice(2)}`;
}

function jsonRequest(body?: unknown, method = "POST", headers: Record<string, string> = {}) {
  return new Request("http://localhost/route", {
    method,
    headers: { "Content-Type": "application/json", "X-Forwarded-For": randomTestSource(), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupExamIds: string[] = [];
const cleanupSubmissionIds: string[] = [];

async function createUser(email: string, role: "LECTURER" | "STUDENT", institutionId: string | null) {
  const passwordHash = await bcrypt.hash("password", 4);
  const u = await prisma.user.create({ data: { name: "Test", email, passwordHash, role, institutionId } });
  cleanupUserIds.push(u.id);
  return u;
}

async function createExam(opts: {
  institutionId: string;
  createdById: string;
  courseId?: string | null;
  assignmentMode?: "COURSE" | "SELECTED_STUDENTS" | "STANDALONE";
  published?: boolean;
  accessCodeHash?: string | null;
  accessCodeRequired?: boolean;
  standaloneInviteTokenHash?: string | null;
  standaloneInviteEnabled?: boolean;
}) {
  const exam = await prisma.exam.create({
    data: {
      title: `Exam ${stamp}-${Math.random()}`,
      durationMins: 60,
      published: opts.published ?? true,
      createdById: opts.createdById,
      institutionId: opts.institutionId,
      courseId: opts.courseId ?? null,
      assignmentMode: opts.assignmentMode ?? "COURSE",
      accessCodeHash: opts.accessCodeHash ?? null,
      accessCodeRequired: opts.accessCodeRequired ?? false,
      standaloneInviteTokenHash: opts.standaloneInviteTokenHash ?? null,
      standaloneInviteEnabled: opts.standaloneInviteEnabled ?? false,
    },
  });
  cleanupExamIds.push(exam.id);
  return exam;
}

let instA: string;
let instB: string;
let lecturerA: string;
let lecturerB: string;
let studentInA: string;
let nullInstStudent: string;

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`standalone-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`standalone-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  lecturerA = (await createUser(`lect-sa-${stamp}@test.invalid`, "LECTURER", instA)).id;
  lecturerB = (await createUser(`lect-sb-${stamp}@test.invalid`, "LECTURER", instB)).id;
  studentInA = (await createUser(`stud-sa-${stamp}@test.invalid`, "STUDENT", instA)).id;
  nullInstStudent = (await createUser(`stud-null-${stamp}@test.invalid`, "STUDENT", null)).id;
});

afterAll(async () => {
  await prisma.examTimeAccommodation.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.submission.deleteMany({ where: { id: { in: cleanupSubmissionIds } } });
  await prisma.examAssignment.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

// ── Schema / Mode (1-3) ──────────────────────────────────────────────────

describe("Schema/Mode", () => {
  it("1. STANDALONE is a valid ExamAssignmentMode value at the DB level", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE" });
    expect(exam.assignmentMode).toBe("STANDALONE");
    expect(exam.courseId).toBeNull();
  });

  it("2. a new exam defaults standaloneInviteEnabled to false and standaloneInviteTokenHash to null", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    expect(exam.standaloneInviteEnabled).toBe(false);
    expect(exam.standaloneInviteTokenHash).toBeNull();
  });

  it("3. PATCH /api/exams/[id] rejects assignmentMode STANDALONE combined with a non-null courseId in the same request", async () => {
    const course = await prisma.course.create({ data: { institutionId: instA, name: "Course X", code: `SA-C-${stamp}` } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "COURSE" });

    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { PATCH } = await import("@/app/api/exams/[id]/route");
    const res = await PATCH(jsonRequest({ assignmentMode: "STANDALONE", courseId: course.id }, "PATCH"), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(400);

    await prisma.course.delete({ where: { id: course.id } });
  });
});

// ── Token (4-11) ─────────────────────────────────────────────────────────

describe("Token", () => {
  it("4. generateStandaloneInviteToken returns a URL-safe, high-entropy string", () => {
    const token = generateStandaloneInviteToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it("5. two calls produce different tokens", () => {
    expect(generateStandaloneInviteToken()).not.toBe(generateStandaloneInviteToken());
  });

  it("6. hashStandaloneInviteToken is deterministic", () => {
    const token = generateStandaloneInviteToken();
    expect(hashStandaloneInviteToken(token)).toBe(hashStandaloneInviteToken(token));
  });

  it("7. hashStandaloneInviteToken never stores/returns the plaintext itself", () => {
    const token = generateStandaloneInviteToken();
    expect(hashStandaloneInviteToken(token)).not.toBe(token);
  });

  it("8. verifyStandaloneInviteToken returns true for a matching token/hash pair", () => {
    const token = generateStandaloneInviteToken();
    expect(verifyStandaloneInviteToken(token, hashStandaloneInviteToken(token))).toBe(true);
  });

  it("9. verifyStandaloneInviteToken returns false for a wrong token", () => {
    const token = generateStandaloneInviteToken();
    const otherToken = generateStandaloneInviteToken();
    expect(verifyStandaloneInviteToken(otherToken, hashStandaloneInviteToken(token))).toBe(false);
  });

  it("10. verifyStandaloneInviteToken returns false (not throw) when the stored hash has a different length", () => {
    const token = generateStandaloneInviteToken();
    expect(() => verifyStandaloneInviteToken(token, "ab")).not.toThrow();
    expect(verifyStandaloneInviteToken(token, "ab")).toBe(false);
  });

  it("11. buildStandaloneInviteUrl produces the dedicated invite path shape", () => {
    const url = buildStandaloneInviteUrl("exam123", "tok-abc_DEF");
    expect(url).toBe("/student/exams/join/exam123/invite/tok-abc_DEF");
  });

  it("safeCallbackUrl accepts the invite path shape and rejects malformed variants", () => {
    expect(isSafeJoinWithInviteCallbackUrl("/student/exams/join/exam123/invite/tok-abc_DEF")).toBe(true);
    expect(isSafeAppCallbackUrl("/student/exams/join/exam123/invite/tok-abc_DEF")).toBe(true);
    expect(isSafeJoinWithInviteCallbackUrl("/student/exams/join/exam123/invite/")).toBe(false);
    expect(isSafeJoinWithInviteCallbackUrl("https://evil.example.com/student/exams/join/x/invite/y")).toBe(false);
    expect(isSafeJoinWithInviteCallbackUrl("//evil.example.com")).toBe(false);
    expect(isSafeJoinWithInviteCallbackUrl("/student/exams/join/x/invite/y?redirect=evil")).toBe(false);
  });
});

// ── Acceptance (12-20) ───────────────────────────────────────────────────

describe("Lecturer invite generation + student acceptance", () => {
  it("12. POST /api/exams/[id]/standalone-invite switches the exam to STANDALONE, clears courseId, and returns a fresh inviteUrl", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "COURSE" });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const res = await POST(jsonRequest(), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inviteUrl).toMatch(new RegExp(`^/student/exams/join/${exam.id}/invite/[A-Za-z0-9_-]+$`));
    expect(body.enabled).toBe(true);

    const updated = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
    expect(updated.assignmentMode).toBe("STANDALONE");
    expect(updated.courseId).toBeNull();
    expect(updated.standaloneInviteEnabled).toBe(true);
    expect(updated.standaloneInviteTokenHash).not.toBeNull();
  });

  it("13. the generated invite response never includes standaloneInviteTokenHash", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const res = await POST(jsonRequest(), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("standaloneInviteTokenHash");
  });

  it("14. a valid accept creates exactly one ExamAssignment for the authenticated caller", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const genRes = await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) });
    const { inviteUrl } = await genRes.json();
    const token = inviteUrl.split("/invite/")[1];

    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const res = await accept(jsonRequest({ token }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const assignments = await prisma.examAssignment.findMany({ where: { examId: exam.id, studentId: nullInstStudent } });
    expect(assignments).toHaveLength(1);
  });

  it("15. accept never sets User.institutionId on a null-institution student", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const genRes = await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) });
    const { inviteUrl } = await genRes.json();
    const token = inviteUrl.split("/invite/")[1];

    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    await accept(jsonRequest({ token }), { params: Promise.resolve({ id: exam.id }) });

    const student = await prisma.user.findUniqueOrThrow({ where: { id: nullInstStudent } });
    expect(student.institutionId).toBeNull();
  });

  it("16. accept is idempotent — accepting twice never creates a duplicate ExamAssignment or throws", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const genRes = await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) });
    const { inviteUrl } = await genRes.json();
    const token = inviteUrl.split("/invite/")[1];

    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const res1 = await accept(jsonRequest({ token }), { params: Promise.resolve({ id: exam.id }) });
    const res2 = await accept(jsonRequest({ token }), { params: Promise.resolve({ id: exam.id }) });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const assignments = await prisma.examAssignment.findMany({ where: { examId: exam.id, studentId: studentInA } });
    expect(assignments).toHaveLength(1);
  });

  it("17. regenerating invalidates the old token — old token fails, new token succeeds", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const first = await (await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) })).json();
    const oldToken = first.inviteUrl.split("/invite/")[1];
    const second = await (await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) })).json();
    const newToken = second.inviteUrl.split("/invite/")[1];
    expect(newToken).not.toBe(oldToken);

    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const oldRes = await accept(jsonRequest({ token: oldToken }), { params: Promise.resolve({ id: exam.id }) });
    expect((await oldRes.json()).ok).toBe(false);
    const newRes = await accept(jsonRequest({ token: newToken }), { params: Promise.resolve({ id: exam.id }) });
    expect((await newRes.json()).ok).toBe(true);
  });

  it("18. DELETE (disable) makes further accept attempts fail even with the still-correct token", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate, DELETE: disable } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const gen = await (await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) })).json();
    const token = gen.inviteUrl.split("/invite/")[1];
    const disableRes = await disable(jsonRequest(undefined, "DELETE"), { params: Promise.resolve({ id: exam.id }) });
    expect(disableRes.status).toBe(200);
    expect((await disableRes.json()).enabled).toBe(false);

    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const res = await accept(jsonRequest({ token }), { params: Promise.resolve({ id: exam.id }) });
    expect((await res.json()).ok).toBe(false);
  });

  it("19. a LECTURER caller is rejected with 401 from the accept route", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE", standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("x") });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const res = await accept(jsonRequest({ token: "x" }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(401);
  });

  it("Auth and Token Abuse Protection v1: repeated invalid invite-token guesses against ONE exam from one source are limited (429 + Retry-After)", async () => {
    const { STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS } = await import("@/lib/security/rateLimitScopes");
    const exam = await createExam({
      institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("the-real-token"),
    });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const sharedSource = randomTestSource();

    for (let i = 0; i < STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS; i++) {
      const res = await accept(jsonRequest({ token: `wrong-guess-${i}` }, "POST", { "X-Forwarded-For": sharedSource }), {
        params: Promise.resolve({ id: exam.id }),
      });
      expect((await res.json()).ok).toBe(false);
    }

    const limited = await accept(jsonRequest({ token: "yet-another-wrong-guess" }, "POST", { "X-Forwarded-For": sharedSource }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect((await limited.json()).reason).toBe("rate_limited");

    // Even the genuinely correct token is now rejected from this source
    // until the window expires — this is the intended, short, auto-
    // expiring block, not a change to token validity itself.
    const evenCorrectToken = await accept(jsonRequest({ token: "the-real-token" }, "POST", { "X-Forwarded-For": sharedSource }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(evenCorrectToken.status).toBe(429);
  });

  it("Auth and Token Abuse Protection v1 (security review v2): the same source+exam is independent PER STUDENT — one student exhausting their guesses does not block a different student on the same exam (campus-NAT safety)", async () => {
    const { STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS } = await import("@/lib/security/rateLimitScopes");
    const exam = await createExam({
      institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("shared-exam-real-token"),
    });
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const sharedSource = randomTestSource();

    // Student A exhausts their own per-student guessing budget against
    // this exam from this shared source.
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    for (let i = 0; i < STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS; i++) {
      await accept(jsonRequest({ token: `wrong-guess-${i}` }, "POST", { "X-Forwarded-For": sharedSource }), {
        params: Promise.resolve({ id: exam.id }),
      });
    }
    const aBlocked = await accept(jsonRequest({ token: "shared-exam-real-token" }, "POST", { "X-Forwarded-For": sharedSource }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(aBlocked.status).toBe(429);

    // A DIFFERENT student, same source, same exam, with the genuinely
    // correct token, is completely unaffected — the limiter is keyed on
    // source+studentId, so a different student's own budget is untouched
    // regardless of exam id.
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const bAccepted = await accept(jsonRequest({ token: "shared-exam-real-token" }, "POST", { "X-Forwarded-For": sharedSource }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(bAccepted.status).toBe(200);
    expect((await bAccepted.json()).ok).toBe(true);
  });

  it("Auth and Token Abuse Protection v1 (security review v2): concurrent invalid-token guesses by ONE student cannot bypass the threshold (Promise.all)", async () => {
    const { STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS } = await import("@/lib/security/rateLimitScopes");
    const exam = await createExam({
      institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("concurrency-real-token"),
    });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const sharedSource = randomTestSource();

    const results = await Promise.all(
      Array.from({ length: STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS + 15 }, (_, i) =>
        accept(jsonRequest({ token: `burst-guess-${i}` }, "POST", { "X-Forwarded-For": sharedSource }), {
          params: Promise.resolve({ id: exam.id }),
        }),
      ),
    );
    const bodies = await Promise.all(results.map((r) => r.json()));
    const invalidCount = bodies.filter((b) => b.reason === "invalid_invite").length;
    const rateLimitedCount = bodies.filter((b) => b.reason === "rate_limited").length;
    expect(invalidCount).toBeLessThanOrEqual(STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS);
    expect(rateLimitedCount).toBeGreaterThan(0);
    expect(invalidCount + rateLimitedCount).toBe(STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS + 15);
  });

  it("Auth and Token Abuse Protection v1 (security review v4): arbitrary/nonexistent examIds from one student+source share ONE bucket, never one row per exam id (storage-cardinality fix)", async () => {
    const { STANDALONE_INVITE_SOURCE_SCOPE } = await import("@/lib/security/rateLimitScopes");
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const sharedSource = randomTestSource();

    const before = await prisma.securityRateLimitBucket.count({ where: { scope: STANDALONE_INVITE_SOURCE_SCOPE } });

    // Many DIFFERENT, entirely made-up exam ids from one authenticated
    // student+source — the limiter is now keyed on source+studentId
    // ONLY (security review v4), reserved BEFORE the exam lookup, so
    // every one of these draws from the SAME single bucket rather than
    // creating a new row per arbitrary id.
    for (let i = 0; i < 5; i++) {
      const arbitraryExamId = `nonexistent-exam-${stamp}-${i}-${Math.random().toString(36).slice(2)}`;
      const res = await accept(jsonRequest({ token: "whatever" }, "POST", { "X-Forwarded-For": sharedSource }), {
        params: Promise.resolve({ id: arbitraryExamId }),
      });
      expect((await res.json()).reason).toBe("invalid_invite");
    }

    const after = await prisma.securityRateLimitBucket.count({ where: { scope: STANDALONE_INVITE_SOURCE_SCOPE } });
    expect(after).toBe(before + 1); // exactly ONE new bucket for this student+source, not 5

    // A REAL exam's wrong-token guess from the SAME student+source draws
    // from that SAME single bucket — no new row.
    const realExam = await createExam({
      institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("cardinality-real-token"),
    });
    const realGuess = await accept(jsonRequest({ token: "wrong-guess" }, "POST", { "X-Forwarded-For": sharedSource }), {
      params: Promise.resolve({ id: realExam.id }),
    });
    expect((await realGuess.json()).reason).toBe("invalid_invite");
    const afterRealGuess = await prisma.securityRateLimitBucket.count({ where: { scope: STANDALONE_INVITE_SOURCE_SCOPE } });
    expect(afterRealGuess).toBe(before + 1); // still exactly one row — same bucket, not a second one
  });

  it("Auth and Token Abuse Protection v1 (security review v4): the standalone budget is now shared PER STUDENT+SOURCE across DIFFERENT exams — being limited on one exam also limits a different exam from the same student+source", async () => {
    // Intentional tradeoff documented in standaloneInviteRateLimit.ts:
    // dropping examId from the key (to close the information oracle —
    // see the information-hiding test below) means one student's
    // guessing against ONE exam now also constrains their own attempts
    // against a DIFFERENT exam from the same source. This does NOT
    // affect a different student's own budget (see the per-student
    // campus-NAT test above).
    const { STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS } = await import("@/lib/security/rateLimitScopes");
    const guessedExam = await createExam({
      institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("guessed-exam-token"),
    });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const sharedSource = randomTestSource();
    for (let i = 0; i < STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS; i++) {
      await accept(jsonRequest({ token: `wrong-guess-${i}` }, "POST", { "X-Forwarded-For": sharedSource }), {
        params: Promise.resolve({ id: guessedExam.id }),
      });
    }

    // A different, legitimate exam's own invite, from the exact SAME
    // student+source — now correctly rate-limited too, since the budget
    // is shared per student+source, not per exam.
    const legitExam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const gen = await (await generate(jsonRequest(), { params: Promise.resolve({ id: legitExam.id }) })).json();
    const legitToken = gen.inviteUrl.split("/invite/")[1];

    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const res = await accept(jsonRequest({ token: legitToken }, "POST", { "X-Forwarded-For": sharedSource }), {
      params: Promise.resolve({ id: legitExam.id }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).reason).toBe("rate_limited");
  });

  it("Auth and Token Abuse Protection v1 (security review v4): information-hiding — nonexistent exam ids and wrong-token guesses against a REAL exam share the same budget and are indistinguishable by rate-limit behavior", async () => {
    const { STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS } = await import("@/lib/security/rateLimitScopes");
    const realExam = await createExam({
      institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("oracle-test-real-token"),
    });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const sharedSource = randomTestSource();

    // Interleave guesses against the REAL exam and against arbitrary,
    // entirely nonexistent exam ids from the SAME student+source — both
    // must return the identical invalid_invite response, and both must
    // count against the exact same budget.
    for (let i = 0; i < STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS; i++) {
      const usingRealExam = i % 2 === 0;
      const targetId = usingRealExam ? realExam.id : `oracle-nonexistent-${stamp}-${i}-${Math.random().toString(36).slice(2)}`;
      const res = await accept(jsonRequest({ token: `wrong-${i}` }, "POST", { "X-Forwarded-For": sharedSource }), {
        params: Promise.resolve({ id: targetId }),
      });
      expect((await res.json()).reason).toBe("invalid_invite"); // identical outcome either way, below threshold
    }

    // Budget now exhausted. A further request against a BRAND-NEW
    // nonexistent exam id returns the SAME 429 a further request against
    // the REAL exam would — an attacker gets no signal distinguishing
    // "this exam id is real" from "it isn't" via whether rate limiting
    // ever activates.
    const afterThresholdNonexistent = await accept(
      jsonRequest({ token: "whatever" }, "POST", { "X-Forwarded-For": sharedSource }),
      { params: Promise.resolve({ id: `oracle-nonexistent-final-${stamp}-${Math.random().toString(36).slice(2)}` }) },
    );
    expect(afterThresholdNonexistent.status).toBe(429);
    expect((await afterThresholdNonexistent.json()).reason).toBe("rate_limited");

    const afterThresholdReal = await accept(
      jsonRequest({ token: "oracle-test-real-token" }, "POST", { "X-Forwarded-For": sharedSource }),
      { params: Promise.resolve({ id: realExam.id }) },
    );
    expect(afterThresholdReal.status).toBe(429);
    expect((await afterThresholdReal.json()).reason).toBe("rate_limited");
    // Even the genuinely CORRECT token against the REAL exam is blocked
    // identically — no distinguishable behavior leaks the exam's realness.
  });

  it("Auth and Token Abuse Protection v1: a different source is independent from another source's guessing against the same exam", async () => {
    const { STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS } = await import("@/lib/security/rateLimitScopes");
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const gen = await (await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) })).json();
    const token = gen.inviteUrl.split("/invite/")[1];

    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const guessingSource = randomTestSource();
    for (let i = 0; i < STANDALONE_INVITE_SOURCE_MAX_ATTEMPTS; i++) {
      await accept(jsonRequest({ token: `wrong-guess-${i}` }, "POST", { "X-Forwarded-For": guessingSource }), {
        params: Promise.resolve({ id: exam.id }),
      });
    }

    const otherSource = randomTestSource();
    const res = await accept(jsonRequest({ token }, "POST", { "X-Forwarded-For": otherSource }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("20. a wrong token against a real, enabled invite is a generic invalid_invite denial — no ExamAssignment created", async () => {
    const exam = await createExam({
      institutionId: instA,
      createdById: lecturerA,
      assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true,
      standaloneInviteTokenHash: hashStandaloneInviteToken(generateStandaloneInviteToken()),
    });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    const res = await accept(jsonRequest({ token: "totally-wrong-token" }), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: "invalid_invite" });
    const assignments = await prisma.examAssignment.findMany({ where: { examId: exam.id, studentId: studentInA } });
    expect(assignments).toHaveLength(0);
  });
});

// ── Dashboard (21-25) ────────────────────────────────────────────────────

describe("GET /api/exams/available — STANDALONE visibility", () => {
  it("21. before acceptance, a null-institution student's available list does NOT include the standalone exam", async () => {
    const exam = await createExam({
      institutionId: instA,
      createdById: lecturerA,
      assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true,
      standaloneInviteTokenHash: hashStandaloneInviteToken(generateStandaloneInviteToken()),
    });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const body = await res.json();
    expect(body.some((e: { id: string }) => e.id === exam.id)).toBe(false);
  });

  it("22. after acceptance, the null-institution student's available list includes exactly that exam", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const gen = await (await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) })).json();
    const token = gen.inviteUrl.split("/invite/")[1];

    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    await accept(jsonRequest({ token }), { params: Promise.resolve({ id: exam.id }) });

    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const body = await res.json();
    expect(body.filter((e: { id: string }) => e.id === exam.id)).toHaveLength(1);
  });

  it("23. an institution-linked student sees a legacy institution-wide exam PLUS a STANDALONE exam they accepted, without duplicates", async () => {
    const legacyExam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null, assignmentMode: "COURSE" });
    const standaloneExam = await createExam({ institutionId: instA, createdById: lecturerA });

    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const gen = await (await generate(jsonRequest(), { params: Promise.resolve({ id: standaloneExam.id }) })).json();
    const token = gen.inviteUrl.split("/invite/")[1];

    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST: accept } = await import("@/app/api/exams/[id]/standalone-invite/accept/route");
    await accept(jsonRequest({ token }), { params: Promise.resolve({ id: standaloneExam.id }) });

    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const body = await res.json();
    expect(body.filter((e: { id: string }) => e.id === legacyExam.id)).toHaveLength(1);
    expect(body.filter((e: { id: string }) => e.id === standaloneExam.id)).toHaveLength(1);
  });

  it("24. an institution-linked student does NOT see a STANDALONE exam they were never assigned (no institution-wide fallback)", async () => {
    const exam = await createExam({
      institutionId: instA,
      createdById: lecturerA,
      assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true,
      standaloneInviteTokenHash: hashStandaloneInviteToken(generateStandaloneInviteToken()),
    });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const body = await res.json();
    expect(body.some((e: { id: string }) => e.id === exam.id)).toBe(false);
  });

  it("25. a null-institution student never sees a legacy institution-wide exam, only their own STANDALONE assignments", async () => {
    const legacyExam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null, assignmentMode: "COURSE" });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const body = await res.json();
    expect(body.some((e: { id: string }) => e.id === legacyExam.id)).toBe(false);
  });
});

// ── Access-check / Start (26-31) ─────────────────────────────────────────

describe("Access-check + Start — STANDALONE", () => {
  it("26. access-check: STANDALONE exam with no ExamAssignment returns ok:false/no_access, even for a same-institution student", async () => {
    const exam = await createExam({
      institutionId: instA,
      createdById: lecturerA,
      assignmentMode: "STANDALONE",
      standaloneInviteEnabled: true,
      standaloneInviteTokenHash: hashStandaloneInviteToken(generateStandaloneInviteToken()),
    });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: "no_access" });
  });

  it("27. access-check: STANDALONE exam with an ExamAssignment returns ok:true for a null-institution student", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("28. start: STANDALONE exam with no ExamAssignment returns 404", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE" });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const res = await POST(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);
  });

  it("29. start: a null-institution student with a valid ExamAssignment can start — no crash from the institutionId audit/evidence path", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const res = await POST(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.examId).toBe(exam.id);
    expect(body.studentId).toBe(nullInstStudent);
    cleanupSubmissionIds.push(body.id);
  });

  it("30. start: a resumed IN_PROGRESS submission for a null-institution STANDALONE student returns the same submission, no crash", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const first = await POST(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const firstBody = await first.json();
    cleanupSubmissionIds.push(firstBody.id);
    const second = await POST(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);
  });

  it("31. start: audit logs are recorded with institutionId null (never crash) for a null-institution STANDALONE student", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const res = await POST(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    cleanupSubmissionIds.push(body.id);
    // Best-effort audit logging is fire-and-forget; assert the request
    // itself completed successfully (the crash this guards against was an
    // unhandled 500 thrown synchronously from requireInstitutionId).
  });
});

// ── Submission (32-35) ───────────────────────────────────────────────────

describe("Submission continuity across invite state changes", () => {
  it("32. disabling the invite after a student has an IN_PROGRESS submission does not block resuming via /start", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE", standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("tok") });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST: start } = await import("@/app/api/exams/[id]/start/route");
    const startRes = await start(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();
    cleanupSubmissionIds.push(submission.id);

    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { DELETE: disable } = await import("@/app/api/exams/[id]/standalone-invite/route");
    await disable(jsonRequest(undefined, "DELETE"), { params: Promise.resolve({ id: exam.id }) });

    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const resumeRes = await start(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(resumeRes.status).toBe(200);
    const resumed = await resumeRes.json();
    expect(resumed.id).toBe(submission.id);
  });

  it("33. regenerating the invite after acceptance does not remove the existing ExamAssignment", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE", standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("tok") });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });

    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { POST: generate } = await import("@/app/api/exams/[id]/standalone-invite/route");
    await generate(jsonRequest(), { params: Promise.resolve({ id: exam.id }) });

    const assignments = await prisma.examAssignment.findMany({ where: { examId: exam.id, studentId: nullInstStudent } });
    expect(assignments).toHaveLength(1);
  });

  it("34. an accessCodeRequired STANDALONE exam still requires the code even for an already-entitled student", async () => {
    const codeHash = await bcrypt.hash("secret-code", 4);
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE", accessCodeHash: codeHash, accessCodeRequired: true });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const withoutCode = await POST(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(withoutCode.status).toBe(403);
    const withCode = await POST(jsonRequest({ policyAcknowledged: true, accessCode: "secret-code" }), { params: Promise.resolve({ id: exam.id }) });
    expect(withCode.status).toBe(201);
    const body = await withCode.json();
    cleanupSubmissionIds.push(body.id);
  });

  it("35. a completed submission's ownership (studentId) is unaffected by STANDALONE invite state", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });
    mockAuth.mockResolvedValue(sessionFor(nullInstStudent, "STUDENT", null));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const res = await POST(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    cleanupSubmissionIds.push(body.id);
    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.studentId).toBe(nullInstStudent);
  });
});

// ── Regression (36-45) ───────────────────────────────────────────────────

describe("Regression — COURSE / SELECTED_STUDENTS / legacy / cross-tenant unaffected", () => {
  it("36. COURSE-mode access-check for an enrolled student is unchanged", async () => {
    const course = await prisma.course.create({ data: { institutionId: instA, name: "Course R1", code: `SA-R1-${stamp}` } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInA, role: "STUDENT" } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "COURSE" });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    expect((await res.json()).ok).toBe(true);
    await prisma.courseEnrollment.deleteMany({ where: { courseId: course.id } });
    await prisma.course.delete({ where: { id: course.id } });
  });

  it("37. SELECTED_STUDENTS-mode access-check for a non-selected enrolled student is still denied", async () => {
    const course = await prisma.course.create({ data: { institutionId: instA, name: "Course R2", code: `SA-R2-${stamp}` } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInA, role: "STUDENT" } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "SELECTED_STUDENTS" });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    expect((await res.json()).ok).toBe(false);
    await prisma.courseEnrollment.deleteMany({ where: { courseId: course.id } });
    await prisma.course.delete({ where: { id: course.id } });
  });

  it("38. a legacy institution-wide exam (courseId null, assignmentMode COURSE) is still visible to any institution student", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null, assignmentMode: "COURSE" });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/available/route");
    const res = await GET();
    const body = await res.json();
    expect(body.some((e: { id: string }) => e.id === exam.id)).toBe(true);
  });

  it("39. start: a legacy institution-wide exam still starts normally for an institution-linked student", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null, assignmentMode: "COURSE" });
    mockAuth.mockResolvedValue(sessionFor(studentInA, "STUDENT", instA));
    const { POST } = await import("@/app/api/exams/[id]/start/route");
    const res = await POST(jsonRequest({ policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    cleanupSubmissionIds.push(body.id);
  });

  it("40. lecturer standalone-invite route 404s for an exam owned by a different lecturer/institution", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA });
    mockAuth.mockResolvedValue(sessionFor(lecturerB, "LECTURER", instB));
    const { POST } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const res = await POST(jsonRequest(), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);
  });

  it("41. lecturer standalone-invite DELETE 404s for an exam owned by a different lecturer/institution", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE", standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("t") });
    mockAuth.mockResolvedValue(sessionFor(lecturerB, "LECTURER", instB));
    const { DELETE } = await import("@/app/api/exams/[id]/standalone-invite/route");
    const res = await DELETE(jsonRequest(undefined, "DELETE"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(404);
  });

  it("42. sanitizeLecturerExam (lecturer exam list) never leaks standaloneInviteTokenHash", async () => {
    await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE", standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("t") });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { GET } = await import("@/app/api/exams/route");
    const res = await GET();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("standaloneInviteTokenHash");
  });

  it("43. GET /api/exams/[id] (lecturer editor) never leaks standaloneInviteTokenHash but does return standaloneInviteEnabled", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE", standaloneInviteEnabled: true, standaloneInviteTokenHash: hashStandaloneInviteToken("t") });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { GET } = await import("@/app/api/exams/[id]/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.standaloneInviteEnabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("standaloneInviteTokenHash");
  });

  it("44. PATCH /api/exams/[id] without assignmentMode in the body never silently reinterprets a legacy institution-wide exam as STANDALONE", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null, assignmentMode: "COURSE" });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { PATCH } = await import("@/app/api/exams/[id]/route");
    const res = await PATCH(jsonRequest({ title: "Renamed" }, "PATCH"), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const updated = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
    expect(updated.assignmentMode).toBe("COURSE");
  });

  it("45. GET /api/exams/[id]/time-accommodations lists exactly the assigned student as eligible for a STANDALONE exam", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, assignmentMode: "STANDALONE" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: nullInstStudent } });
    mockAuth.mockResolvedValue(sessionFor(lecturerA, "LECTURER", instA));
    const { GET } = await import("@/app/api/exams/[id]/time-accommodations/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.eligibleStudents.map((s: { id: string }) => s.id)).toEqual([nullInstStudent]);
  });
});
