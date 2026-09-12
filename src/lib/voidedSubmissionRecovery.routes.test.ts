/**
 * VOIDED-attempt recovery v1 — DB-backed route tests. See
 * docs/voided-submission-recovery-v1.md.
 *
 * Same DB-backed pattern as finalExaminationPolicy.routes.test.ts /
 * tetherRequiredFailClosed.routes.test.ts / concurrency.routes.test.ts —
 * run ONLY via `npm run release:validate` (a disposable, local-only
 * Postgres container). src/lib/prisma.ts's test-time safety guard refuses
 * to run against the shared Preview/Production Supabase project.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { buildSecureClientPolicySnapshot, DEFAULT_SECURE_CLIENT_AVAILABILITY } = await import("./secureClientPolicy");
const { calculateExamAnalytics } = await import("./analytics");
const { buildMarksReport } = await import("./assessmentExport");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");
const submitRoute = await import("../app/api/submissions/[id]/submit/route");
const voidRoute = await import("../app/api/lecturer/submissions/[id]/void/route");
const submissionDetailRoute = await import("../app/api/submissions/[id]/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[], institutions: [] as string[] };

let instId: string;
let otherInstId: string;
let lecturer: { id: string };
let otherLecturer: { id: string };
let student: { id: string };

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`voided-recovery-${stamp}`);
  instId = inst.id;
  const otherInst = await getOrCreateTestInstitution(`voided-recovery-other-${stamp}`);
  otherInstId = otherInst.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Voided Recovery Lecturer", email: `vr-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instId },
  });
  otherLecturer = await prisma.user.create({
    data: { name: "Voided Recovery Other Lecturer", email: `vr-other-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: otherInstId },
  });
  student = await prisma.user.create({
    data: { name: "Voided Recovery Student", email: `vr-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instId },
  });
  cleanup.users.push(lecturer.id, otherLecturer.id, student.id);
});

afterAll(async () => {
  await prisma.platformAuditLog.deleteMany({ where: { actorId: { in: cleanup.users } } });
  await prisma.secureClientSession.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createTetherRequiredExam(title: string) {
  const exam = await prisma.exam.create({
    data: { title: `${title} ${stamp}-${Math.random()}`, durationMins: 30, createdById: lecturer.id, institutionId: instId, published: false },
  });
  cleanup.exams.push(exam.id);
  mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
  await examRoute.PATCH(
    jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST", deliveryMode: "TETHER_CLIENT_REQUIRED" }, published: true }),
    { params: Promise.resolve({ id: exam.id }) },
  );
  return exam;
}

/** The exact confirmed-incident shape: an IN_PROGRESS submission whose frozen snapshot was built while Tether was unavailable (STANDARD_WEB-downgraded), on an exam that NOW requires TETHER_CLIENT_REQUIRED. */
async function createStaleMismatchedSubmission(examId: string, studentId: string, attemptNumber = 1) {
  const staleSnapshot = buildSecureClientPolicySnapshot(
    {
      deliveryMode: "TETHER_CLIENT_REQUIRED",
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
    DEFAULT_SECURE_CLIENT_AVAILABILITY, // tetherClientRequiredAvailable: false -> downgrades to STANDARD_WEB
  );
  expect(staleSnapshot.deliveryMode).toBe("STANDARD_WEB"); // sanity check on the fixture itself
  return prisma.submission.create({
    data: {
      examId,
      studentId,
      attemptNumber,
      status: "IN_PROGRESS",
      secureClientPolicySnapshotJson: staleSnapshot as unknown as object,
    },
  });
}

describe("POST /api/exams/[id]/start — SECURE_POLICY_MISMATCH_RESTART_REQUIRED (test item 12)", () => {
  it("returns the typed mismatch response for the exact confirmed-incident shape, never mutating the snapshot or issuing a Tether-launch redirect", async () => {
    const exam = await createTetherRequiredExam("mismatch-restart-required");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    const before = await prisma.submission.findUniqueOrThrow({ where: { id: stale.id } });

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SECURE_POLICY_MISMATCH_RESTART_REQUIRED");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);

    const after = await prisma.submission.findUniqueOrThrow({ where: { id: stale.id } });
    expect(after.secureClientPolicySnapshotJson).toEqual(before.secureClientPolicySnapshotJson);
    expect(after.status).toBe("IN_PROGRESS"); // never auto-voided
  });

  it("a genuinely healthy in-progress Tether attempt is unaffected and still redirects to Tether launch normally", async () => {
    const exam = await createTetherRequiredExam("healthy-resume-unaffected");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const firstRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(firstRes.status).toBe(201);

    const resumeRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(resumeRes.status).toBe(200);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.secureClientLaunch).toMatchObject({ required: true, kind: "REDIRECT_TO_TETHER_LAUNCH" });
  });
});

