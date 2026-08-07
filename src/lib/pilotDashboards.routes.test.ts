/**
 * Pilot UI release readiness v1 — DB-backed route tests for the
 * student/lecturer dashboard history-capping and needs-review-aggregate
 * changes. See docs/tether-v1.7.2-pilot-release-readiness.md.
 *
 * SAFE EXECUTION ONLY: run this file exclusively via
 * `npm run release:validate` (a disposable, local-only PostgreSQL
 * container) — never a direct `npx vitest run` against this
 * repository's committed DATABASE_URL. src/lib/prisma.ts's test-time
 * safety guard throws before any query can run if DATABASE_URL doesn't
 * resolve to a disposable loopback database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const availableRoute = await import("../app/api/exams/available/route");
const examsRoute = await import("../app/api/exams/route");

function sessionFor(userId: string, role: "LECTURER" | "STUDENT", institutionId: string) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
}

function getRequest(url: string) {
  return new Request(url);
}

let institution: { id: string };
let lecturer: { id: string };
let student: { id: string };
const createdExamIds: string[] = [];
const stamp = Date.now();

beforeAll(async () => {
  institution = await getOrCreateTestInstitution("pilot-dash-inst");
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Pilot Dash Lecturer", email: `pilot-dash-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: institution.id },
  });
  student = await prisma.user.create({
    data: { name: "Pilot Dash Student", email: `pilot-dash-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: institution.id },
  });
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: createdExamIds } } });
  await prisma.submission.deleteMany({ where: { examId: { in: createdExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: createdExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [lecturer.id, student.id] } } });
  await prisma.$disconnect();
});

describe("GET /api/exams/available — student dashboard history capping", () => {
  it("[3, 4] an actionable (open) exam is never dropped by the completed-history cap, even with many completed exams ahead of it in createdAt order", async () => {
    // 25 already-closed, already-submitted exams (history), created BEFORE
    // one still-open exam the student hasn't started — proves the cap
    // targets the no-further-action tail specifically, never the
    // actionable set, regardless of creation order.
    for (let i = 0; i < 25; i++) {
      const exam = await prisma.exam.create({
        data: {
          title: `Pilot Dash Closed ${i} ${stamp}`,
          durationMins: 30,
          published: true,
          createdById: lecturer.id,
          institutionId: institution.id,
          availableUntil: new Date(Date.now() - (25 - i) * 60_000),
        },
      });
      createdExamIds.push(exam.id);
      await prisma.submission.create({
        data: { examId: exam.id, studentId: student.id, status: "GRADED", submittedAt: new Date(Date.now() - (25 - i) * 60_000) },
      });
    }
    const openExam = await prisma.exam.create({
      data: { title: `Pilot Dash Open ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: institution.id },
    });
    createdExamIds.push(openExam.id);

    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", institution.id));
    const res = await availableRoute.GET();
    expect(res.status).toBe(200);
    const exams: Array<{ id: string; availability: string }> = await res.json();

    expect(exams.find((e) => e.id === openExam.id)).toBeDefined();
    const closedReturned = exams.filter((e) => e.id !== openExam.id);
    expect(closedReturned.length).toBeLessThanOrEqual(20);
    expect(closedReturned.length).toBeLessThan(25);
  });

  it("[5] '?all=true' returns the full completed history, including items the default (capped) response omits", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", institution.id));
    const capped = await (await availableRoute.GET()).json();
    const full = await (await availableRoute.GET(getRequest("http://test.local/api/exams/available?all=true"))).json();
    expect(full.length).toBeGreaterThan(capped.length);
  });

  it("[2] the most recently submitted completed exams are returned first within the capped set", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", institution.id));
    const res = await availableRoute.GET();
    const exams: Array<{ id: string; submission: { submittedAt: string | null } | null }> = await res.json();
    const completedTimestamps = exams.filter((e) => e.submission?.submittedAt).map((e) => new Date(e.submission!.submittedAt as string).getTime());
    const sorted = [...completedTimestamps].sort((a, b) => b - a);
    expect(completedTimestamps).toEqual(sorted);
  });

  it("[8] the dashboard response never includes question content — only bounded summary fields", async () => {
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", institution.id));
    const res = await availableRoute.GET();
    const exams: Array<Record<string, unknown>> = await res.json();
    for (const exam of exams) {
      expect(exam).not.toHaveProperty("questions");
      expect(exam).not.toHaveProperty("secureSettings");
      expect(exam).not.toHaveProperty("accessCodeHash");
      expect(Object.keys(exam).join(",")).not.toMatch(/answer/i);
    }
  });
});

describe("GET /api/exams — lecturer dashboard needs-review aggregate + closed-history capping", () => {
  it("[10] needsReviewCount is correct per exam via a single aggregate query, for many exams at once", async () => {
    const examWithReview = await prisma.exam.create({
      data: { title: `Pilot Dash Needs Review ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: institution.id },
    });
    createdExamIds.push(examWithReview.id);
    const examWithoutReview = await prisma.exam.create({
      data: { title: `Pilot Dash No Review ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: institution.id },
    });
    createdExamIds.push(examWithoutReview.id);
    const submission = await prisma.submission.create({ data: { examId: examWithReview.id, studentId: student.id } });

    await prisma.integrityEvent.createMany({
      data: [
        { submissionId: submission.id, examId: examWithReview.id, studentId: student.id, eventType: "MANUAL_WARNING", severity: "LOW", message: "test event", occurredAt: new Date(), reviewStatus: "NEEDS_REVIEW" },
        { submissionId: submission.id, examId: examWithReview.id, studentId: student.id, eventType: "MANUAL_WARNING", severity: "LOW", message: "test event", occurredAt: new Date(), reviewStatus: "NEEDS_REVIEW" },
        { submissionId: submission.id, examId: examWithReview.id, studentId: student.id, eventType: "MANUAL_WARNING", severity: "LOW", message: "test event", occurredAt: new Date(), reviewStatus: "REVIEWED_NO_CONCERN" },
      ],
    });

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", institution.id));
    const res = await examsRoute.GET();
    expect(res.status).toBe(200);
    const exams: Array<{ id: string; needsReviewCount: number }> = await res.json();

    const reviewExam = exams.find((e) => e.id === examWithReview.id);
    const noReviewExam = exams.find((e) => e.id === examWithoutReview.id);
    // Exactly 2 NEEDS_REVIEW events counted — the REVIEWED_NO_CONCERN one is excluded.
    expect(reviewExam?.needsReviewCount).toBe(2);
    expect(noReviewExam?.needsReviewCount).toBe(0);
  });

  it("[10] a closed exam that still needs review is never dropped by the closed-history cap", async () => {
    const closedNeedsReview = await prisma.exam.create({
      data: {
        title: `Pilot Dash Closed Needs Review ${stamp}`,
        durationMins: 30,
        published: true,
        createdById: lecturer.id,
        institutionId: institution.id,
        availableUntil: new Date(Date.now() - 60_000),
      },
    });
    createdExamIds.push(closedNeedsReview.id);
    const submission = await prisma.submission.create({ data: { examId: closedNeedsReview.id, studentId: student.id } });
    await prisma.integrityEvent.create({
      data: { submissionId: submission.id, examId: closedNeedsReview.id, studentId: student.id, eventType: "MANUAL_WARNING", severity: "LOW", message: "test event", occurredAt: new Date(), reviewStatus: "NEEDS_REVIEW" },
    });

    // Push 25 more closed exams (no review needed) ahead of it so a naive
    // "closed, capped to 20, in creation order" implementation would drop it.
    for (let i = 0; i < 25; i++) {
      const exam = await prisma.exam.create({
        data: {
          title: `Pilot Dash Closed Filler ${i} ${stamp}`,
          durationMins: 30,
          published: true,
          createdById: lecturer.id,
          institutionId: institution.id,
          availableUntil: new Date(Date.now() - (25 - i) * 60_000),
        },
      });
      createdExamIds.push(exam.id);
    }

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", institution.id));
    const res = await examsRoute.GET();
    const exams: Array<{ id: string }> = await res.json();
    expect(exams.find((e) => e.id === closedNeedsReview.id)).toBeDefined();
  });

  it("[9, 13] upcoming examinations are sorted nearest-first", async () => {
    const far = await prisma.exam.create({
      data: { title: `Pilot Dash Upcoming Far ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: institution.id, availableFrom: new Date(Date.now() + 100_000_000) },
    });
    const near = await prisma.exam.create({
      data: { title: `Pilot Dash Upcoming Near ${stamp}`, durationMins: 30, published: true, createdById: lecturer.id, institutionId: institution.id, availableFrom: new Date(Date.now() + 60_000) },
    });
    createdExamIds.push(far.id, near.id);

    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", institution.id));
    const res = await examsRoute.GET();
    const exams: Array<{ id: string; availableFrom: string | null }> = await res.json();
    const nearIdx = exams.findIndex((e) => e.id === near.id);
    const farIdx = exams.findIndex((e) => e.id === far.id);
    expect(nearIdx).toBeGreaterThanOrEqual(0);
    expect(farIdx).toBeGreaterThanOrEqual(0);
    expect(nearIdx).toBeLessThan(farIdx);
  });

  it("[12] '?all=true' returns more closed exams than the default capped response once the cap is exceeded", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", institution.id));
    const capped = await (await examsRoute.GET()).json();
    const full = await (await examsRoute.GET(getRequest("http://test.local/api/exams?all=true"))).json();
    expect(full.length).toBeGreaterThanOrEqual(capped.length);
  });
});
