/**
 * Secure Exam Evidence Review audit v1 — DB-backed tests for
 * src/lib/evidenceReport.ts's `lockdownDetectionSummary` (new) and the
 * CSV export's screen-share/lockdown summary blocks (new, and a
 * pre-existing gap — `screenShareIntegritySummary` was silently missing
 * from the CSV export before this pass). See
 * docs/secure-exam-evidence-review-audit-v1.md.
 *
 * Requires the local test Postgres instance, following the same pattern
 * as screenShareEvidence.routes.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { getOrCreateTestInstitution } from "./testInstitution";
import { buildEvidenceReport, evidenceReportToCsv } from "./evidenceReport";

function sessionFor(userId: string, role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN", institutionId: string) {
  return {
    user: { id: userId, email: `${userId}@test.local`, name: userId, role, institutionId },
    expires: new Date(Date.now() + 86_400_000).toISOString(),
  } as unknown as import("next-auth").Session;
}

const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[] };

let instA: string;
let lecturerA: { id: string };
let studentA: { id: string };

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`evidence-report-${stamp}`);
  instA = a.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturerA = await prisma.user.create({
    data: { name: "ER Lecturer A", email: `er-lect-a-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instA },
  });
  studentA = await prisma.user.create({
    data: { name: "ER Student A", email: `er-stud-a-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instA },
  });
  cleanup.users.push(lecturerA.id, studentA.id);
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExamAndSubmission() {
  const exam = await prisma.exam.create({
    data: {
      title: `Evidence Report Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerA.id,
      institutionId: instA,
    },
  });
  cleanup.exams.push(exam.id);
  const submission = await prisma.submission.create({
    data: { examId: exam.id, studentId: studentA.id, status: "IN_PROGRESS" },
  });
  return { exam, submission };
}

describe("lockdownDetectionSummary", () => {
  it("is null when no lockdown detection event was recorded", async () => {
    const { submission } = await createExamAndSubmission();
    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(report.lockdownDetectionSummary).toBeNull();
  });

  it("counts each lockdown detection event type independently", async () => {
    const { exam, submission } = await createExamAndSubmission();
    const eventTypes = [
      "REMOTE_CONTROL_SOFTWARE_DETECTED",
      "REMOTE_CONTROL_SOFTWARE_DETECTED",
      "SCREEN_CAPTURE_SOFTWARE_DETECTED",
      "DEBUGGING_TOOL_DETECTED",
      "PROHIBITED_APPLICATION_DETECTED",
      "PROHIBITED_APPLICATION_CLOSED",
    ] as const;
    for (const eventType of eventTypes) {
      await prisma.integrityEvent.create({
        data: {
          submissionId: submission.id,
          examId: exam.id,
          studentId: studentA.id,
          eventType,
          severity: eventType === "PROHIBITED_APPLICATION_CLOSED" ? "INFO" : "MEDIUM",
          message: "Lockdown detection signal for test.",
          occurredAt: new Date(),
        },
      });
    }

    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(report.lockdownDetectionSummary).not.toBeNull();
    expect(report.lockdownDetectionSummary).toMatchObject({
      remoteControlCount: 2,
      screenCaptureCount: 1,
      debuggingToolCount: 1,
      prohibitedApplicationCount: 1,
      closedCount: 1,
    });
    // Never framed as a finding — always a review-signal disclaimer.
    expect(report.lockdownDetectionSummary?.disclaimer.toLowerCase()).toContain("not");
    expect(report.lockdownDetectionSummary?.disclaimer.toLowerCase()).not.toContain("confirmed");
  });

  it("does not count an unrelated event type", async () => {
    const { exam, submission } = await createExamAndSubmission();
    await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "WINDOW_BLUR",
        severity: "LOW",
        message: "Unrelated event for test.",
        occurredAt: new Date(),
      },
    });
    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(report.lockdownDetectionSummary).toBeNull();
  });
});

describe("remoteSessionDetail — mid-exam remote-session monitoring v1", () => {
  it("is null for an event without REMOTE_DESKTOP_SESSION metadata (including other lockdown detections)", async () => {
    const { exam, submission } = await createExamAndSubmission();
    await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "SCREEN_CAPTURE_SOFTWARE_DETECTED",
        severity: "MEDIUM",
        message: "OBS Studio was detected.",
        occurredAt: new Date(),
        metadataJson: { capabilityId: "OBS", category: "CAPTURE_OVERLAY", policyAction: "BLOCK_DURING_EXAM" },
      },
    });
    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(report.events).toHaveLength(1);
    expect(report.events[0].remoteSessionDetail).toBeNull();
  });

  it("surfaces the full remote-session metadata for a BECAME_ACTIVE (REMOTE_CONTROL_SOFTWARE_DETECTED) event", async () => {
    const { exam, submission } = await createExamAndSubmission();
    await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "REMOTE_CONTROL_SOFTWARE_DETECTED",
        severity: "MEDIUM",
        message: "A Remote Desktop session was detected — needs review.",
        occurredAt: new Date(),
        metadataJson: {
          capabilityId: "REMOTE_DESKTOP_SESSION",
          category: "REMOTE_CONTROL",
          policyAction: "BLOCK_DURING_EXAM",
          detectionSource: "WINDOWS_SESSION_API",
          previousState: "INACTIVE",
          currentState: "ACTIVE",
          sessionType: "REMOTE_DESKTOP_SESSION",
          checkConfidence: "BOTH_AGREE",
          tetherVersion: "1.8.0",
          secureClientSessionId: "session-xyz",
          detectedAtMs: Date.now(),
        },
      },
    });
    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(report.events).toHaveLength(1);
    expect(report.events[0].remoteSessionDetail).toEqual({
      detectionSource: "WINDOWS_SESSION_API",
      sessionType: "REMOTE_DESKTOP_SESSION",
      checkConfidence: "BOTH_AGREE",
      previousState: "INACTIVE",
      currentState: "ACTIVE",
      tetherVersion: "1.8.0",
      secureClientSessionId: "session-xyz",
    });
    // Also counted in the existing lockdown detection summary — reuse, not a new signal type.
    expect(report.lockdownDetectionSummary).toMatchObject({ remoteControlCount: 1 });
  });

  it("surfaces remote-session metadata for a BECAME_INACTIVE (PROHIBITED_APPLICATION_CLOSED) event too", async () => {
    const { exam, submission } = await createExamAndSubmission();
    await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "PROHIBITED_APPLICATION_CLOSED",
        severity: "INFO",
        message: "The Remote Desktop session ended.",
        occurredAt: new Date(),
        metadataJson: {
          capabilityId: "REMOTE_DESKTOP_SESSION",
          category: "REMOTE_CONTROL",
          detectionSource: "WINDOWS_SESSION_API",
          previousState: "ACTIVE",
          currentState: "INACTIVE",
          sessionType: null,
          checkConfidence: "BOTH_AGREE",
          tetherVersion: "1.8.0",
          secureClientSessionId: "session-xyz",
          durationMs: 5000,
        },
      },
    });
    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(report.events[0].remoteSessionDetail).toMatchObject({ previousState: "ACTIVE", currentState: "INACTIVE" });
    // Lecturer language fix — never the misleading generic
    // "Prohibited application closed" for a remote session ending.
    expect(report.events[0].eventLabel).toBe("Remote session ended");
    expect(report.events[0].eventLabel).not.toBe("Prohibited application closed");
  });
});

describe("evidenceReportToCsv — audit-fix: previously-missing summary blocks", () => {
  it("includes the screen-share integrity summary block (was silently omitted before this fix)", async () => {
    const exam = await prisma.exam.create({
      data: {
        title: `CSV Screen Share Exam ${Date.now()}-${Math.random()}`,
        durationMins: 30,
        published: true,
        createdById: lecturerA.id,
        institutionId: instA,
        secureSettings: { screenShareMode: "REQUIRED", screenShareCaptureEvidence: false },
      },
    });
    cleanup.exams.push(exam.id);
    const submission = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: studentA.id,
        status: "IN_PROGRESS",
        screenSharePolicySnapshotJson: {
          schemaVersion: 1,
          policyVersion: "v1.0",
          mode: "REQUIRED",
          captureEvidence: false,
          evidenceIntervalSeconds: 60,
          maxEvidenceFrames: 0,
        },
      },
    });
    await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "SCREEN_SHARE_INTERRUPTED",
        severity: "MEDIUM",
        message: "Screen sharing was interrupted.",
        occurredAt: new Date(),
      },
    });

    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    expect(report.screenShareIntegritySummary).not.toBeNull();
    const csv = evidenceReportToCsv(report);
    expect(csv).toContain("Screen-share integrity signals");
    expect(csv).toContain('Interruptions,"1"');
  });

  it("includes the lockdown detection summary block", async () => {
    const { exam, submission } = await createExamAndSubmission();
    await prisma.integrityEvent.create({
      data: {
        submissionId: submission.id,
        examId: exam.id,
        studentId: studentA.id,
        eventType: "DEBUGGING_TOOL_DETECTED",
        severity: "MEDIUM",
        message: "Debugging tool detected for test.",
        occurredAt: new Date(),
      },
    });
    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const csv = evidenceReportToCsv(report);
    expect(csv).toContain("Lockdown detection signals");
    expect(csv).toContain('Debugging tool detected,"1"');
  });

  it("omits both blocks entirely when there is nothing to summarise", async () => {
    const { submission } = await createExamAndSubmission();
    const report = await buildEvidenceReport(submission.id, sessionFor(lecturerA.id, "LECTURER", instA));
    const csv = evidenceReportToCsv(report);
    expect(csv).not.toContain("Screen-share integrity signals");
    expect(csv).not.toContain("Lockdown detection signals");
  });
});
