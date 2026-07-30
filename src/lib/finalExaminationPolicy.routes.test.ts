/**
 * Mandatory Tether Delivery for Final Examinations — DB-backed route
 * tests. See src/lib/assessmentType.ts and Part 10 of the task spec.
 *
 * These exercise the real PATCH /api/exams/[id] and
 * POST /api/exams/[id]/start route handlers against a real (local test)
 * Postgres database — the same established pattern as
 * onDeviceAiIntegrity.routes.test.ts. Pure decision-logic tests for
 * assessmentType.ts itself live in assessmentType.test.ts, with no DB
 * dependency at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const examRoute = await import("../app/api/exams/[id]/route");
const startRoute = await import("../app/api/exams/[id]/start/route");

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
const cleanup = { users: [] as string[], exams: [] as string[] };

let instId: string;
let lecturer: { id: string };
let student: { id: string };

beforeAll(async () => {
  const inst = await getOrCreateTestInstitution(`final-exam-policy-${stamp}`);
  instId = inst.id;
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: { name: "Final Exam Lecturer", email: `final-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: instId },
  });
  student = await prisma.user.create({
    data: { name: "Final Exam Student", email: `final-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: instId },
  });
  cleanup.users.push(lecturer.id, student.id);
});

afterAll(async () => {
  await prisma.secureClientSession.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
});

async function createExam(title: string) {
  const exam = await prisma.exam.create({
    data: { title: `${title} ${stamp}-${Math.random()}`, durationMins: 30, createdById: lecturer.id, institutionId: instId, published: false },
  });
  cleanup.exams.push(exam.id);
  return exam;
}

describe("PATCH /api/exams/[id] — mandatory Tether normalisation for final examinations", () => {
  it("1/2. selecting Final examination automatically normalises delivery/display settings, even if the lecturer's own draft still says Standard Web", async () => {
    const exam = await createExam("normalise-on-save");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(
      jsonRequest("PATCH", {
        secureSettings: {
          assessmentType: "FINAL_EXAMINATION",
          deliveryMode: "STANDARD_WEB",
          displayPolicy: "UNRESTRICTED",
        },
      }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secureSettings.assessmentType).toBe("FINAL_EXAMINATION");
    expect(body.secureSettings.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
    expect(body.secureSettings.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
    expect(body.secureSettings.requireDisplayCheck).toBe(true);
    expect(body.secureSettings.secureClientMaximumDisplays).toBe(1);
  });

  it("2. a lecturer cannot save a final examination as Standard Web under any circumstance — even an explicit attempt to set SEB_REQUIRED is overridden back to Tether", async () => {
    const exam = await createExam("cannot-downgrade");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(
      jsonRequest("PATCH", { secureSettings: { assessmentType: "FINAL_EXAMINATION", deliveryMode: "SEB_REQUIRED" } }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secureSettings.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
  });

  it("4. a non-final assessment type retains the lecturer's own delivery-mode choice untouched", async () => {
    const exam = await createExam("non-final-preserved");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    const res = await examRoute.PATCH(
      jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST", deliveryMode: "MONITORED_WEB" } }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secureSettings.assessmentType).toBe("QUIZ_OR_TEST");
    expect(body.secureSettings.deliveryMode).toBe("MONITORED_WEB");
    expect(body.secureSettings.displayPolicy).toBe("UNRESTRICTED");
  });

  it("5. save and reload preserves the final-exam classification and the normalised policy", async () => {
    const exam = await createExam("save-and-reload");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "FINAL_EXAMINATION" } }), {
      params: Promise.resolve({ id: exam.id }),
    });

    const getRes = await examRoute.GET(new Request("http://test.local"), { params: Promise.resolve({ id: exam.id }) });
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.secureSettings.assessmentType).toBe("FINAL_EXAMINATION");
    expect(body.secureSettings.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
    expect(body.secureSettings.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
  });

  it("3. publishing a final examination is rejected while Tether Secure Browser is genuinely unavailable (emergency kill switch), even though the stored policy nominally says TETHER_CLIENT_REQUIRED", async () => {
    const exam = await createExam("publish-blocked-kill-switch");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    // First, classify and normalise while Tether is available.
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "FINAL_EXAMINATION" } }), {
      params: Promise.resolve({ id: exam.id }),
    });

    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("FINAL_EXAMINATION_TETHER_UNAVAILABLE");

      const stored = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
      expect(stored.published).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("3b. publishing succeeds once Tether Secure Browser is available again", async () => {
    const exam = await createExam("publish-allowed");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "FINAL_EXAMINATION" } }), {
      params: Promise.resolve({ id: exam.id }),
    });
    const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(200);
    const stored = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
    expect(stored.published).toBe(true);
  });

  it("publishing a non-final exam is never affected by the final-exam gate, even with the kill switch active", async () => {
    const exam = await createExam("non-final-publish-unaffected");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST" } }), {
      params: Promise.resolve({ id: exam.id }),
    });
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(res.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("POST /api/exams/[id]/start — final-exam invariant gate + submission snapshot freezing", () => {
  async function publishFinalExam(title: string) {
    const exam = await createExam(title);
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "FINAL_EXAMINATION" }, published: true }), {
      params: Promise.resolve({ id: exam.id }),
    });
    return exam;
  }

  it("1/7. starting a final examination freezes the mandatory policy onto the new submission snapshot: TETHER_CLIENT_REQUIRED, TETHER_SECURE_CLIENT, requireVerifiedClient, SINGLE_DISPLAY_REQUIRED, requireDisplayCheck, maximumDisplays=1", async () => {
    const exam = await publishFinalExam("start-freezes-policy");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();

    const stored = await prisma.submission.findUniqueOrThrow({ where: { id: body.id } });
    const snapshot = stored.secureClientPolicySnapshotJson as {
      deliveryMode: string;
      allowedClientTypes: string[];
      requireVerifiedClient: boolean;
      displayPolicy: string;
      requireDisplayCheck: boolean;
      maximumDisplays: number;
    };
    expect(snapshot.deliveryMode).toBe("TETHER_CLIENT_REQUIRED");
    expect(snapshot.allowedClientTypes).toEqual(["TETHER_SECURE_CLIENT"]);
    expect(snapshot.requireVerifiedClient).toBe(true);
    expect(snapshot.displayPolicy).toBe("SINGLE_DISPLAY_REQUIRED");
    expect(snapshot.requireDisplayCheck).toBe(true);
    expect(snapshot.maximumDisplays).toBe(1);
  });

  it("9/10. an ordinary browser starting a final examination for the first time (no verified Tether session yet) is told to redirect to the Tether launch page — never granted content directly", async () => {
    const exam = await publishFinalExam("ordinary-browser-redirect");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secureClientLaunch).toMatchObject({ required: true, kind: "REDIRECT_TO_TETHER_LAUNCH" });
    expect(typeof body.secureClientLaunch.redirectTo).toBe("string");
  });

  it("11. starting a final examination is blocked (409) while Tether Secure Browser is genuinely unavailable — never silently falls back to an insecure ordinary-browser final exam", async () => {
    const exam = await publishFinalExam("start-blocked-kill-switch");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    vi.stubEnv("TETHER_CLIENT_REQUIRED_DISABLED", "true");
    try {
      const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("FINAL_EXAMINATION_TETHER_UNAVAILABLE");

      const count = await prisma.submission.count({ where: { examId: exam.id, studentId: student.id } });
      expect(count).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("10. a student with an already-verified Tether Secure Browser session can resume the final examination (ALLOW, not redirected again)", async () => {
    const exam = await publishFinalExam("verified-session-resumes");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const firstRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submissionId = (await firstRes.json()).id as string;

    // Simulates a completed launch-manifest consume + successful
    // attestation (already thoroughly tested end-to-end in
    // secureClientRunner.disposable.test.ts) — establishes a verified
    // session directly so this test focuses purely on the start route's
    // OWN behaviour once verification exists.
    await prisma.secureClientSession.create({
      data: {
        institutionId: instId,
        examId: exam.id,
        submissionId,
        studentId: student.id,
        clientType: "TETHER_SECURE_CLIENT",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    });

    const resumeRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(resumeRes.status).toBe(200);
    const resumeBody = await resumeRes.json();
    expect(resumeBody.id).toBe(submissionId);
    expect(resumeBody.secureClientLaunch).toEqual({ required: true, kind: "ALLOW", redirectTo: null });
  });

  it("8. an existing submission's frozen snapshot is never retroactively rewritten by a later policy change", async () => {
    const exam = await publishFinalExam("existing-snapshot-immutable");
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const startRes = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    const submissionId = (await startRes.json()).id as string;
    const before = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });

    // Lecturer changes the exam back to a non-final assessment afterwards.
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(jsonRequest("PATCH", { secureSettings: { assessmentType: "QUIZ_OR_TEST", deliveryMode: "STANDARD_WEB" } }), {
      params: Promise.resolve({ id: exam.id }),
    });

    const after = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(after.secureClientPolicySnapshotJson).toEqual(before.secureClientPolicySnapshotJson);
  });

  it("13. a non-final SEB_REQUIRED exam's start behaviour is unaffected by the final-exam gate (regression check)", async () => {
    const exam = await createExam("seb-required-unaffected");
    mockAuth.mockResolvedValue(sessionFor(lecturer.id, "LECTURER", instId));
    await examRoute.PATCH(
      jsonRequest("PATCH", { secureSettings: { assessmentType: "MID_SEMESTER_EXAMINATION", deliveryMode: "STANDARD_WEB" }, published: true }),
      { params: Promise.resolve({ id: exam.id }) },
    );
    mockAuth.mockResolvedValue(sessionFor(student.id, "STUDENT", instId));
    const res = await startRoute.POST(jsonRequest("POST", { policyAcknowledged: true }), { params: Promise.resolve({ id: exam.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secureClientLaunch).toEqual({ required: false });
  });
});
