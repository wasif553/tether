/**
 * Tether v1.7.4 pre-exam readiness — zero-downtime cutover audit.
 * See docs/tether-preflight-lifecycle-v1.7.4-migration.sql and
 * prisma/schema.prisma's doc comment on Submission.activatedAt.
 *
 * The production migration adds `Submission.activatedAt` with a
 * database-level `DEFAULT CURRENT_TIMESTAMP`, set only after backfilling
 * every historical row. This file proves — against the REAL disposable
 * database, not by assumption — the exact Prisma/Postgres interaction
 * the whole zero-downtime cutover design depends on: an INSERT that
 * OMITS the column falls through to the DB default (simulating the OLD,
 * pre-v1.7.4 application code, whose generated Prisma client has no
 * knowledge this column exists and therefore never mentions it), while
 * an INSERT that EXPLICITLY passes `null` overrides the default and
 * stays genuinely null (this is what v1.7.4's own
 * POST /api/exams/[id]/start does for a secure-client-required attempt
 * — see that route's `activatedAt: requiresActivation ? null : new Date()`).
 *
 * Required-test numbering below matches the release-blocking audit's
 * own numbered list verbatim.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const startRoute = await import("../app/api/exams/[id]/start/route");
const activateRoute = await import("../app/api/submissions/[id]/activate/route");

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupExamIds: string[] = [];

function sessionFor(userId: string, institutionId: string) {
  return {
    user: { id: userId, email: "test@test.invalid", name: "Test", role: "STUDENT" as const, institutionId },
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

let institutionId: string;
let lecturerId: string;

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`tether-activated-at-cutover-${stamp}`);
  institutionId = inst.id;
  const passwordHash = await bcrypt.hash("password", 4);
  const lecturer = await prisma.user.create({
    data: { name: "Cutover Lecturer", email: `cutover-lecturer-${stamp}@test.invalid`, passwordHash, role: "LECTURER", institutionId },
  });
  lecturerId = lecturer.id;
  cleanupUserIds.push(lecturer.id);
});

afterAll(async () => {
  await prisma.submission.deleteMany({ where: { studentId: { in: cleanupUserIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

async function makeStudent(tag: string) {
  const passwordHash = await bcrypt.hash("password", 4);
  const user = await prisma.user.create({
    data: { name: `Cutover Student ${tag}`, email: `cutover-${tag}-${stamp}@test.invalid`, passwordHash, role: "STUDENT", institutionId },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function createExam(title: string, deliveryMode: string) {
  const exam = await prisma.exam.create({
    data: {
      title: `${title} ${stamp}-${Math.random()}`,
      durationMins: 30,
      published: true,
      createdById: lecturerId,
      institutionId,
      secureSettings: { deliveryMode, maxAttempts: 1 },
    },
  });
  cleanupExamIds.push(exam.id);
  await prisma.question.create({ data: { examId: exam.id, type: "SHORT_ANSWER", text: "Q1", points: 1, correctAnswer: "ok" } });
  return exam;
}

describe("Zero-downtime cutover — Submission.activatedAt DB default vs. explicit null", () => {
  it("REQUIRED TEST 1: a legacy-style insert that OMITS activatedAt entirely (simulating OLD pre-v1.7.4 application code, whose generated Prisma client never mentions this column) gets a non-null activatedAt automatically, from the database default", async () => {
    const student = await makeStudent("omit-field");
    const exam = await createExam("Omit Field", "STANDARD_WEB");

    const before = new Date();
    // Deliberately does NOT include `activatedAt` in the data object at
    // all — this is the exact shape of INSERT old code's generated
    // client would produce, since its types never included this column.
    const row = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        secureClientPolicySnapshotJson: { deliveryMode: "STANDARD_WEB" },
      },
    });
    const after = new Date();

    expect(row.activatedAt).not.toBeNull();
    expect(row.activatedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.activatedAt!.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it("REQUIRED TEST 3: an insert that EXPLICITLY passes activatedAt: null (the v1.7.4 secure-client PREPARING write) remains genuinely NULL despite the column's DEFAULT CURRENT_TIMESTAMP — Prisma sends an explicit SQL NULL, which overrides the default rather than falling through to it", async () => {
    const student = await makeStudent("explicit-null");
    const exam = await createExam("Explicit Null", "TETHER_CLIENT_REQUIRED");

    const row = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_REQUIRED" },
        activatedAt: null,
      },
    });

    expect(row.activatedAt).toBeNull();

    // Re-read from the database directly (not just the create() return
    // value) to rule out any client-side echo-back masking a server-side
    // default having actually been applied.
    const reread = await prisma.submission.findUniqueOrThrow({ where: { id: row.id } });
    expect(reread.activatedAt).toBeNull();
  });

  it("REQUIRED TEST 4: a new STANDARD_WEB (non-gated) attempt via the real /start route is activated immediately, unaffected by the DB default (the route sets activatedAt itself, explicitly, on this branch)", async () => {
    const student = await makeStudent("standard-web-immediate");
    const exam = await createExam("Standard Web Immediate", "STANDARD_WEB");

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBeLessThan(300);
    const body = await res.json();
    expect(body.activatedAt).not.toBeNull();

    const row = await prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.activatedAt).not.toBeNull();
  });

  it("REQUIRED TEST 4b: a new TETHER_CLIENT_REQUIRED attempt via the real /start route is explicitly PREPARING (activatedAt null), confirming the gated branch still relies on its own explicit write, not the (irrelevant, since it never omits the field) DB default", async () => {
    const student = await makeStudent("tether-required-preparing");
    const exam = await createExam("Tether Required Preparing", "TETHER_CLIENT_REQUIRED");

    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBeLessThan(300);
    const body = await res.json();
    expect(body.activatedAt).toBeNull();

    const row = await prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.activatedAt).toBeNull();

    // And /activate still sets it exactly once (REQUIRED TEST 5,
    // already covered end-to-end in tetherAttemptAccounting.test.ts —
    // re-asserted here in the same DB-default schema context for
    // completeness).
    await prisma.secureClientSession.create({
      data: {
        institutionId,
        examId: exam.id,
        submissionId: row.id,
        studentId: student.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });
    mockAuth.mockResolvedValue(sessionFor(student.id, institutionId));
    const activateRes = await activateRoute.POST(jsonRequest("POST"), { params: Promise.resolve({ id: row.id }) });
    expect(activateRes.status).toBe(200);
    const activated = await prisma.submission.findUniqueOrThrow({ where: { id: row.id } });
    expect(activated.activatedAt).not.toBeNull();
  });

  it("REQUIRED TEST 7: no point in the deployment sequence can produce an ambiguous NULL row from old-code-equivalent inserts — the DB default fires unconditionally on every omitted-field insert, gated or not, so the only way to get a null activatedAt post-migration is v1.7.4 code's own explicit null", async () => {
    const student = await makeStudent("no-ambiguous-window");
    // Even a secure-client-required exam, inserted the OLD way (field
    // omitted entirely, as old code's generated client would always do,
    // since it has no idea the field exists) — never lands on NULL.
    const exam = await createExam("No Ambiguous Window", "TETHER_CLIENT_REQUIRED");

    const oldStyleRow = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        secureClientPolicySnapshotJson: { deliveryMode: "TETHER_CLIENT_REQUIRED" },
        // activatedAt intentionally omitted — old code never mentions it.
      },
    });

    // This row is NOT ambiguous: it is non-null, exactly matching
    // pre-v1.7.4 "created = active" semantics, so v1.7.4's content gate
    // (isSubmissionContentAccessible) will treat it as already
    // activated rather than incorrectly blocking a student who never
    // went through the new PREPARING flow at all.
    expect(oldStyleRow.activatedAt).not.toBeNull();

    const { isSubmissionContentAccessible } = await import("./secureClientActivation");
    expect(
      isSubmissionContentAccessible({
        activatedAt: oldStyleRow.activatedAt,
        secureClientPolicySnapshotJson: oldStyleRow.secureClientPolicySnapshotJson,
      }),
    ).toBe(true);
  });
});
