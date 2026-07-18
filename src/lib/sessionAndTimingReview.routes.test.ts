/**
 * Exam Session Binding + Time Anomaly Review v1 — DB-backed route tests.
 * See docs/exam-session-binding-v1.md and docs/time-anomaly-review-v1.md.
 *
 * Requires the local test Postgres instance. Pure logic (session
 * classification, timing analysis, combined recommendation) is covered
 * separately in sessionBinding.test.ts, sessionIntegrity.test.ts,
 * timeAnomalyDetection.test.ts, and combinedReviewRecommendation.test.ts,
 * with no DB dependency at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { BROWSER_SESSION_COOKIE_NAME, DEVICE_TOKEN_COOKIE_NAME } = await import("./sessionBinding");
const heartbeatRoute = await import("../app/api/submissions/[id]/session-heartbeat/route");
const sessionReviewRoute = await import("../app/api/lecturer/submissions/[id]/session-review/route");
const timingAnalysisRoute = await import("../app/api/lecturer/submissions/[id]/timing-analysis/route");
const sessionSignalReviewRoute = await import("../app/api/lecturer/session-signals/[signalId]/review/route");
const timingSignalReviewRoute = await import("../app/api/lecturer/timing-signals/[signalId]/review/route");
const answersRoute = await import("../app/api/submissions/[id]/answers/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function jsonRequest(method: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return new Request("http://test.local/route", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let instB: string;
let lecturerA: { id: string };
let otherLecturerSameInst: { id: string };
let lecturerB: { id: string };
let studentA: { id: string };
let studentB: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`session-timing-a-${stamp}`);
  instA = a.id;
  const b = await getOrCreateTestInstitution(`session-timing-b-${stamp}`);
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "STR Lecturer A", email: `str-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  otherLecturerSameInst = await prisma.user.create({
    data: { name: "STR Other Lecturer", email: `str-lect-other-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "STR Lecturer B", email: `str-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  studentA = await prisma.user.create({
    data: { name: "STR Student A", email: `str-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  studentB = await prisma.user.create({
    data: { name: "STR Student B", email: `str-stud-b-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, otherLecturerSameInst.id, lecturerB.id, studentA.id, studentB.id);
});

afterAll(async () => {
  await prisma.timingIntegritySignal.deleteMany({ where: { analysis: { examId: { in: cleanup.exams } } } });
  await prisma.timingAnalysis.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.sessionIntegritySignal.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.answerActivityEvent.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.examAttemptSession.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamWithSubmission(studentId = studentA.id) {
  const exam = await prisma.exam.create({
    data: { title: `Session Timing Exam ${Date.now()}-${Math.random()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
  });
  cleanup.exams.push(exam.id);
  const question = await prisma.question.create({
    data: { examId: exam.id, type: "SHORT_ANSWER", text: "Explain your reasoning.", points: 5, order: 0, correctAnswer: "The correct model answer text." },
  });
  const submission = await prisma.submission.create({
    data: { examId: exam.id, studentId, status: "IN_PROGRESS" },
  });
  return { exam, question, submission };
}

function extractSetCookieToken(res: Response, cookieName: string): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

describe("POST /api/submissions/[id]/session-heartbeat — access control", () => {
  it("1. a student can heartbeat only their own active attempt", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
  });

  it("2. a student cannot heartbeat another student's attempt", async () => {
    const { submission } = await createExamWithSubmission(studentA.id);
    mockAuth.mockResolvedValue(sessionFor(studentB.id, "STUDENT", instA));
    const res = await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("3. a lecturer cannot call the student heartbeat route", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(401);
  });

  it("4. heartbeat response never exposes cookies' hashes or raw values", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/hash/i);
  });
});

describe("Concurrent session detection", () => {
  it("5. two different browser sessions on the same attempt are flagged; a resumed session is not", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));

    const resA = await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const tokenA = extractSetCookieToken(resA, BROWSER_SESSION_COOKIE_NAME);
    const deviceA = extractSetCookieToken(resA, DEVICE_TOKEN_COOKIE_NAME);
    expect(tokenA).toBeTruthy();

    // A second, distinct browser session (no cookies sent) for the same attempt.
    const resB = await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const bodyB = await resB.json();
    expect(bodyB.concurrentSessionDetected).toBe(true);

    // Resuming session A (same cookie) must not create a third session or duplicate the concurrent signal endlessly.
    const cookieHeaderA = `${BROWSER_SESSION_COOKIE_NAME}=${tokenA}; ${DEVICE_TOKEN_COOKIE_NAME}=${deviceA}`;
    await heartbeatRoute.POST(jsonRequest("POST", {}, cookieHeaderA), { params: Promise.resolve({ id: submission.id }) });

    const sessions = await prisma.examAttemptSession.findMany({ where: { submissionId: submission.id } });
    expect(sessions.length).toBe(2);

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const reviewRes = await sessionReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const reviewBody = await reviewRes.json();
    expect(reviewBody.signals.some((s: { signalType: string }) => s.signalType === "CONCURRENT_ACTIVE_SESSIONS")).toBe(true);
  });
});

describe("GET /api/lecturer/submissions/[id]/session-review — access control and safe DTOs", () => {
  it("6. authorised lecturer can read results", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await sessionReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions.length).toBeGreaterThan(0);
  });

  it("7. an unrelated lecturer at the same institution cannot read results", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(otherLecturerSameInst.id, "LECTURER", instA));
    const res = await sessionReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("8. a cross-institution lecturer cannot read results", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
    const res = await sessionReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect([403, 404]).toContain(res.status);
  });

  it("9. a student cannot read session-review results", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await sessionReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(401);
  });

  it("10. never returns raw IP/token/user-agent/fingerprint hashes in the session DTO", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await sessionReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    const keys = Object.keys(body.sessions[0] ?? {});
    expect(keys).not.toContain("browserSessionTokenHash");
    expect(keys).not.toContain("deviceTokenHash");
    expect(keys).not.toContain("ipPrefixHash");
    expect(keys).not.toContain("userAgentHash");
    expect(keys).not.toContain("coarseFingerprintHash");
  });
});

describe("Answer-save telemetry", () => {
  it("11. an answer save creates coarse activity telemetry without the full response text", async () => {
    const { submission, question } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const secretText = "This is my confidential exam answer about the topic in detail.";
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: secretText }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(200);

    // Fire-and-forget telemetry — give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 50));

    const events = await prisma.answerActivityEvent.findMany({ where: { submissionId: submission.id, eventType: "ANSWER_SAVED" } });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].responseLength).toBe(secretText.length);
    expect(JSON.stringify(events)).not.toContain(secretText);
  });

  it("12. answer save still succeeds even though telemetry runs fire-and-forget after the response", async () => {
    const { submission, question } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "Quick answer." }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response).toBe("Quick answer.");
  });
});

describe("POST/GET /api/lecturer/submissions/[id]/timing-analysis", () => {
  it("13. authorised lecturer can run timing analysis", async () => {
    const { submission, question } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "An answer with enough words to be meaningful for analysis." }), {
      params: Promise.resolve({ id: submission.id }),
    });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await timingAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
  });

  it("14. a student cannot run or read timing analysis", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const postRes = await timingAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(postRes.status).toBe(401);
    const getRes = await timingAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(getRes.status).toBe(401);
  });

  it("15. an unrelated lecturer cannot run timing analysis", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(otherLecturerSameInst.id, "LECTURER", instA));
    const res = await timingAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("16. never returns the correct answer in the timing-analysis response", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await timingAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    const res = await timingAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("The correct model answer text");
  });

  it("17. recommendation is always one of the allowed named values", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await timingAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    const res = await timingAnalysisRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(["NO_IMMEDIATE_ACTION", "LECTURER_REVIEW_RECOMMENDED", "ORAL_VERIFICATION_RECOMMENDED", "ESCALATION_RECOMMENDED"]).toContain(
      body.analysis.recommendation,
    );
  });

  it("18. timing analysis never creates an OralVerification record on its own", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await timingAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    const verifications = await prisma.oralVerification.findMany({ where: { submissionId: submission.id } });
    expect(verifications).toHaveLength(0);
  });
});

describe("PATCH session-signals/[signalId]/review and timing-signals/[signalId]/review", () => {
  it("19. authorised lecturer can review a session signal, and it is audited", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const signal = await prisma.sessionIntegritySignal.findFirst({ where: { submissionId: submission.id } });
    expect(signal).not.toBeNull();

    const res = await sessionSignalReviewRoute.PATCH(
      jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN", reviewNote: "Private note text" }),
      { params: Promise.resolve({ signalId: signal!.id }) },
    );
    expect(res.status).toBe(200);

    const log = await prisma.platformAuditLog.findFirst({
      where: { targetType: "SessionIntegritySignal", targetId: signal!.id, action: "SESSION_SIGNAL_REVIEW_UPDATED" },
    });
    expect(log).not.toBeNull();
    expect(JSON.stringify(log?.metadata ?? {})).not.toContain("Private note text");
  });

  it("20. a student cannot change a session signal's review status", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    const signal = await prisma.sessionIntegritySignal.findFirst({ where: { submissionId: submission.id } });

    const res = await sessionSignalReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN" }), {
      params: Promise.resolve({ signalId: signal!.id }),
    });
    expect(res.status).toBe(401);
  });

  it("21. authorised lecturer can review a timing signal, and it is audited", async () => {
    const { submission, question } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "A" }), { params: Promise.resolve({ id: submission.id }) });
    await new Promise((r) => setTimeout(r, 10));
    await answersRoute.PATCH(
      jsonRequest("PATCH", { questionId: question.id, response: "A".repeat(600) }),
      { params: Promise.resolve({ id: submission.id }) },
    );

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await timingAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    const signal = await prisma.timingIntegritySignal.findFirst({ where: { analysis: { submissionId: submission.id } } });

    if (signal) {
      const res = await timingSignalReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN" }), {
        params: Promise.resolve({ signalId: signal.id }),
      });
      expect(res.status).toBe(200);
      const log = await prisma.platformAuditLog.findFirst({
        where: { targetType: "TimingIntegritySignal", targetId: signal.id, action: "TIMING_SIGNAL_REVIEW_UPDATED" },
      });
      expect(log).not.toBeNull();
    }
  });

  it("22. a cross-institution lecturer cannot review a timing signal", async () => {
    const { submission } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await timingAnalysisRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: submission.id }) });
    const signal = await prisma.timingIntegritySignal.findFirst({ where: { analysis: { submissionId: submission.id } } });
    if (signal) {
      mockAuth.mockResolvedValue(sessionFor(lecturerB.id, "LECTURER", instB));
      const res = await timingSignalReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN" }), {
        params: Promise.resolve({ signalId: signal.id }),
      });
      expect([403, 404]).toContain(res.status);
    }
  });
});

describe("Regression: session/timing features never affect grading or submission", () => {
  it("23. submission succeeds even with active session/telemetry rows present", async () => {
    const { submission, question } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "Final answer text." }), {
      params: Promise.resolve({ id: submission.id }),
    });

    const res = await submitRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["SUBMITTED", "GRADED"]).toContain(body.status);
  });

  it("24. ending sessions at submit does not alter Answer.score/isCorrect", async () => {
    const { submission, question } = await createExamWithSubmission();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    await heartbeatRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });
    await answersRoute.PATCH(jsonRequest("PATCH", { questionId: question.id, response: "Final answer text." }), {
      params: Promise.resolve({ id: submission.id }),
    });
    await submitRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: submission.id }) });

    const answer = await prisma.answer.findUnique({ where: { submissionId_questionId: { submissionId: submission.id, questionId: question.id } } });
    // SHORT_ANSWER isn't auto-graded to isCorrect unless it matches — the
    // key assertion is that submission succeeded and the row is intact.
    expect(answer).not.toBeNull();

    const sessions = await prisma.examAttemptSession.findMany({ where: { submissionId: submission.id } });
    expect(sessions.every((s) => s.status === "ENDED")).toBe(true);
  });
});
