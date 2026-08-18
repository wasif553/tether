/**
 * Tether Integrity Evidence Timeline v1 — see
 * docs/integrity-evidence-timeline-v1.md.
 *
 * DB-backed tests (requires the disposable release:validate Postgres —
 * see src/lib/prisma.ts's assertSafeDatabaseUrlForTests). Directly
 * exercises buildIntegrityEvidenceTimeline against real Prisma rows
 * rather than mocking, since the builder's whole job is merging/
 * deduplicating/ordering across several real tables.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  buildIntegrityEvidenceTimeline,
  IntegrityEvidenceTimelineForbiddenError,
  IntegrityEvidenceTimelineNotFoundError,
} from "./integrityEvidenceTimeline";
import { prisma } from "./prisma";
import { getOrCreateTestInstitution } from "./testInstitution";

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[], institutions: [] as string[] };

let instA: string;
let instB: string;
let lecturerA: { id: string };
let lecturerB: { id: string };
let platformAdmin: { id: string };
let studentA: { id: string };

function sessionFor(userId: string, role: "LECTURER" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  } as unknown as Parameters<typeof buildIntegrityEvidenceTimeline>[1];
}

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`timeline-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`timeline-b-${stamp}`);
  instA = a.id;
  instB = b.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "Timeline Lecturer A", email: `tl-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  lecturerB = await prisma.user.create({
    data: { name: "Timeline Lecturer B", email: `tl-lect-b-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  platformAdmin = await prisma.user.create({
    data: { name: "Timeline Admin", email: `tl-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "Timeline Student", email: `tl-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, lecturerB.id, platformAdmin.id, studentA.id);
});

afterAll(async () => {
  await prisma.integrityEvidenceAsset.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.answerActivityEvent.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.secureClientEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.aiAssistanceInteraction.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.sessionIntegritySignal.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.timingIntegritySignal.deleteMany({ where: { analysis: { examId: { in: cleanup.exams } } } });
  await prisma.timingAnalysis.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.answer.deleteMany({ where: { submission: { examId: { in: cleanup.exams } } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.question.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamAndSubmission(opts: { institutionId?: string; startedAt?: Date; activatedAt?: Date | null; submittedAt?: Date | null } = {}) {
  const exam = await prisma.exam.create({
    data: {
      title: `Timeline Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerA.id,
      institutionId: opts.institutionId ?? instA,
    },
  });
  cleanup.exams.push(exam.id);
  const q1 = await prisma.question.create({ data: { examId: exam.id, type: "ESSAY", text: "Q1", points: 5, order: 0 } });
  const q2 = await prisma.question.create({ data: { examId: exam.id, type: "ESSAY", text: "Q2", points: 5, order: 1 } });
  const submission = await prisma.submission.create({
    data: {
      examId: exam.id,
      studentId: studentA.id,
      status: "IN_PROGRESS",
      startedAt: opts.startedAt ?? new Date(),
      activatedAt: opts.activatedAt === undefined ? (opts.startedAt ?? new Date()) : opts.activatedAt,
      submittedAt: opts.submittedAt ?? null,
    },
  });
  return { exam, q1, q2, submission };
}

async function createIntegrityEvent(opts: {
  submissionId: string;
  examId: string;
  eventType: string;
  severity?: string;
  message?: string;
  occurredAt?: Date;
  createdAtOverride?: Date;
  reviewStatus?: string;
  metadataJson?: unknown;
}) {
  const row = await prisma.integrityEvent.create({
    data: {
      submissionId: opts.submissionId,
      examId: opts.examId,
      studentId: studentA.id,
      eventType: opts.eventType as never,
      severity: (opts.severity ?? "INFO") as never,
      message: opts.message ?? "Test event",
      occurredAt: opts.occurredAt ?? new Date(),
      reviewStatus: opts.reviewStatus ?? "NEEDS_REVIEW",
      metadataJson: (opts.metadataJson as never) ?? undefined,
    },
  });
  if (opts.createdAtOverride) {
    await prisma.integrityEvent.update({ where: { id: row.id }, data: { createdAt: opts.createdAtOverride } });
    return prisma.integrityEvent.findUniqueOrThrow({ where: { id: row.id } });
  }
  return row;
}

describe("buildIntegrityEvidenceTimeline — authorization", () => {
  it("1. the owning lecturer may access the timeline", async () => {
    const { submission } = await createExamAndSubmission();
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.submissionId).toBe(submission.id);
  });

  it("2. another lecturer at the SAME institution who does not own the exam is forbidden", async () => {
    const { submission } = await createExamAndSubmission();
    await expect(
      buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerB.id, "LECTURER", instA)),
    ).rejects.toBeInstanceOf(IntegrityEvidenceTimelineForbiddenError);
  });

  it("3. a lecturer at a DIFFERENT institution is forbidden, even if somehow the owner id matched", async () => {
    const { submission } = await createExamAndSubmission();
    await expect(
      buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instB)),
    ).rejects.toBeInstanceOf(IntegrityEvidenceTimelineForbiddenError);
  });

  it("4. a platform admin may access any institution's timeline", async () => {
    const { submission } = await createExamAndSubmission();
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(platformAdmin.id, "PLATFORM_ADMIN", instB));
    expect(timeline.submissionId).toBe(submission.id);
  });

  it("5. a nonexistent submission throws Not Found, not a generic error", async () => {
    await expect(
      buildIntegrityEvidenceTimeline("does-not-exist", sessionFor(lecturerA.id, "LECTURER", instA)),
    ).rejects.toBeInstanceOf(IntegrityEvidenceTimelineNotFoundError);
  });
});

describe("buildIntegrityEvidenceTimeline — lifecycle rows", () => {
  it("6. always includes 'Attempt started' from Submission.startedAt", async () => {
    const { submission } = await createExamAndSubmission();
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const started = timeline.events.find((e) => e.technicalEventType === "SUBMISSION_STARTED");
    expect(started?.label).toBe("Attempt started");
    expect(started?.category).toBe("LIFECYCLE");
  });

  it("7. omits 'Exam content unlocked' when activatedAt is not materially distinct from startedAt", async () => {
    const now = new Date();
    const { submission } = await createExamAndSubmission({ startedAt: now, activatedAt: now });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.find((e) => e.technicalEventType === "SUBMISSION_ACTIVATED")).toBeUndefined();
  });

  it("8. includes 'Exam content unlocked' when activatedAt is materially later than startedAt", async () => {
    const started = new Date(Date.now() - 10 * 60_000);
    const activated = new Date(Date.now() - 5 * 60_000);
    const { submission } = await createExamAndSubmission({ startedAt: started, activatedAt: activated });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const unlocked = timeline.events.find((e) => e.technicalEventType === "SUBMISSION_ACTIVATED");
    expect(unlocked?.label).toBe("Exam content unlocked in secure session");
  });

  it("9. includes 'Exam submitted' only when submittedAt is present", async () => {
    const { submission: withoutSubmit } = await createExamAndSubmission();
    const t1 = await buildIntegrityEvidenceTimeline(withoutSubmit.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(t1.events.find((e) => e.technicalEventType === "SUBMISSION_SUBMITTED")).toBeUndefined();

    const { submission: withSubmit } = await createExamAndSubmission({ submittedAt: new Date() });
    const t2 = await buildIntegrityEvidenceTimeline(withSubmit.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(t2.events.find((e) => e.technicalEventType === "SUBMISSION_SUBMITTED")?.label).toBe("Exam submitted");
  });

  it("30. a submission with no other recorded activity still returns a valid single-row timeline (zero-event case)", async () => {
    const now = new Date();
    const { submission } = await createExamAndSubmission({ startedAt: now, activatedAt: now });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events).toHaveLength(1);
    expect(timeline.summary.totalEvents).toBe(1);
    expect(timeline.summary.evidenceAssetCount).toBe(0);
    expect(timeline.summary.needsReviewCount).toBe(0);
  });
});

describe("buildIntegrityEvidenceTimeline — question/answer activity", () => {
  it("10. includes QUESTION_OPENED", async () => {
    const { submission, q1 } = await createExamAndSubmission();
    await prisma.answerActivityEvent.create({
      data: { submissionId: submission.id, questionId: q1.id, eventType: "QUESTION_OPENED" },
    });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const opened = timeline.events.find((e) => e.technicalEventType === "QUESTION_OPENED");
    expect(opened?.label).toBe("Question opened");
    expect(opened?.questionNumber).toBe(1);
  });

  it("11. includes ANSWER_SAVED with a safe response-length detail, never the response text or hash", async () => {
    const { submission, q2 } = await createExamAndSubmission();
    await prisma.answerActivityEvent.create({
      data: {
        submissionId: submission.id,
        questionId: q2.id,
        eventType: "ANSWER_SAVED",
        responseLength: 326,
        responseHash: "some-hmac-hash-value",
      },
    });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const saved = timeline.events.find((e) => e.technicalEventType === "ANSWER_SAVED");
    expect(saved?.label).toBe("Answer saved");
    expect(saved?.detail).toBe("Response length: 326 characters");
    expect(saved?.questionNumber).toBe(2);
    expect(JSON.stringify(saved)).not.toContain("some-hmac-hash-value");
  });

  it("14. question association resolves to the correct 1-based question number from Question.order", async () => {
    const { submission, q1, q2 } = await createExamAndSubmission();
    await prisma.answerActivityEvent.create({ data: { submissionId: submission.id, questionId: q1.id, eventType: "QUESTION_OPENED" } });
    await prisma.answerActivityEvent.create({ data: { submissionId: submission.id, questionId: q2.id, eventType: "QUESTION_OPENED" } });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const rows = timeline.events.filter((e) => e.technicalEventType === "QUESTION_OPENED");
    expect(rows.find((r) => r.questionId === q1.id)?.questionNumber).toBe(1);
    expect(rows.find((r) => r.questionId === q2.id)?.questionNumber).toBe(2);
  });

  it("10/11. excludes HEARTBEAT, PAGE_HIDDEN, and PAGE_VISIBLE — pure connectivity telemetry noise", async () => {
    const { submission } = await createExamAndSubmission();
    await prisma.answerActivityEvent.create({ data: { submissionId: submission.id, eventType: "HEARTBEAT" } });
    await prisma.answerActivityEvent.create({ data: { submissionId: submission.id, eventType: "PAGE_HIDDEN" } });
    await prisma.answerActivityEvent.create({ data: { submissionId: submission.id, eventType: "PAGE_VISIBLE" } });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.some((e) => e.technicalEventType === "HEARTBEAT")).toBe(false);
    expect(timeline.events.some((e) => e.technicalEventType === "PAGE_HIDDEN")).toBe(false);
    expect(timeline.events.some((e) => e.technicalEventType === "PAGE_VISIBLE")).toBe(false);
  });

  it("12. excludes ATTEMPT_STARTED and ATTEMPT_SUBMITTED telemetry — already represented by Submission lifecycle rows", async () => {
    const { submission } = await createExamAndSubmission();
    await prisma.answerActivityEvent.create({ data: { submissionId: submission.id, eventType: "ATTEMPT_STARTED" } });
    await prisma.answerActivityEvent.create({ data: { submissionId: submission.id, eventType: "ATTEMPT_SUBMITTED" } });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.some((e) => e.technicalEventType === "ATTEMPT_STARTED")).toBe(false);
    expect(timeline.events.some((e) => e.technicalEventType === "ATTEMPT_SUBMITTED")).toBe(false);
    // Only the one Submission-lifecycle "Attempt started" row represents this fact.
    expect(timeline.events.filter((e) => e.label === "Attempt started")).toHaveLength(1);
  });

  it("9. QUESTION_NAVIGATED is excluded from AnswerActivityEvent — it is a confirmed duplicate of the IntegrityEvent navigation row created in the same request", async () => {
    const { submission, q1 } = await createExamAndSubmission();
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "QUESTION_NAVIGATED_NEXT", message: "Moved to the next question." });
    await prisma.answerActivityEvent.create({ data: { submissionId: submission.id, questionId: q1.id, eventType: "QUESTION_NAVIGATED", questionIndex: 1 } });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.filter((e) => e.label === "Moved to next question")).toHaveLength(1);
    expect(timeline.events.some((e) => e.technicalEventType === "QUESTION_NAVIGATED")).toBe(false);
  });
});

describe("buildIntegrityEvidenceTimeline — IntegrityEvent backbone", () => {
  it("13. human-readable labels are used, never the raw event code, for common types", async () => {
    const { submission } = await createExamAndSubmission();
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "WINDOW_BLUR", message: "Window lost focus." });
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "WINDOW_FOCUS_RETURN", message: "Window regained focus." });
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "COPY_ATTEMPT", message: "Copy attempted." });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.map((e) => e.label)).toEqual(
      expect.arrayContaining(["Window focus lost", "Window focus restored", "Copy attempt"]),
    );
  });

  it("17. screen-share interrupted then restored renders as two distinct, correctly ordered rows", async () => {
    const { submission } = await createExamAndSubmission();
    const t1 = new Date(Date.now() - 60_000);
    const t2 = new Date();
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "SCREEN_SHARE_INTERRUPTED", occurredAt: t1, createdAtOverride: t1, message: "Screen sharing interrupted." });
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "SCREEN_SHARE_RESTORED", occurredAt: t2, createdAtOverride: t2, message: "Screen sharing restored." });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const labels = timeline.events.map((e) => e.label);
    const interruptedIdx = labels.indexOf("Screen sharing interrupted — needs review");
    const restoredIdx = labels.indexOf("Screen sharing restored");
    expect(interruptedIdx).toBeGreaterThan(-1);
    expect(restoredIdx).toBeGreaterThan(interruptedIdx);
  });

  it("15/16. an evidence asset attaches to its parent IntegrityEvent row exactly once, never a separate row", async () => {
    const { submission, exam } = await createExamAndSubmission();
    const event = await createIntegrityEvent({ submissionId: submission.id, examId: exam.id, eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED", message: "Evidence frame captured." });
    await prisma.integrityEvidenceAsset.create({
      data: {
        integrityEventId: event.id,
        submissionId: submission.id,
        examId: exam.id,
        institutionId: instA,
        kind: "SCREEN_SHARE_EVIDENCE_FRAME",
        eventType: "SCREEN_SHARE_EVIDENCE_CAPTURED",
        storageProvider: "local_dev",
        storageKey: "opaque-key-never-exposed",
        contentType: "image/webp",
        byteSize: 12_345,
      },
    });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const rowsForThisFact = timeline.events.filter((e) => e.technicalEventType === "SCREEN_SHARE_EVIDENCE_CAPTURED");
    expect(rowsForThisFact).toHaveLength(1);
    expect(rowsForThisFact[0].evidenceAssets).toHaveLength(1);
    expect(rowsForThisFact[0].evidenceAssets[0].kind).toBe("SCREEN_SHARE_EVIDENCE_FRAME");
    expect(rowsForThisFact[0].category).toBe("EVIDENCE");
    expect(JSON.stringify(rowsForThisFact[0])).not.toContain("opaque-key-never-exposed");
  });

  it("29. an IntegrityEvent with no evidence asset never fabricates one", async () => {
    const { submission } = await createExamAndSubmission();
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "CAMERA_TOO_DARK", message: "Lighting too low." });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const row = timeline.events.find((e) => e.technicalEventType === "CAMERA_TOO_DARK");
    expect(row?.evidenceAssets).toEqual([]);
  });

  it("34. client-suppliable occurredAt never controls sort order — createdAt (server-authoritative) always drives ordering", async () => {
    const { submission } = await createExamAndSubmission();
    const genuineNow = new Date();
    const earlierRealEvent = new Date(genuineNow.getTime() - 30_000);
    const farFutureOccurredAt = new Date(genuineNow.getTime() + 10 * 60 * 60_000); // a skewed/malicious client-reported time

    await createIntegrityEvent({
      submissionId: submission.id,
      examId: submission.examId,
      eventType: "WINDOW_BLUR",
      occurredAt: farFutureOccurredAt, // client-reported, far in the future
      createdAtOverride: genuineNow, // server actually received it now
      message: "Window lost focus.",
    });
    await createIntegrityEvent({
      submissionId: submission.id,
      examId: submission.examId,
      eventType: "COPY_ATTEMPT",
      occurredAt: earlierRealEvent,
      createdAtOverride: new Date(genuineNow.getTime() + 1000), // server received this one slightly LATER
      message: "Copy attempted.",
    });

    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const labels = timeline.events.map((e) => e.label).filter((l) => l === "Window focus lost" || l === "Copy attempt");
    // WINDOW_BLUR's createdAt (genuineNow) is earlier than COPY_ATTEMPT's createdAt
    // (genuineNow + 1000ms), so it must sort first — even though its
    // client-reported occurredAt is 10 hours in the future.
    expect(labels).toEqual(["Window focus lost", "Copy attempt"]);

    const blurRow = timeline.events.find((e) => e.label === "Window focus lost");
    expect(blurRow?.deviceReportedTimestamp).toBe(farFutureOccurredAt.toISOString());
  });

  it("32. malformed metadataJson never throws and is never blindly trusted", async () => {
    const { submission } = await createExamAndSubmission();
    await createIntegrityEvent({
      submissionId: submission.id,
      examId: submission.examId,
      eventType: "POSSIBLE_PHONE_VISIBLE",
      message: "Possible phone visible.",
      metadataJson: { confidenceBand: 12345, unexpectedField: { nested: true } },
    });
    await expect(
      buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA)),
    ).resolves.toBeDefined();
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const row = timeline.events.find((e) => e.technicalEventType === "POSSIBLE_PHONE_VISIBLE");
    expect(row?.technicalDetails?.some((d) => d.label === "Confidence")).toBe(false);
  });

  it("review status is reused exactly, using the existing 5-state vocabulary", async () => {
    const { submission } = await createExamAndSubmission();
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "WINDOW_BLUR", reviewStatus: "REVIEWED_NO_CONCERN" });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const row = timeline.events.find((e) => e.technicalEventType === "WINDOW_BLUR");
    expect(row?.reviewState).toEqual({ status: "REVIEWED_NO_CONCERN", label: "Reviewed — no concern" });
  });

  it("needsReviewCount in the summary matches the actual NEEDS_REVIEW rows", async () => {
    const { submission } = await createExamAndSubmission();
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "WINDOW_BLUR", reviewStatus: "NEEDS_REVIEW" });
    await createIntegrityEvent({ submissionId: submission.id, examId: submission.examId, eventType: "COPY_ATTEMPT", reviewStatus: "REVIEWED_NO_CONCERN" });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.summary.needsReviewCount).toBe(1);
  });
});

describe("buildIntegrityEvidenceTimeline — secure-client events", () => {
  it("18. display present then display policy restored renders as two distinct, correctly ordered rows", async () => {
    const { submission, exam } = await createExamAndSubmission();
    const t1 = new Date(Date.now() - 60_000);
    const t2 = new Date();
    await prisma.secureClientEvent.create({
      data: { submissionId: submission.id, examId: exam.id, institutionId: instA, eventType: "ADDITIONAL_DISPLAY_PRESENT", eventLevel: "ACTION_REQUIRED", serverReceivedAt: t1 },
    });
    await prisma.secureClientEvent.create({
      data: { submissionId: submission.id, examId: exam.id, institutionId: instA, eventType: "DISPLAY_POLICY_RESTORED", eventLevel: "CONTEXT", serverReceivedAt: t2 },
    });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const labels = timeline.events.map((e) => e.label);
    const presentIdx = labels.indexOf("Additional display detected");
    const restoredIdx = labels.indexOf("Additional display removed");
    expect(presentIdx).toBeGreaterThan(-1);
    expect(restoredIdx).toBeGreaterThan(presentIdx);
  });

  it("session interrupted then recovered renders as two distinct rows", async () => {
    const { submission, exam } = await createExamAndSubmission();
    await prisma.secureClientEvent.create({
      data: { submissionId: submission.id, examId: exam.id, institutionId: instA, eventType: "SECURE_CLIENT_INTERRUPTED", eventLevel: "CONTEXT" },
    });
    await prisma.secureClientEvent.create({
      data: { submissionId: submission.id, examId: exam.id, institutionId: instA, eventType: "SECURE_CLIENT_RECOVERED", eventLevel: "INFORMATIONAL" },
    });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.some((e) => e.label === "Secure session interrupted")).toBe(true);
    expect(timeline.events.some((e) => e.label === "Secure session recovered")).toBe(true);
  });

  it("excludes pure technical/launch/preflight secure-client events not on the allowlist", async () => {
    const { submission, exam } = await createExamAndSubmission();
    for (const eventType of ["SECURE_CLIENT_LAUNCH_REQUESTED", "PREFLIGHT_STARTED", "HEARTBEAT_MISSED", "AUTOSAVE_PENDING_COUNT_REPORTED"]) {
      await prisma.secureClientEvent.create({
        data: { submissionId: submission.id, examId: exam.id, institutionId: instA, eventType, eventLevel: "INFORMATIONAL" },
      });
    }
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.filter((e) => e.source === "SECURE_CLIENT")).toHaveLength(0);
  });

  it("19. a mirrored native incident (SecureClientEvent REMOTE_SESSION_SIGNAL + the promoted IntegrityEvent) is deduplicated — only the IntegrityEvent row appears", async () => {
    const { submission, exam } = await createExamAndSubmission();
    await prisma.secureClientEvent.create({
      data: { submissionId: submission.id, examId: exam.id, institutionId: instA, eventType: "REMOTE_SESSION_SIGNAL", eventLevel: "REVIEW_CONTEXT" },
    });
    await createIntegrityEvent({ submissionId: submission.id, examId: exam.id, eventType: "REMOTE_CONTROL_SOFTWARE_DETECTED", message: "Remote-control software detected." });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.filter((e) => e.label.startsWith("Remote-control software detected"))).toHaveLength(1);
    expect(timeline.events.some((e) => e.source === "SECURE_CLIENT")).toBe(false);
  });
});

describe("buildIntegrityEvidenceTimeline — Controlled AI (deduplication and semantics)", () => {
  async function createInteraction(
    overrides: {
      status?: string;
      approvedResponse?: string | null;
      wasRegenerated?: boolean;
      studentPrompt?: string;
      riskScore?: number;
      cumulativeRiskScore?: number;
    },
    submissionId: string,
    examId: string,
    questionId: string,
  ) {
    return prisma.aiAssistanceInteraction.create({
      data: {
        submissionId,
        questionId,
        examId,
        studentId: studentA.id,
        studentPrompt: overrides.studentPrompt ?? "Can you help me understand this question?",
        approvedResponse: overrides.approvedResponse ?? "Think about what the question is really asking.",
        status: overrides.status ?? "APPROVED",
        wasRegenerated: overrides.wasRegenerated ?? false,
        promptNumberForQuestion: 1,
        promptNumberForAttempt: 1,
        policyVersion: "v1.0",
        riskScore: overrides.riskScore ?? 0,
        cumulativeRiskScore: overrides.cumulativeRiskScore ?? 0,
      },
    });
  }

  it("20. APPROVED renders as 'guidance shown', allowed-resource semantics", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    await createInteraction({ status: "APPROVED" }, submission.id, exam.id, q1.id);
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const row = timeline.events.find((e) => e.source === "AI_ASSISTANCE");
    expect(row?.label).toBe("Tether Controlled AI guidance shown");
    expect(row?.detail).toBe("Allowed under this attempt's policy");
    expect(row?.category).toBe("ALLOWED_RESOURCE");
    expect(row?.severity).toBe("INFO");
  });

  it("21. FALLBACK renders as 'safe fallback shown', allowed-resource semantics", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    await createInteraction({ status: "FALLBACK", approvedResponse: "Generic guidance." }, submission.id, exam.id, q1.id);
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const row = timeline.events.find((e) => e.source === "AI_ASSISTANCE");
    expect(row?.label).toBe("Tether Controlled AI safe fallback shown");
    expect(row?.detail).toBe("Allowed under this attempt's policy");
  });

  it("22. BLOCKED renders as 'request declined', severity stays INFO (never a risk signal)", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    await createInteraction({ status: "BLOCKED", approvedResponse: null }, submission.id, exam.id, q1.id);
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const row = timeline.events.find((e) => e.source === "AI_ASSISTANCE");
    expect(row?.label).toBe("Tether Controlled AI request declined");
    expect(row?.severity).toBe("INFO");
  });

  it("23. FAILED renders as 'could not be completed'", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    await createInteraction({ status: "FAILED", approvedResponse: null }, submission.id, exam.id, q1.id);
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const row = timeline.events.find((e) => e.source === "AI_ASSISTANCE");
    expect(row?.label).toBe("Tether Controlled AI request could not be completed");
  });

  it("24. a regenerated APPROVED interaction is represented exactly once, with a regeneration note in technicalDetails, not as a second row", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    await createInteraction({ status: "APPROVED", wasRegenerated: true }, submission.id, exam.id, q1.id);
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const rows = timeline.events.filter((e) => e.source === "AI_ASSISTANCE");
    expect(rows).toHaveLength(1);
    expect(rows[0].technicalDetails?.some((d) => d.label === "Regenerated")).toBe(true);
  });

  it("25. the mirrored AI_ASSISTANCE_USED IntegrityEvent is suppressed when an AiAssistanceInteraction already represents the same outcome", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    await createInteraction({ status: "APPROVED" }, submission.id, exam.id, q1.id);
    await createIntegrityEvent({ submissionId: submission.id, examId: exam.id, eventType: "AI_ASSISTANCE_USED", message: "AI brainstorming assistance was used." });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.filter((e) => e.category === "ALLOWED_RESOURCE" && e.technicalEventType?.startsWith("AI_ASSISTANCE_INTERACTION"))).toHaveLength(1);
    expect(timeline.events.some((e) => e.technicalEventType === "AI_ASSISTANCE_USED")).toBe(false);
  });

  it("26. AI_ASSISTANCE_LIMIT_REACHED remains visible — it has no corresponding AiAssistanceInteraction row to prefer instead", async () => {
    const { submission, exam } = await createExamAndSubmission();
    await createIntegrityEvent({ submissionId: submission.id, examId: exam.id, eventType: "AI_ASSISTANCE_LIMIT_REACHED", message: "AI brainstorming assistance prompt limit reached." });
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const row = timeline.events.find((e) => e.technicalEventType === "AI_ASSISTANCE_LIMIT_REACHED");
    expect(row).toBeDefined();
    expect(row?.category).toBe("ALLOWED_RESOURCE");
  });

  it("a non-stale RESERVED interaction is excluded (not yet a completed fact); a stale one normalizes to FAILED, matching aiAssistanceReview.ts", async () => {
    const { submission, exam, q1, q2 } = await createExamAndSubmission();
    await createInteraction({ status: "RESERVED", approvedResponse: null }, submission.id, exam.id, q1.id);
    const stale = await createInteraction({ status: "RESERVED", approvedResponse: null }, submission.id, exam.id, q2.id);
    await prisma.aiAssistanceInteraction.update({ where: { id: stale.id }, data: { createdAt: new Date(Date.now() - 200_000) } });

    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const rows = timeline.events.filter((e) => e.source === "AI_ASSISTANCE");
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Tether Controlled AI request could not be completed");
  });

  it("27/28. no AI row anywhere uses risk/misconduct wording", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    for (const status of ["APPROVED", "BLOCKED", "FAILED"] as const) {
      await createInteraction({ status, approvedResponse: status === "APPROVED" ? "guidance" : null }, submission.id, exam.id, q1.id);
    }
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const aiRows = timeline.events.filter((e) => e.source === "AI_ASSISTANCE");
    expect(aiRows.length).toBeGreaterThan(0);
    for (const row of aiRows) {
      const text = `${row.label} ${row.detail ?? ""}`.toLowerCase();
      expect(text).not.toMatch(/risk|misconduct|suspicion|cheat|guilty/);
      expect(row.severity).toBe("INFO");
    }
  });

  it("33. never exposes the student prompt, approved response text, or risk scores anywhere in the timeline output", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    await createInteraction(
      { status: "APPROVED", studentPrompt: "UNIQUE_SECRET_PROMPT_TEXT", approvedResponse: "UNIQUE_SECRET_RESPONSE_TEXT", riskScore: 0.9, cumulativeRiskScore: 1.9 },
      submission.id,
      exam.id,
      q1.id,
    );
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const serialized = JSON.stringify(timeline);
    expect(serialized).not.toContain("UNIQUE_SECRET_PROMPT_TEXT");
    expect(serialized).not.toContain("UNIQUE_SECRET_RESPONSE_TEXT");
    expect(serialized).not.toMatch(/riskScore|cumulativeRiskScore/);
  });
});

describe("buildIntegrityEvidenceTimeline — session/timing review signals stay out of the chronological stream", () => {
  it("18. SessionIntegritySignal/TimingIntegritySignal never appear as chronological rows, only as aggregate awaiting-review counts", async () => {
    const { submission, exam } = await createExamAndSubmission();
    await prisma.sessionIntegritySignal.create({
      data: { submissionId: submission.id, signalType: "NETWORK_PREFIX_CHANGED", signalLevel: "LOW", explanation: "Network prefix changed.", reviewStatus: "NEEDS_REVIEW" },
    });
    await prisma.sessionIntegritySignal.create({
      data: { submissionId: submission.id, signalType: "DEVICE_TOKEN_CHANGED", signalLevel: "MEDIUM", explanation: "Device token changed.", reviewStatus: "REVIEWED_NO_CONCERN" },
    });
    const analysis = await prisma.timingAnalysis.create({
      data: { submissionId: submission.id, examId: exam.id, algorithmVersion: "v1", requestedById: lecturerA.id },
    });
    await prisma.timingIntegritySignal.create({
      data: { analysisId: analysis.id, signalType: "EXTREMELY_FAST_ATTEMPT", signalLevel: "MEDIUM", explanation: "Very fast attempt.", reviewStatus: "NEEDS_REVIEW" },
    });

    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.some((e) => e.technicalEventType?.includes("NETWORK_PREFIX_CHANGED"))).toBe(false);
    expect(timeline.events.some((e) => e.technicalEventType?.includes("EXTREMELY_FAST_ATTEMPT"))).toBe(false);
    expect(timeline.summary.relatedSessionSignals).toBe(1); // only the NEEDS_REVIEW one
    expect(timeline.summary.relatedTimingSignals).toBe(1);
  });
});

describe("buildIntegrityEvidenceTimeline — chronological merge and legacy/partial data", () => {
  it("4/5. merges every source into one chronologically sorted stream, with deterministic tie-breaking for equal timestamps", async () => {
    const { submission, exam, q1 } = await createExamAndSubmission();
    const sharedTimestamp = new Date();

    await createIntegrityEvent({ submissionId: submission.id, examId: exam.id, eventType: "WINDOW_BLUR", occurredAt: sharedTimestamp, createdAtOverride: sharedTimestamp, message: "Window lost focus." });
    await prisma.secureClientEvent.create({
      data: { submissionId: submission.id, examId: exam.id, institutionId: instA, eventType: "SECURE_CLIENT_INTERRUPTED", eventLevel: "CONTEXT", serverReceivedAt: sharedTimestamp },
    });
    await prisma.answerActivityEvent.create({
      data: { submissionId: submission.id, questionId: q1.id, eventType: "ANSWER_SAVED", responseLength: 10, serverReceivedAt: sharedTimestamp },
    });

    const timelineFirst = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const timelineSecond = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    // Ordering for the three exactly-equal-timestamp rows must be identical across repeated builds.
    const orderFirst = timelineFirst.events.filter((e) => e.timestamp === sharedTimestamp.toISOString()).map((e) => e.source);
    const orderSecond = timelineSecond.events.filter((e) => e.timestamp === sharedTimestamp.toISOString()).map((e) => e.source);
    expect(orderFirst).toEqual(orderSecond);
    // Matches the documented SOURCE_RANK: INTEGRITY_EVENT(1) before SECURE_CLIENT(2) before ANSWER_ACTIVITY(3).
    expect(orderFirst).toEqual(["INTEGRITY_EVENT", "SECURE_CLIENT", "ANSWER_ACTIVITY"]);
  });

  it("31. a legacy submission with no secure-client events, no AI assistance, and no evidence still builds a valid, minimal timeline", async () => {
    const { submission } = await createExamAndSubmission();
    const timeline = await buildIntegrityEvidenceTimeline(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(timeline.events.length).toBeGreaterThan(0); // at least the lifecycle row
    expect(timeline.summary.evidenceAssetCount).toBe(0);
    expect(timeline.summary.relatedSessionSignals).toBe(0);
    expect(timeline.summary.relatedTimingSignals).toBe(0);
  });
});
