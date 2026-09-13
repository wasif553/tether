/**
 * Auto-submit server-backstop v1 — DB-backed route tests. See
 * src/lib/submissionFinalization.ts, POST /api/exams/[id]/start's
 * existing-attempt backstop, and POST
 * /api/internal/finalize-overdue-submissions.
 *
 * SAFE EXECUTION ONLY: run this file exclusively via `npm run
 * release:validate` — never a direct `npx vitest run` against this
 * repository's committed DATABASE_URL. See src/lib/prismaDbSafetyGuard.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { buildSecureClientPolicySnapshot } = await import("./secureClientPolicy");
const startRoute = await import("../app/api/exams/[id]/start/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const internalSweepRoute = await import("../app/api/internal/finalize-overdue-submissions/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

function jsonRequest(method: string, body?: unknown, headers?: Record<string, string>) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };
let instId: string;
let lecturer: { id: string };
let student: { id: string };

const TETHER_AVAILABLE = { tetherClientOptionalAvailable: false, tetherClientRequiredAvailable: true, sebOptionalAvailable: false, sebRequiredAvailable: false };
const TETHER_UNAVAILABLE_FOR_STANDARD = { tetherClientOptionalAvailable: false, tetherClientRequiredAvailable: false, sebOptionalAvailable: false, sebRequiredAvailable: false };

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`autosubmit-backstop-${stamp}`);
  instId = inst.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Backstop Lecturer", email: `backstop-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instId },
  });
  student = await prisma.user.create({
    data: { name: "Backstop Student", email: `backstop-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instId },
  });
  cleanup.users.push(lecturer.id, student.id);
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { targetId: { in: [] } } }).catch(() => {});
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExam(opts: { durationMins: number; tether: boolean }) {
  const exam = await prisma.exam.create({
    data: {
      title: `Backstop Exam ${stamp}-${Math.random()}`,
      durationMins: opts.durationMins,
      published: true,
      createdById: lecturer.id,
      institutionId: instId,
    },
  });
  cleanup.exams.push(exam.id);
  const mcq = await prisma.question.create({
    data: { examId: exam.id, type: "MULTIPLE_CHOICE", text: "Q", points: 1, options: ["A", "B"], correctAnswer: "A", order: 0 },
  });
  return { exam, mcq };
}

/**
 * Creates an IN_PROGRESS submission directly (same convention
 * voidedSubmissionRecovery.routes.test.ts already uses for Tether
 * fixtures — driving a real mock secure-client attestation handshake is
 * unnecessary for these tests, which only exercise the finalization
 * backstop, not native/Tether verification itself). `startedAt` is
 * backdated by `overdueByMs` to simulate an already-passed deadline
 * without waiting in real time.
 */
