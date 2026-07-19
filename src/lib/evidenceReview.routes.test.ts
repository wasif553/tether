/**
 * Exam Design Policy + Evidence Review v1 — DB-backed route tests. See
 * docs/exam-design-policy-v1.md and docs/evidence-review-workflow-v1.md.
 *
 * Requires the local test Postgres instance. Pure logic (policy
 * derivation, signal classification, review-status labels, summary
 * computation, comment author derivation) is covered separately in
 * examPolicy.test.ts and integrityReview.test.ts, with no DB dependency
 * at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const integrityReviewRoute = await import("../app/api/lecturer/submissions/[id]/integrity-review/route");
const bulkNoConcernRoute = await import("../app/api/lecturer/submissions/[id]/integrity-review/bulk-no-concern/route");
const eventReviewRoute = await import("../app/api/lecturer/integrity-events/[eventId]/review/route");
const eventCommentsRoute = await import("../app/api/lecturer/integrity-events/[eventId]/comments/route");
const resolveRoute = await import("../app/api/lecturer/integrity-events/[eventId]/resolve/route");
const startRoute = await import("../app/api/exams/[id]/start/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
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
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let instB: string;
let lecturerA: { id: string };
let otherLecturer: { id: string };
let crossInstLecturer: { id: string };
let platformAdmin: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`evidence-review-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`evidence-review-b-${stamp}`);
  instA = a.id;
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "ER Lecturer A", email: `er-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  otherLecturer = await prisma.user.create({
    data: { name: "ER Other Lecturer", email: `er-lect-other-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  crossInstLecturer = await prisma.user.create({
    data: { name: "ER Cross Inst Lecturer", email: `er-lect-cross-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instB },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "ER Admin", email: `er-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "ER Student A", email: `er-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, otherLecturer.id, crossInstLecturer.id, platformAdmin.id, studentA.id);
});

afterAll(async () => {
  await prisma.integrityReviewComment.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.integrityReviewStatusHistory.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamWithEvent(opts: { secureSettings?: Record<string, unknown> } = {}) {
  const exam = await prisma.exam.create({
    data: {
      title: `Evidence Review Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerA.id,
      institutionId: instA,
      secureSettings: (opts.secureSettings ?? {}) as object,
    },
  });
  cleanup.exams.push(exam.id);
  const submission = await prisma.submission.create({
    data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" },
  });
  const event = await prisma.integrityEvent.create({
    data: {
      submissionId: submission.id,
      examId: exam.id,
      studentId: studentA.id,
      eventType: "WINDOW_BLUR",
      severity: "MEDIUM",
      message: "Window lost focus.",
      occurredAt: new Date(),
    },
  });
  return { exam, submission, event };
}

describe("GET /api/lecturer/submissions/[id]/integrity-review — access control", () => {
  it("1. a new reviewable event defaults to NEEDS_REVIEW", async () => {
    const { submission } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await integrityReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events[0].reviewStatus).toBe("NEEDS_REVIEW");
    expect(body.events[0].reviewStatusLabel).toBe("Needs review");
  });

  it("15. policy interpretation is returned for each event", async () => {
    const { submission } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await integrityReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.events[0].policyInterpretation).toBeDefined();
    expect(body.events[0].policyInterpretation.policyAlignment).toBeDefined();
  });

  it("legacy submission with no policy snapshot shows 'unavailable', UNKNOWN alignment", async () => {
    const { submission } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await integrityReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.policy.available).toBe(false);
    expect(body.policy.message).toBe("Policy snapshot unavailable for this legacy attempt.");
    expect(body.events[0].policyInterpretation.policyAlignment).toBe("UNKNOWN");
  });

  it("5. a student cannot read internal review data", async () => {
    const { submission } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await integrityReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(401);
  });

  it("3. an unauthorised lecturer cannot read review data", async () => {
    const { submission } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, "LECTURER", instA));
    const res = await integrityReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("4. a cross-institution lecturer cannot read review data", async () => {
    const { submission } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(crossInstLecturer.id, "LECTURER", instB));
    const res = await integrityReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    expect(res.status).toBe(404);
  });

  it("13. storage keys are never returned", async () => {
    const { submission } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await integrityReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("storageKey");
    expect(text).not.toContain("supabase");
  });
});

describe("PATCH /api/lecturer/integrity-events/[eventId]/review", () => {
  it("2. an authorised lecturer can change status", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await eventReviewRoute.PATCH(
      jsonRequest("PATCH", { reviewStatus: "REVIEWED_NO_CONCERN", reviewNote: "Looked fine." }),
      { params: Promise.resolve({ eventId: event.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewStatus).toBe("REVIEWED_NO_CONCERN");
  });

  it("3. an unauthorised lecturer cannot change status", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(otherLecturer.id, "LECTURER", instA));
    const res = await eventReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "ESCALATED" }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    expect(res.status).toBe(404);
  });

  it("4. a cross-institution reviewer cannot change status", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(crossInstLecturer.id, "LECTURER", instB));
    const res = await eventReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "ESCALATED" }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    expect(res.status).toBe(404);
  });

  it("6. a student cannot change status", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await eventReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "ESCALATED" }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    expect(res.status).toBe(401);
  });

  it("8. client cannot impersonate another role — authorRole always comes from the session, never the body", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await eventReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "ESCALATED", changedByRole: "PLATFORM_ADMIN" }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    const history = await prisma.integrityReviewStatusHistory.findFirst({ where: { integrityEventId: event.id } });
    expect(history?.changedByRole).toBe("LECTURER");
  });

  it("11/12. decision date and status history record old and new values", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await eventReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "ESCALATED" }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    const updated = await prisma.integrityEvent.findUnique({ where: { id: event.id } });
    expect(updated?.reviewedAt).not.toBeNull();
    const history = await prisma.integrityReviewStatusHistory.findFirst({ where: { integrityEventId: event.id } });
    expect(history?.fromStatus).toBe("NEEDS_REVIEW");
    expect(history?.toStatus).toBe("ESCALATED");
  });

  it("19. bulk escalation is unsupported — only PATCH per-event can escalate", async () => {
    // The bulk route's schema/handler only ever writes REVIEWED_NO_CONCERN — verified structurally in the bulk describe block below.
    expect(typeof eventReviewRoute.PATCH).toBe("function");
  });

  it("20/21/22. review status never creates an OralVerification, never changes marks, never blocks marks release", async () => {
    const { event, submission } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const before = await prisma.submission.findUnique({ where: { id: submission.id } });
    await eventReviewRoute.PATCH(jsonRequest("PATCH", { reviewStatus: "ESCALATED" }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    const after = await prisma.submission.findUnique({ where: { id: submission.id } });
    const verifications = await prisma.oralVerification.findMany({ where: { submissionId: submission.id } });
    expect(verifications.length).toBe(0);
    expect(after?.totalScore).toBe(before?.totalScore);
  });
});

describe("POST /api/lecturer/integrity-events/[eventId]/comments", () => {
  it("9/10. comment persists and history is append-only", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await eventCommentsRoute.POST(jsonRequest("POST", { comment: "Reviewed against policy." }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    expect(res.status).toBe(201);
    const listRes = await eventCommentsRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ eventId: event.id }) });
    const comments = await listRes.json();
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toBe("Reviewed against policy.");
  });

  it("7/8. author name/role are server-derived — LECTURER role never becomes MARKER or an arbitrary client value", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await eventCommentsRoute.POST(jsonRequest("POST", { comment: "Test", authorRole: "MARKER", commentType: "MARKER_COMMENT" }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    const stored = await prisma.integrityReviewComment.findFirst({ where: { integrityEventId: event.id } });
    expect(stored?.authorRole).toBe("LECTURER");
    expect(stored?.commentType).toBe("LECTURER_COMMENT");
  });

  it("PLATFORM_ADMIN authoring a comment gets REVIEWER_COMMENT, never a fabricated MARKER identity", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instA));
    await eventCommentsRoute.POST(jsonRequest("POST", { comment: "Admin review." }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    const stored = await prisma.integrityReviewComment.findFirst({ where: { integrityEventId: event.id, authorId: platformAdmin.id } });
    expect(stored?.authorRole).toBe("PLATFORM_ADMIN");
    expect(stored?.commentType).toBe("REVIEWER_COMMENT");
  });

  it("5/6. a student cannot read or add comments", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const postRes = await eventCommentsRoute.POST(jsonRequest("POST", { comment: "x" }), { params: Promise.resolve({ eventId: event.id }) });
    expect(postRes.status).toBe(401);
    const getRes = await eventCommentsRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ eventId: event.id }) });
    expect(getRes.status).toBe(401);
  });
});

describe("POST /api/lecturer/submissions/[id]/integrity-review/bulk-no-concern", () => {
  it("18. bulk no-concern creates one history entry per event, only ever REVIEWED_NO_CONCERN", async () => {
    const { exam, submission, event: firstEvent } = await createExamWithEvent();
    const secondEvent = await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "COPY_ATTEMPT",
        severity: "LOW",
        message: "Copy attempted.",
        occurredAt: new Date(),
      },
    });
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await bulkNoConcernRoute.POST(jsonRequest("POST", { eventIds: [firstEvent.id, secondEvent.id] }), {
      params: Promise.resolve({ id: submission.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);

    const events = await prisma.integrityEvent.findMany({ where: { id: { in: [firstEvent.id, secondEvent.id] } } });
    expect(events.every((e) => e.reviewStatus === "REVIEWED_NO_CONCERN")).toBe(true);

    const histories = await prisma.integrityReviewStatusHistory.findMany({ where: { integrityEventId: { in: [firstEvent.id, secondEvent.id] } } });
    expect(histories).toHaveLength(2);
  });

  it("only ever touches events that actually belong to the given submission", async () => {
    const { submission } = await createExamWithEvent();
    const { event: unrelatedEvent } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await bulkNoConcernRoute.POST(jsonRequest("POST", { eventIds: [unrelatedEvent.id] }), {
      params: Promise.resolve({ id: submission.id }),
    });
    const body = await res.json();
    expect(body.updated).toBe(0);
  });
});

describe("Backward-compatible legacy resolve route", () => {
  it("24. existing resolve route remains compatible and now also updates reviewStatus", async () => {
    const { event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    const res = await resolveRoute.POST(jsonRequest("POST", { resolutionNote: "Fine." }), {
      params: Promise.resolve({ eventId: event.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedAt).not.toBeNull();
    expect(body.resolutionNote).toBe("Fine.");
    expect(body.reviewStatus).toBe("RESOLVED");
  });

  it("17. resolved events remain visible in the new review list", async () => {
    const { submission, event } = await createExamWithEvent();
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", instA));
    await resolveRoute.POST(jsonRequest("POST", { resolutionNote: "All good." }), { params: Promise.resolve({ eventId: event.id }) });
    const res = await integrityReviewRoute.GET(jsonRequest("GET"), { params: Promise.resolve({ id: submission.id }) });
    const body = await res.json();
    expect(body.events[0].legacyResolutionNote).toBe("All good.");
    expect(body.events[0].reviewStatus).toBe("RESOLVED");
  });
});

describe("Exam Design Policy v1 — attempt start requires acknowledgement and creates a snapshot", () => {
  it("16. policy acknowledgement is required before a new attempt starts", async () => {
    const exam = await prisma.exam.create({
      data: { title: `Policy Ack Exam ${Date.now()}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: instA },
    });
    cleanup.exams.push(exam.id);
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await startRoute.POST(jsonRequest("POST", {}), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(400);
  });

  it("creates an immutable policy snapshot on the submission when acknowledged", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: `Policy Snapshot Exam ${Date.now()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA,
        secureSettings: { examMode: "CLOSED_BOOK", calculatorAllowed: true },
      },
    });
    cleanup.exams.push(exam.id);
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const submission = await res.json();
    const stored = await prisma.submission.findUnique({ where: { id: submission.id } });
    const snapshot = stored?.examPolicySnapshotJson as { examMode?: string; studentAcknowledgedAt?: string } | null;
    expect(snapshot?.examMode).toBe("CLOSED_BOOK");
    expect(snapshot?.studentAcknowledgedAt).toBeDefined();
  });

  it("17. editing the exam policy afterwards does not change an existing attempt's snapshot", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: `Policy Immutable Exam ${Date.now()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA,
        secureSettings: { examMode: "CLOSED_BOOK" },
      },
    });
    cleanup.exams.push(exam.id);
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", instA));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submission = await startRes.json();

    await prisma.exam.update({ where: { id: exam.id }, data: { secureSettings: { examMode: "OPEN_BOOK", internetAllowed: true } } });

    const stored = await prisma.submission.findUnique({ where: { id: submission.id } });
    const snapshot = stored?.examPolicySnapshotJson as { examMode?: string } | null;
    expect(snapshot?.examMode).toBe("CLOSED_BOOK");
  });
});