describe("POST /api/lecturer/submissions/[id]/void — eligibility, authorization, idempotency (test items A/B/13/14/15)", () => {
  it("A: rejects an ordinary healthy IN_PROGRESS submission (no technical mismatch present)", async () => {
    const exam = await createTetherRequiredExam("void-rejects-healthy");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submissionId = (await startRes.json()).id as string;

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await voidRoute.POST(jsonRequest("POST", { reason: "testing", confirm: true }), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SUBMISSION_NOT_VOIDABLE");

    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(stored.status).toBe("IN_PROGRESS");
  });

  it("B: accepts the proven secure-policy mismatch case, transitions to VOIDED, and does not touch the frozen snapshot/answers/evidence", async () => {
    const exam = await createTetherRequiredExam("void-accepts-mismatch");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    const snapshotBefore = stale.secureClientPolicySnapshotJson;

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await voidRoute.POST(jsonRequest("POST", { reason: "Legacy STANDARD_WEB snapshot mismatch", confirm: true }), {
      params: Promise.resolve({ id: stale.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("VOIDED");

    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: stale.id } });
    expect(stored.status).toBe("VOIDED");
    expect(stored.secureClientPolicySnapshotJson).toEqual(snapshotBefore);
    expect(stored.totalScore).toBeNull();
    expect(stored.gradedAt).toBeNull();
  });

  it("rejects when reason is missing or confirm is not explicitly true", async () => {
    const exam = await createTetherRequiredExam("void-requires-reason-and-confirm");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));

    const noReason = await voidRoute.POST(jsonRequest("POST", { confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(noReason.status).toBe(400);

    const noConfirm = await voidRoute.POST(jsonRequest("POST", { reason: "x" }), { params: Promise.resolve({ id: stale.id }) });
    expect(noConfirm.status).toBe(400);

    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: stale.id } });
    expect(stored.status).toBe("IN_PROGRESS");
  });

  it("14: a STUDENT cannot void an attempt (401)", async () => {
    const exam = await createTetherRequiredExam("void-student-unauthorized");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await voidRoute.POST(jsonRequest("POST", { reason: "x", confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(res.status).toBe(401);
    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: stale.id } });
    expect(stored.status).toBe("IN_PROGRESS");
  });

  it("14: a lecturer who does not own the exam (different institution) cannot void it — existence-hiding 404", async () => {
    const exam = await createTetherRequiredExam("void-non-owner-unauthorized");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, "LECTURER", otherInstId));
    const res = await voidRoute.POST(jsonRequest("POST", { reason: "x", confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(res.status).toBe(404);
    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: stale.id } });
    expect(stored.status).toBe("IN_PROGRESS");
  });

  it("15: a repeated void request on the same (already-voided) row is safely rejected, not double-processed", async () => {
    const exam = await createTetherRequiredExam("void-repeated-safe");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));

    const first = await voidRoute.POST(jsonRequest("POST", { reason: "first", confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(first.status).toBe(200);

    const second = await voidRoute.POST(jsonRequest("POST", { reason: "second", confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.code).toBe("SUBMISSION_NOT_VOIDABLE");

    const auditCount = await prisma.platformAuditLog.count({
      where: { action: "SUBMISSION_VOIDED", targetType: "Submission", targetId: stale.id },
    });
    expect(auditCount).toBe(1); // never double-audited
  });

  it("13: voids only the intended row — a sibling in-progress submission on the same exam is unaffected", async () => {
    const exam = await createTetherRequiredExam("void-only-intended-row");
    const staleForStudent = await createStaleMismatchedSubmission(exam.id, student.id);

    const studentB = await prisma.user.create({
      data: { name: "Voided Recovery Student B", email: `vr-stud-b-${stamp}@test.local`, passwordHash: await bcrypt.hash("test-password", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(studentB.id);
    const staleForStudentB = await createStaleMismatchedSubmission(exam.id, studentB.id);

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await voidRoute.POST(jsonRequest("POST", { reason: "only this one", confirm: true }), {
      params: Promise.resolve({ id: staleForStudent.id }),
    });
    expect(res.status).toBe(200);

    const voided = await prisma.submission.findUniqueOrThrow({ where: { id: staleForStudent.id } });
    const untouched = await prisma.submission.findUniqueOrThrow({ where: { id: staleForStudentB.id } });
    expect(voided.status).toBe("VOIDED");
    expect(untouched.status).toBe("IN_PROGRESS");
  });
});

describe("Audit atomicity (test item E)", () => {
  it("a successful void writes exactly one PlatformAuditLog SUBMISSION_VOIDED row with full metadata, atomically with the status change", async () => {
    const exam = await createTetherRequiredExam("void-audit-atomic");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await voidRoute.POST(jsonRequest("POST", { reason: "audit atomicity check", confirm: true }), {
      params: Promise.resolve({ id: stale.id }),
    });
    expect(res.status).toBe(200);

    const logs = await prisma.platformAuditLog.findMany({
      where: { action: "SUBMISSION_VOIDED", targetType: "Submission", targetId: stale.id },
    });
    expect(logs).toHaveLength(1);
    const metadata = logs[0].metadata as Record<string, unknown>;
    expect(logs[0].actorId).toBe(lecturer.id);
    expect(logs[0].institutionId).toBe(instId);
    expect(metadata.submissionId).toBe(stale.id);
    expect(metadata.examId).toBe(exam.id);
    expect(metadata.studentId).toBe(student.id);
    expect(metadata.previousStatus).toBe("IN_PROGRESS");
    expect(metadata.reason).toBe("audit atomicity check");
    expect(metadata.technicalRecoveryReason).toBe("SECURE_POLICY_MISMATCH_RESTART_REQUIRED");
  });

  it("a REJECTED void (ineligible submission) writes NO audit log row at all", async () => {
    const exam = await createTetherRequiredExam("void-rejected-no-audit");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submissionId = (await startRes.json()).id as string;

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await voidRoute.POST(jsonRequest("POST", { reason: "should be rejected", confirm: true }), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(409);

    const auditCount = await prisma.platformAuditLog.count({ where: { action: "SUBMISSION_VOIDED", targetType: "Submission", targetId: submissionId } });
    expect(auditCount).toBe(0);
  });
});

describe("Attempt number / display (test items F/G) and fresh-attempt snapshot (test items 16/17/18)", () => {
  it("F/16/17/18: after voiding attemptNumber 1, a fresh attempt is attemptNumber 2, never renumbered, and gets the CURRENT TETHER_CLIENT_REQUIRED snapshot with requireVerifiedClient=true and a working secure launch", async () => {
    const exam = await createTetherRequiredExam("fresh-attempt-after-void");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    expect(stale.attemptNumber).toBe(1);

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const voidRes = await voidRoute.POST(jsonRequest("POST", { reason: "F/16/17/18", confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(voidRes.status).toBe(200);

    const stillVoided = await prisma.submission.findUniqueOrThrow({ where: { id: stale.id } });
    expect(stillVoided.attemptNumber).toBe(1); // never renumbered

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const freshRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(freshRes.status).toBe(201);
    const freshBody = await freshRes.json();
    expect(freshBody.attemptNumber).toBe(2); // F: raw attemptNumber is permanent/monotonic, never reused

    // 17/18: the fresh attempt's frozen snapshot reflects the CURRENT
    // (correct) exam configuration, and secure launch is reachable.
    const freshStored = await prisma.submission.findUniqueOrThrow({ where: { id: freshBody.id } });
    const freshSnapshot = freshStored.secureClientPolicySnapshotJson as { deliveryMode: string; requireVerifiedClient: boolean; allowedClientTypes: string[] };
    expect(freshSnapshot.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
    expect(freshSnapshot.requireVerifiedClient).toBe(true);
    expect(freshSnapshot.allowedClientTypes).toEqual(["TETHER_SECURE_CLIENT"]);
    expect(freshStored.activatedAt).toBeNull(); // PREPARING, exactly as designed
    expect(freshBody.secureClientLaunch).toMatchObject({ required: true, kind: "REDIRECT_TO_TETHER_LAUNCH" });

    // G: GET /api/exams/available's own attemptOrdinal computation — the
    // exact field the student dashboard renders instead of raw
    // attemptNumber — must read 1, never 2, for this fresh attempt.
    const { academicAttemptOrdinal } = await import("./assessmentLifecycle");
    const allAttempts = await prisma.submission.findMany({ where: { examId: exam.id, studentId: student.id }, select: { attemptNumber: true, status: true } });
    const ordinal = academicAttemptOrdinal({ attemptNumber: freshBody.attemptNumber, allAttempts });
    expect(ordinal).toBe(1);
    expect(`Attempt ${ordinal} of 1`).toBe("Attempt 1 of 1");
  });
});

describe("Concurrency safety: VOIDED vs SUBMITTED cannot race (test item D)", () => {
  it("simultaneous void and submit requests on the same row never both succeed — exactly one wins, the row ends in a single coherent terminal state", async () => {
    const exam = await createTetherRequiredExam("concurrency-void-vs-submit");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);

    // Both routes call auth() synchronously as the first thing they do,
    // before their first real await — mockResolvedValueOnce queues FIFO,
    // and constructing this array literal invokes both .POST(...) calls
    // (and therefore both synchronous auth() calls) left-to-right before
    // Promise.all ever awaits either, so this deterministically gives the
    // void call the lecturer session and the submit call the student
    // session despite running concurrently.
    mockAuth.mockResolvedValueOnce(sessionFor(lecturer.id, "LECTURER", instId)).mockResolvedValueOnce(sessionFor(student.id, "STUDENT", instId));

    const [voidRes, submitRes] = await Promise.all([
      voidRoute.POST(jsonRequest("POST", { reason: "race test", confirm: true }), { params: Promise.resolve({ id: stale.id }) }),
      submitRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: stale.id }) }),
    ]);
    const voidBody = await voidRes.json();
    const submitBody = await submitRes.json();

    // NOTE: submit/route.ts's own, pre-existing "already finalized" bounce
    // (a DIFFERENT request already finalized this row) deliberately
    // returns HTTP 200 with code "ALREADY_FINALIZED" — an idempotent
    // no-op response, not proof that THIS request itself performed the
    // finalization. Raw HTTP status therefore cannot distinguish "this
    // request won the race" from "this request lost but got a
    // successful-looking bounce" — the authoritative signal is the
    // final DB row plus each response body's own content.
    const voidActuallyWon = voidRes.status === 200 && voidBody.status === "VOIDED";
    const submitActuallyWon = submitBody.code !== "ALREADY_FINALIZED" && (submitBody.status === "SUBMITTED" || submitBody.status === "GRADED") && submitRes.status === 200;

    // Exactly one side genuinely performed the transition — never both,
    // never neither.
    expect(voidActuallyWon !== submitActuallyWon).toBe(true);

    const final = await prisma.submission.findUniqueOrThrow({ where: { id: stale.id } });
    // A single, coherent terminal state — never IN_PROGRESS (someone
    // acted), and never anything but exactly what the winning side wrote.
    expect(["VOIDED", "SUBMITTED", "GRADED"]).toContain(final.status);
    if (voidActuallyWon) {
      expect(final.status).toBe("VOIDED");
      expect(final.totalScore).toBeNull();
      // The loser gets a clean, unambiguous rejection — void's own
      // in-lock re-check never returns an ambiguous 200.
      expect(submitRes.status === 200 && submitBody.code === "ALREADY_FINALIZED").toBe(true);
    } else {
      expect(final.status === "SUBMITTED" || final.status === "GRADED").toBe(true);
      // The loser (void) always gets an unambiguous 409 — never a false 200.
      expect(voidRes.status).toBe(409);
      expect(voidBody.code).toBe("SUBMISSION_NOT_VOIDABLE");
    }

    // Audit log count matches whichever side actually won — never
    // written for the losing side.
    const auditCount = await prisma.platformAuditLog.count({ where: { action: "SUBMISSION_VOIDED", targetType: "Submission", targetId: stale.id } });
    expect(auditCount).toBe(voidActuallyWon ? 1 : 0);
  });
});

describe("Analytics/export metric semantics (test items 9/H) — technical start vs genuine academic completion", () => {
  it("H: a VOIDED attempt is excluded from academic completion/scoring metrics but STILL counted as an operational 'started' attempt in analytics.ts", async () => {
    const exam = await createTetherRequiredExam("analytics-voided-semantics");
    await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 10, order: 0, correctAnswer: "x" } });

    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const voidRes = await voidRoute.POST(jsonRequest("POST", { reason: "analytics semantics", confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(voidRes.status).toBe(200);

    // A second, genuine SUBMITTED attempt from a different student, so
    // this exam has both a voided technical attempt and a real one.
    const studentC = await prisma.user.create({
      data: { name: "Analytics Student C", email: `vr-stud-c-${stamp}@test.local`, passwordHash: await bcrypt.hash("test-password", 4), role: "STUDENT", institutionId: instId },
    });
    cleanup.users.push(studentC.id);
    await prisma.submission.create({
      data: { examId: exam.id, studentId: studentC.id, status: "SUBMITTED", submittedAt: new Date(), attemptNumber: 1 },
    });

    const analytics = await calculateExamAnalytics(exam.id);
    // Operational "started" count deliberately STILL includes the voided
    // attempt — see analytics.ts's own doc comment: totalStudentsStarted
    // is a raw row count, not an academic-completion metric.
    expect(analytics.summary.totalStudentsStarted).toBe(2);
    // But totalSubmitted (genuine academic completion) excludes it —
    // only the real SUBMITTED student counts.
    expect(analytics.summary.totalSubmitted).toBe(1);
    // The voided row's studentResults entry is still present (visible to
    // staff for audit) but contributes no score.
    const voidedRow = analytics.studentResults.find((r) => r.submissionId === stale.id);
    expect(voidedRow).toBeDefined();
    expect(voidedRow?.status).toBe("VOIDED");
    expect(voidedRow?.totalScore).toBeNull();
  });

  it("9: buildMarksReport (assessmentExport.ts) excludes a VOIDED row from submissionsReceived but still lists it in the raw per-row export with a distinct label", async () => {
    const exam = await createTetherRequiredExam("marks-export-voided-semantics");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await voidRoute.POST(jsonRequest("POST", { reason: "export semantics", confirm: true }), { params: Promise.resolve({ id: stale.id }) });

    const report = await buildMarksReport(exam.id);
    expect(report.meta.submissionsReceived).toBe(0); // the sole submission is VOIDED, not a genuine receipt
    const voidedRow = report.rows.find((r) => r.submissionId === stale.id);
    expect(voidedRow).toBeDefined();
    expect(voidedRow?.status).toBe("VOIDED");
    expect(voidedRow?.totalScore).toBeNull();
  });
});

describe("GET /api/submissions/[id] — voidRecoveryEligible (UI recovery-action test items A-F, I, K)", () => {
  async function fetchAsLecturer(submissionId: string) {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await submissionDetailRoute.GET(new Request("http://test.local"), { params: Promise.resolve({ id: submissionId }) });
    expect(res.status).toBe(200);
    return res.json();
  }

  it("A: an eligible stale Tether-mismatch IN_PROGRESS attempt reports voidRecoveryEligible: true", async () => {
    const exam = await createTetherRequiredExam("ui-eligible-stale-mismatch");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    const body = await fetchAsLecturer(stale.id);
    expect(body.voidRecoveryEligible).toBe(true);
  });

  it("B: a healthy Tether IN_PROGRESS attempt (consistent snapshot) reports voidRecoveryEligible: false", async () => {
    const exam = await createTetherRequiredExam("ui-healthy-tether-not-eligible");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submissionId = (await startRes.json()).id as string;
    const body = await fetchAsLecturer(submissionId);
    expect(body.voidRecoveryEligible).toBe(false);
  });

  it("C: a STANDARD_WEB IN_PROGRESS attempt (on a STANDARD_WEB exam) reports voidRecoveryEligible: false — never eligible when the exam itself isn't Tether-required", async () => {
    const exam = await prisma.exam.create({
      data: { title: `ui-standard-web-not-eligible ${stamp}-${Math.random()}`, durationMins: 30, createdById: lecturer.id, institutionId: instId, published: false },
    });
    cleanup.exams.push(exam.id);
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST", deliveryMode: "STANDARD_WEB" }, published: true }), {
      params: Promise.resolve({ id: exam.id }),
    });
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submissionId = (await startRes.json()).id as string;
    const body = await fetchAsLecturer(submissionId);
    expect(body.voidRecoveryEligible).toBe(false);
  });

  it("D: a SUBMITTED attempt reports voidRecoveryEligible: false — status alone excludes it regardless of snapshot shape", async () => {
    const exam = await createTetherRequiredExam("ui-submitted-not-eligible");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    await prisma.submission.update({ where: { id: stale.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    const body = await fetchAsLecturer(stale.id);
    expect(body.voidRecoveryEligible).toBe(false);
  });

  it("E: a GRADED attempt reports voidRecoveryEligible: false", async () => {
    const exam = await createTetherRequiredExam("ui-graded-not-eligible");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    await prisma.submission.update({ where: { id: stale.id }, data: { status: "GRADED", submittedAt: new Date(), gradedAt: new Date(), totalScore: 0 } });
    const body = await fetchAsLecturer(stale.id);
    expect(body.voidRecoveryEligible).toBe(false);
  });

  it("F: an already-VOIDED attempt reports voidRecoveryEligible: false — the action never re-offers itself on an already-voided row", async () => {
    const exam = await createTetherRequiredExam("ui-voided-not-eligible");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const voidRes = await voidRoute.POST(jsonRequest("POST", { reason: "F", confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(voidRes.status).toBe(200);
    const body = await fetchAsLecturer(stale.id);
    expect(body.status).toBe("VOIDED");
    expect(body.voidRecoveryEligible).toBe(false);
  });

  it("voidRecoveryEligible is never exposed as true to the STUDENT's own view, even for an eligible row — the action is staff-only", async () => {
    const exam = await createTetherRequiredExam("ui-student-never-sees-eligible-true");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await submissionDetailRoute.GET(new Request("http://test.local"), { params: Promise.resolve({ id: stale.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.voidRecoveryEligible).toBe(false);
  });

  it("uses the canonical shared helper (isSecurePolicyMismatchForResume), never a re-implemented weaker check", () => {
    const routeSource = fs.readFileSync(path.join(__dirname, "../app/api/submissions/[id]/route.ts"), "utf8");
    expect(routeSource).toMatch(/isSecurePolicyMismatchForResume/);
  });

  it("I: after a successful void, Answer and IntegrityEvent row counts for the submission are unchanged (evidence untouched)", async () => {
    const exam = await createTetherRequiredExam("ui-evidence-unchanged");
    const stale = await createStaleMismatchedSubmission(exam.id, student.id);
    await prisma.integrityEvent.create({
      data: { submissionId: stale.id, examId: exam.id, studentId: student.id, eventType: "WINDOW_BLUR", severity: "LOW", message: "test evidence", occurredAt: new Date() },
    });
    const beforeAnswers = await prisma.answer.count({ where: { submissionId: stale.id } });
    const beforeEvents = await prisma.integrityEvent.count({ where: { submissionId: stale.id } });

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const voidRes = await voidRoute.POST(jsonRequest("POST", { reason: "I", confirm: true }), { params: Promise.resolve({ id: stale.id }) });
    expect(voidRes.status).toBe(200);

    const afterAnswers = await prisma.answer.count({ where: { submissionId: stale.id } });
    const afterEvents = await prisma.integrityEvent.count({ where: { submissionId: stale.id } });
    expect(afterAnswers).toBe(beforeAnswers);
    expect(afterEvents).toBe(beforeEvents);
    expect(afterEvents).toBeGreaterThan(0); // sanity: the evidence genuinely existed and genuinely survived
  });
});

// K: "unauthorized lecturer cannot use the endpoint even if UI is bypassed"
// is already fully covered above by the "STUDENT cannot void" and
// "non-owning lecturer cannot void" tests in the eligibility/authorization
// describe block — those call voidRoute.POST directly, exactly as a UI
// bypass would, with no reliance on the client ever checking eligibility
// first.