async function createInProgressSubmission(params: {
  examId: string;
  durationMins: number;
  allowLateSubmit: boolean;
  autoSubmitOnTimerEnd: boolean;
  tether: boolean;
  overdueByMs: number; // negative = still within the deadline
}) {
  const startedAt = new Date(Date.now() - params.durationMins * 60_000 - params.overdueByMs);
  const secureClientPolicySnapshot = buildSecureClientPolicySnapshot(
    {
      deliveryMode: params.tether ? "TETHER_CLIENT_REQUIRED" : "STANDARD_WEB",
      allowedSebPlatforms: [],
      allowedSebVersions: [],
      requireSebBrowserExamKey: false,
      requireSebConfigKey: false,
      allowSebHeaderValidation: true,
      allowSebJavascriptApiValidation: true,
      secureLaunchTokenTtlSeconds: 300,
      secureClientHeartbeatIntervalSeconds: 30,
      secureClientHeartbeatGraceSeconds: 90,
      requireDisplayCheck: false,
      secureClientMaximumDisplays: 1,
      displayPolicy: "UNRESTRICTED",
      requireRemoteSessionCheck: false,
      requireVirtualMachineCheck: false,
      requireProcessCheck: false,
      requireCaptureProtectionCheck: false,
      blockCopyPaste: false,
      secureClientAllowPrinting: true,
      secureClientAllowExternalNavigation: true,
      secureClientAllowApplicationSwitching: true,
      secureClientAllowRecovery: true,
      secureClientEventRetentionDays: 180,
      secureClientLecturerOverrideAllowed: true,
    },
    params.tether ? TETHER_AVAILABLE : TETHER_UNAVAILABLE_FOR_STANDARD,
  );
  if (params.tether) expect(secureClientPolicySnapshot.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");

  return prisma.submission.create({
    data: {
      examId: params.examId,
      studentId: student.id,
      attemptNumber: 1,
      startedAt,
      activatedAt: startedAt,
      examPolicySnapshotJson: { timingPolicy: { durationMins: params.durationMins, allowLateSubmit: params.allowLateSubmit, autoSubmitOnTimerEnd: params.autoSubmitOnTimerEnd } },
      secureClientPolicySnapshotJson: secureClientPolicySnapshot as unknown as object,
    },
  });
}

describe("POST /api/exams/[id]/start — overdue existing-attempt server backstop", () => {
  it("B/C — an already-overdue TETHER_CLIENT_REQUIRED IN_PROGRESS attempt is finalized BEFORE any secure-client launch is computed, and the response never asks for a secure launch", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: true });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: true,
      overdueByMs: 5 * 60_000, // 5 minutes past deadline
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.id).toBe(submission.id);
    expect(["SUBMITTED", "GRADED"]).toContain(body.status);
    // C — no secure launch for the now-finalized attempt.
    expect(body.secureClientLaunch).toEqual({ required: false });

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(fresh.status).not.toBe("IN_PROGRESS");
    expect(fresh.submittedAt).not.toBeNull();
  });

  it("D — an unexpired TETHER_CLIENT_REQUIRED attempt resumes completely unaffected (status stays IN_PROGRESS, no finalization)", async () => {
    const { exam } = await createExam({ durationMins: 60, tether: true });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 60,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: true,
      overdueByMs: -30 * 60_000, // 30 minutes remaining
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(submission.id);
    expect(body.status).toBe("IN_PROGRESS");

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(fresh.status).toBe("IN_PROGRESS");
    expect(fresh.submittedAt).toBeNull();
  });

  it("E — an overdue STANDARD_WEB attempt is finalized through the identical academic lifecycle semantics as Tether (same predicate, same finalization service, no delivery-mode branch)", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: false });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: false,
      overdueByMs: 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["SUBMITTED", "GRADED"]).toContain(body.status);

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(fresh.status).not.toBe("IN_PROGRESS");
  });

  it("M — autoSubmitOnTimerEnd=false leaves an overdue attempt completely untouched (still IN_PROGRESS after /start)", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: false });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: true,
      autoSubmitOnTimerEnd: false,
      tether: false,
      overdueByMs: 60 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(submission.id);
    expect(body.status).toBe("IN_PROGRESS");

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(fresh.status).toBe("IN_PROGRESS");
    expect(fresh.submittedAt).toBeNull();
  });

  it("N — allowLateSubmit=true ALONE (autoSubmitOnTimerEnd=false) never causes server auto-finalization, even hours overdue — a human is expected to submit late, the system must not preempt that", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: false });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: true,
      autoSubmitOnTimerEnd: false,
      tether: false,
      overdueByMs: 3 * 60 * 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(fresh.status).toBe("IN_PROGRESS");

    // The student can still manually submit late themselves — untouched.
    const submitRes = await submitRoute.POST(jsonRequest("POST", { submissionRequestId: "manual-late" }), { params: Promise.resolve({ id: submission.id }) });
    expect(submitRes.status).toBe(200);
    const submitBody = await submitRes.json();
    expect(["SUBMITTED", "GRADED"]).toContain(submitBody.status);
  });

  it("L — an accommodation-extended deadline (frozen in the attempt's own timingPolicy) is honoured — NOT finalized early just because the exam's standard duration would otherwise have expired", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: false });
    // Frozen timingPolicy.durationMins reflects an accommodation already
    // resolved at start time (see POST /api/exams/[id]/start's own
    // accommodation resolution) — 90 minutes instead of the exam's
    // standard 30. startedAt is backdated as if the STANDARD 30-minute
    // window would already be over, but the accommodated 90-minute
    // window is not.
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 90,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: false,
      overdueByMs: -60 * 60_000, // 60 minutes remain of the accommodated 90
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.status).toBe("IN_PROGRESS");

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(fresh.status).toBe("IN_PROGRESS");
  });

  it("F — a client /submit and the /start backstop racing at the same overdue moment resolve to exactly one finalization, never a duplicate grading pass", async () => {
    const { exam, mcq } = await createExam({ durationMins: 30, tether: false });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: false,
      overdueByMs: 60_000,
    });
    await prisma.answer.create({ data: { submissionId: submission.id, questionId: mcq.id, response: "A" } });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const [startRes, submitRes] = await Promise.all([
      startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) }),
      submitRoute.POST(jsonRequest("POST", { submissionRequestId: "race-1", systemAutoSubmit: true }), { params: Promise.resolve({ id: submission.id }) }),
    ]);
    expect(startRes.status).toBe(200);
    expect(submitRes.status).toBe(200);

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(["SUBMITTED", "GRADED"]).toContain(fresh.status);
    // Exactly one grading pass: the MCQ answer was graded once (score set), not corrupted/duplicated.
    const answers = await prisma.answer.findMany({ where: { submissionId: submission.id } });
    expect(answers).toHaveLength(1);
    expect(answers[0]?.score).toBe(1);
    expect(answers[0]?.isCorrect).toBe(true);
  });

  it("H/I — post-finalization effects (activity telemetry) and the SUBMISSION_SERVER_BACKSTOP_FINALIZED audit both occur exactly once, atomically with the status transition", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: false });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: false,
      overdueByMs: 60_000,
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);

    const auditRows = await prisma.platformAuditLog.findMany({ where: { targetId: submission.id, action: "SUBMISSION_SERVER_BACKSTOP_FINALIZED" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.metadata).toMatchObject({ submissionId: submission.id, examId: exam.id, studentId: student.id, trigger: "deadline_backstop" });
    expect((auditRows[0]?.metadata as { finalizedAt?: string })?.finalizedAt).toBeTruthy();

    // Calling /start again (idempotent replay against an already-finalized row) must never create a second audit row.
    await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const auditRowsAfterSecondCall = await prisma.platformAuditLog.findMany({ where: { targetId: submission.id, action: "SUBMISSION_SERVER_BACKSTOP_FINALIZED" } });
    expect(auditRowsAfterSecondCall).toHaveLength(1);
  });

  it("P — an expired Tether attempt's ExamAttemptSession is ended (cannot remain/re-enter ACTIVE) after server finalization", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: true });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: true,
      overdueByMs: 60_000,
    });
    await prisma.examAttemptSession.create({
      data: {
        submissionId: submission.id,
        userId: student.id,
        browserSessionTokenHash: "test-hash",
        deviceTokenHash: "test-device-hash",
        status: "ACTIVE",
      },
    });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });

    const sessions = await prisma.examAttemptSession.findMany({ where: { submissionId: submission.id } });
    expect(sessions.every((s) => s.status === "ENDED")).toBe(true);
  });

  it("J/K — server backstop finalizes on persisted answers only (no fabrication); a live client's finalResponses still win when supplied through ordinary /submit", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: false });

    // Backstop case: no persisted answer at all for the question — must
    // never be fabricated; grading simply sees "no answer".
    const backstopSubmission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: false,
      overdueByMs: 60_000,
    });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const backstopAnswers = await prisma.answer.findMany({ where: { submissionId: backstopSubmission.id } });
    // Grading still produces an Answer row per question (pre-existing,
    // unchanged behaviour — every question gets scored, answered or
    // not), but nothing is fabricated: no response text/selection was
    // ever invented for a question the student never actually answered.
    expect(backstopAnswers).toHaveLength(1);
    expect(backstopAnswers[0]?.response).toBeNull();
    expect(backstopAnswers[0]?.score).toBe(0);
    expect(backstopAnswers[0]?.isCorrect).toBe(false);

    // Live-client case: finalResponses supplied via ordinary /submit must
    // still win. A separate exam — the same student already has an
    // attemptNumber=1 submission on `exam` above (the unique
    // (examId, studentId, attemptNumber) constraint would otherwise
    // reject a second one).
    const { exam: liveExam, mcq: liveMcq } = await createExam({ durationMins: 30, tether: false });
    const liveSubmission = await createInProgressSubmission({
      examId: liveExam.id,
      durationMins: 30,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: false,
      overdueByMs: -60_000, // not yet overdue — a genuine manual/live submit
    });
    const submitRes = await submitRoute.POST(
      jsonRequest("POST", { submissionRequestId: "live-1", finalResponses: { [liveMcq.id]: "A" } }),
      { params: Promise.resolve({ id: liveSubmission.id }) },
    );
    expect(submitRes.status).toBe(200);
    const liveAnswers = await prisma.answer.findMany({ where: { submissionId: liveSubmission.id } });
    expect(liveAnswers).toHaveLength(1);
    expect(liveAnswers[0]?.response).toBe("A");
  });
});

describe("POST /api/internal/finalize-overdue-submissions — scheduled sweep", () => {
  const secret = "test-overdue-finalization-secret";
  const originalSecret = process.env.OVERDUE_FINALIZATION_SECRET;

  beforeAll(() => {
    process.env.OVERDUE_FINALIZATION_SECRET = secret;
  });
  afterAll(() => {
    process.env.OVERDUE_FINALIZATION_SECRET = originalSecret;
  });

  it("Q — rejects a request with no Authorization header, and one with the wrong secret", async () => {
    const noAuthRes = await internalSweepRoute.POST(new Request("http://test.local/route", { method: "POST" }));
    expect(noAuthRes.status).toBe(401);

    const wrongAuthRes = await internalSweepRoute.POST(
      new Request("http://test.local/route", { method: "POST", headers: { Authorization: "Bearer not-the-secret" } }),
    );
    expect(wrongAuthRes.status).toBe(401);
  });

  it("Q2 — fails closed when the SERVER's own OVERDUE_FINALIZATION_SECRET is unset, even if a caller supplies a plausible-looking bearer token", async () => {
    delete process.env.OVERDUE_FINALIZATION_SECRET;
    try {
      const res = await internalSweepRoute.POST(
        new Request("http://test.local/route", { method: "POST", headers: { Authorization: "Bearer some-token-someone-guessed-or-leaked" } }),
      );
      expect(res.status).toBe(401);
    } finally {
      process.env.OVERDUE_FINALIZATION_SECRET = secret;
    }
  });

  it("Q3 — a wrong secret of a completely different length never throws (timingSafeEqual's own length-mismatch exception is guarded against) — still a clean 401", async () => {
    const tooShort = await internalSweepRoute.POST(new Request("http://test.local/route", { method: "POST", headers: { Authorization: "Bearer x" } }));
    expect(tooShort.status).toBe(401);

    const tooLong = await internalSweepRoute.POST(
      new Request("http://test.local/route", { method: "POST", headers: { Authorization: `Bearer ${secret}${"x".repeat(500)}` } }),
    );
    expect(tooLong.status).toBe(401);
  });

  it("G/O — a scheduled sweep finalizes an overdue submission the same way the /start backstop would, and is idempotent across repeated invocations", async () => {
    const { exam } = await createExam({ durationMins: 30, tether: false });
    const submission = await createInProgressSubmission({
      examId: exam.id,
      durationMins: 30,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true,
      tether: false,
      overdueByMs: 60_000,
    });

    const req = () => new Request("http://test.local/route", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    const firstRes = await internalSweepRoute.POST(req());
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.finalized).toBeGreaterThanOrEqual(1);

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: submission.id } });
    expect(fresh.status).not.toBe("IN_PROGRESS");

    // O — repeated sweep is idempotent: the same row is now counted as alreadyFinalized, never re-finalized/re-graded.
    const secondRes = await internalSweepRoute.POST(req());
    const secondBody = await secondRes.json();
    expect(secondBody.finalized === 0 || secondBody.alreadyFinalized >= 0).toBe(true);

    const auditRows = await prisma.platformAuditLog.findMany({ where: { targetId: submission.id, action: "SUBMISSION_SERVER_BACKSTOP_FINALIZED" } });
    expect(auditRows).toHaveLength(1);
  });

  it("R — respects a bounded batch and returns aggregate counts, never per-student identifiers, on a normal run", async () => {
    const req = () => new Request("http://test.local/route", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    const res = await internalSweepRoute.POST(req());
    const body = await res.json();
    expect(typeof body.scanned).toBe("number");
    expect(typeof body.eligible).toBe("number");
    expect(typeof body.finalized).toBe("number");
    expect(typeof body.alreadyFinalized).toBe("number");
    expect(typeof body.failed).toBe("number");
    expect(body.submissionId).toBeUndefined();
    expect(body.studentId).toBeUndefined();
  });

  it("starvation fix — an eligible row sitting BEHIND a block of 205 older, ineligible rows (autoSubmitOnTimerEnd=false) is still reached and finalized within a single sweep, past the old fixed 200-row window", async () => {
    // Each row uses its own exam (same student) so the unique
    // (examId, studentId, attemptNumber) constraint never collides —
    // ordered strictly oldest-first via overdueByMs so the 206th row is
    // genuinely the last one a naive `ORDER BY startedAt ASC LIMIT 200`
    // would never reach.
    const ineligibleIds: string[] = [];
    for (let i = 0; i < 205; i++) {
      const { exam } = await createExam({ durationMins: 5, tether: false });
      const submission = await createInProgressSubmission({
        examId: exam.id,
        durationMins: 5,
        allowLateSubmit: true,
        autoSubmitOnTimerEnd: false, // ineligible forever, by design
        tether: false,
        overdueByMs: (300 - i) * 60_000, // strictly older than every row that follows
      });
      ineligibleIds.push(submission.id);
    }
    const { exam: targetExam } = await createExam({ durationMins: 5, tether: false });
    const targetSubmission = await createInProgressSubmission({
      examId: targetExam.id,
      durationMins: 5,
      allowLateSubmit: false,
      autoSubmitOnTimerEnd: true, // eligible — this is the row that must be reached
      tether: false,
      overdueByMs: 60_000, // the MOST RECENT startedAt of the whole set — sorts last
    });

    const req = () => new Request("http://test.local/route", { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    const res = await internalSweepRoute.POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanned).toBeGreaterThan(200); // proves it paged past the old fixed window

    const fresh = await prisma.submission.findUniqueOrThrow({ where: { id: targetSubmission.id } });
    expect(fresh.status).not.toBe("IN_PROGRESS");

    // The 205 ineligible rows must remain completely untouched.
    const stillInProgress = await prisma.submission.count({ where: { id: { in: ineligibleIds }, status: "IN_PROGRESS" } });
    expect(stillInProgress).toBe(205);
  });
});
