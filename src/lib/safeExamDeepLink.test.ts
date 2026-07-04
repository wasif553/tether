/**
 * Persistent Camera Preview + Safe Exam Deep Link v1 — see
 * docs/course-enrolment-and-exam-assignment.md and
 * docs/known-limitations.md.
 *
 * Covers:
 *  - GET /api/exams/[id]/access-check (join-route authorization, no
 *    submission created, no access code checked)
 *  - isSafeJoinCallbackUrl (open-redirect prevention for the post-login
 *    callback)
 *  - camera preview minimize/restore never producing an IntegrityEvent,
 *    never appearing in the evidence report, never affecting risk score
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const { isSafeJoinCallbackUrl, isSafeAppCallbackUrl } = await import("./safeCallbackUrl");

const stamp = Date.now();
const cleanupUserIds: string[] = [];
const cleanupExamIds: string[] = [];
const cleanupCourseIds: string[] = [];
const cleanupSubmissionIds: string[] = [];

function sessionFor(
  userId: string,
  role: "LECTURER" | "STUDENT" | "PLATFORM_ADMIN",
  institutionId: string,
) {
  return {
    user: { id: userId, email: "test@test.invalid", name: "Test", role, institutionId },
    expires: new Date(Date.now() + 86400_000).toISOString(),
  };
}

async function createUser(email: string, role: "LECTURER" | "STUDENT", institutionId: string) {
  const passwordHash = await bcrypt.hash("password", 4);
  const u = await prisma.user.create({ data: { name: "Test", email, passwordHash, role, institutionId } });
  cleanupUserIds.push(u.id);
  return u;
}

async function createCourse(institutionId: string, code: string) {
  const c = await prisma.course.create({ data: { institutionId, name: `Course ${code}`, code } });
  cleanupCourseIds.push(c.id);
  return c;
}

async function createExam(opts: {
  institutionId: string;
  createdById: string;
  courseId?: string | null;
  assignmentMode?: "COURSE" | "SELECTED_STUDENTS";
  availableFrom?: Date | null;
  availableUntil?: Date | null;
  accessCodeHash?: string | null;
  accessCodeRequired?: boolean;
  published?: boolean;
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
      availableFrom: opts.availableFrom ?? null,
      availableUntil: opts.availableUntil ?? null,
      accessCodeHash: opts.accessCodeHash ?? null,
      accessCodeRequired: opts.accessCodeRequired ?? false,
    },
  });
  cleanupExamIds.push(exam.id);
  return exam;
}

let instA: string;
let instB: string;
let lecturerA: string;
let studentInCourse: string;
let studentNotInCourse: string;
let studentInstB: string;

beforeAll(async () => {
  const a = await getOrCreateTestInstitution(`deeplink-a-${stamp}`);
  const b = await getOrCreateTestInstitution(`deeplink-b-${stamp}`);
  instA = a.id;
  instB = b.id;

  const lect = await createUser(`lect-dl-${stamp}@test.invalid`, "LECTURER", instA);
  lecturerA = lect.id;
  const s1 = await createUser(`stud-dl-in-${stamp}@test.invalid`, "STUDENT", instA);
  studentInCourse = s1.id;
  const s2 = await createUser(`stud-dl-out-${stamp}@test.invalid`, "STUDENT", instA);
  studentNotInCourse = s2.id;
  const s3 = await createUser(`stud-dl-instb-${stamp}@test.invalid`, "STUDENT", instB);
  studentInstB = s3.id;
});

afterAll(async () => {
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.submission.deleteMany({ where: { id: { in: cleanupSubmissionIds } } });
  await prisma.examAssignment.deleteMany({ where: { examId: { in: cleanupExamIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.courseEnrollment.deleteMany({ where: { courseId: { in: cleanupCourseIds } } });
  await prisma.course.deleteMany({ where: { id: { in: cleanupCourseIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

// ── isSafeJoinCallbackUrl — open redirect prevention ─────────────────────────

describe("isSafeJoinCallbackUrl", () => {
  it("accepts a well-formed join path", () => {
    expect(isSafeJoinCallbackUrl("/student/exams/join/clabc123")).toBe(true);
  });

  it("rejects an absolute URL", () => {
    expect(isSafeJoinCallbackUrl("https://evil.example.com/student/exams/join/x")).toBe(false);
  });

  it("rejects a protocol-relative URL", () => {
    expect(isSafeJoinCallbackUrl("//evil.example.com/student/exams/join/x")).toBe(false);
  });

  it("rejects a path outside the join route", () => {
    expect(isSafeJoinCallbackUrl("/platform/institutions")).toBe(false);
  });

  it("rejects the dashboard root", () => {
    expect(isSafeJoinCallbackUrl("/student")).toBe(false);
  });

  it("rejects null/empty", () => {
    expect(isSafeJoinCallbackUrl(null)).toBe(false);
    expect(isSafeJoinCallbackUrl("")).toBe(false);
  });

  it("rejects a join path with extra segments appended", () => {
    expect(isSafeJoinCallbackUrl("/student/exams/join/abc/../../../lecturer")).toBe(false);
  });
});

// ── isSafeAppCallbackUrl — student join route + lecturer area ───────────────

describe("isSafeAppCallbackUrl", () => {
  it("accepts a well-formed join path", () => {
    expect(isSafeAppCallbackUrl("/student/exams/join/clabc123")).toBe(true);
  });

  it("accepts a lecturer exam detail path", () => {
    expect(isSafeAppCallbackUrl("/lecturer/exams/clabc123")).toBe(true);
  });

  it("accepts a lecturer exam submissions path", () => {
    expect(isSafeAppCallbackUrl("/lecturer/exams/clabc123/submissions")).toBe(true);
  });

  it("accepts a lecturer exam analytics path", () => {
    expect(isSafeAppCallbackUrl("/lecturer/exams/clabc123/analytics")).toBe(true);
  });

  it("accepts a lecturer submission evidence path", () => {
    expect(isSafeAppCallbackUrl("/lecturer/submissions/clabc123/evidence")).toBe(true);
  });

  it("accepts the bare lecturer dashboard root", () => {
    expect(isSafeAppCallbackUrl("/lecturer")).toBe(true);
  });

  it("rejects an absolute URL", () => {
    expect(isSafeAppCallbackUrl("https://evil.example.com/lecturer/exams/x")).toBe(false);
  });

  it("rejects a protocol-relative URL", () => {
    expect(isSafeAppCallbackUrl("//evil.example.com/lecturer")).toBe(false);
  });

  it("rejects a path outside the join route or lecturer area", () => {
    expect(isSafeAppCallbackUrl("/platform/institutions")).toBe(false);
    expect(isSafeAppCallbackUrl("/student")).toBe(false);
  });

  it("rejects null/empty", () => {
    expect(isSafeAppCallbackUrl(null)).toBe(false);
    expect(isSafeAppCallbackUrl("")).toBe(false);
  });

  it("rejects a lecturer path with traversal or query/hash smuggled in", () => {
    expect(isSafeAppCallbackUrl("/lecturer/exams/../../platform")).toBe(false);
    expect(isSafeAppCallbackUrl("/lecturer/exams/x?redirect=https://evil.example.com")).toBe(false);
    expect(isSafeAppCallbackUrl("/lecturer/exams/x#https://evil.example.com")).toBe(false);
  });
});

// ── GET /api/exams/[id]/access-check — join-route authorization ─────────────

describe("GET /api/exams/[id]/access-check", () => {
  it("4. whole-course assignment: enrolled student gets ok:true", async () => {
    const course = await createCourse(instA, `DL-WC-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInCourse, role: "STUDENT" } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "COURSE" });

    mockAuth.mockResolvedValue(sessionFor(studentInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("5. does not create a submission just from checking access", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });

    const submission = await prisma.submission.findUnique({
      where: { examId_studentId: { examId: exam.id, studentId: studentNotInCourse } },
    });
    expect(submission).toBeNull();
  });

  it("6. non-selected course student gets ok:false, reason no_access (generic, no leak)", async () => {
    const course = await createCourse(instA, `DL-SS-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInCourse, role: "STUDENT" } });
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentNotInCourse, role: "STUDENT" } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "SELECTED_STUDENTS" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: studentInCourse } });

    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no_access");
    // Generic response must not leak course/institution details.
    expect(JSON.stringify(body)).not.toContain(course.name);
  });

  it("7. selected student gets ok:true", async () => {
    const course = await createCourse(instA, `DL-SS2-${stamp}`);
    await prisma.courseEnrollment.create({ data: { courseId: course.id, userId: studentInCourse, role: "STUDENT" } });
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: course.id, assignmentMode: "SELECTED_STUDENTS" });
    await prisma.examAssignment.create({ data: { examId: exam.id, studentId: studentInCourse } });

    mockAuth.mockResolvedValue(sessionFor(studentInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("8. availableFrom in future returns reason not_open", async () => {
    const exam = await createExam({
      institutionId: instA, createdById: lecturerA, courseId: null,
      availableFrom: new Date(Date.now() + 3600_000),
    });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_open");
  });

  it("9. availableUntil in past returns reason closed", async () => {
    const exam = await createExam({
      institutionId: instA, createdById: lecturerA, courseId: null,
      availableUntil: new Date(Date.now() - 3600_000),
    });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("closed");
  });

  it("does not reveal access-code requirement enforcement here — it is returned as metadata for the UI, not checked", async () => {
    const codeHash = await bcrypt.hash("secret", 4);
    const exam = await createExam({
      institutionId: instA, createdById: lecturerA, courseId: null,
      accessCodeHash: codeHash, accessCodeRequired: true,
    });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.exam.accessCodeRequired).toBe(true);
  });

  it("cross-institution student gets ok:false, reason no_access", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null });
    mockAuth.mockResolvedValue(sessionFor(studentInstB, "STUDENT", instB));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no_access");
  });

  it("unpublished exam returns ok:false, reason no_access", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null, published: false });
    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { GET } = await import("@/app/api/exams/[id]/access-check/route");
    const res = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: exam.id }) });
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no_access");
  });
});

// ── 12/13/14: minimize/restore never produces an IntegrityEvent, never
//    appears in evidence, never affects risk score ──────────────────────────

describe("Camera preview minimize/restore has no server-side footprint", () => {
  it("12. the integrity-events API rejects any event type outside the fixed whitelist — there is no minimize/restore event type to create", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null });
    const sub = await prisma.submission.create({ data: { examId: exam.id, studentId: studentNotInCourse } });
    cleanupSubmissionIds.push(sub.id);

    mockAuth.mockResolvedValue(sessionFor(studentNotInCourse, "STUDENT", instA));
    const { POST } = await import("@/app/api/submissions/[id]/integrity-events/route");
    const req = new Request(`http://localhost/api/submissions/${sub.id}/integrity-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "CAMERA_PREVIEW_MINIMIZED", // not a real type — proves it can't be created
        severity: "INFO",
        message: "attempted",
        occurredAt: new Date().toISOString(),
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: sub.id }) });
    expect(res.status).toBe(400);

    const count = await prisma.integrityEvent.count({ where: { submissionId: sub.id } });
    expect(count).toBe(0);
  });

  it("13 & 14. a submission with zero integrity events (simulating a session where only minimize/restore happened) has an empty evidence timeline and a CLEAN risk score", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null });
    const sub = await prisma.submission.create({
      data: { examId: exam.id, studentId: studentNotInCourse, status: "GRADED" },
    });
    cleanupSubmissionIds.push(sub.id);

    const { buildEvidenceReport } = await import("@/lib/evidenceReport");
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { id: lecturerA } });
    const report = await buildEvidenceReport(sub.id, sessionFor(lecturer.id, "LECTURER", instA) as never);

    expect(report.events).toEqual([]);
    expect(report.riskScore).toBe(0);
    expect(report.riskLevel).toBe("CLEAN");
  });

  it("real camera signals (not minimize/restore) still show up normally — sanity check that the exclusion is specific to minimize/restore, not camera events in general", async () => {
    const exam = await createExam({ institutionId: instA, createdById: lecturerA, courseId: null });
    const sub = await prisma.submission.create({
      data: { examId: exam.id, studentId: studentNotInCourse, status: "GRADED" },
    });
    cleanupSubmissionIds.push(sub.id);

    await prisma.integrityEvent.create({
      data: {
        submissionId: sub.id,
        examId: exam.id,
        studentId: studentNotInCourse,
        eventType: "CAMERA_STOPPED",
        severity: "HIGH",
        message: "Camera monitoring stopped.",
        occurredAt: new Date(),
      },
    });

    const { buildEvidenceReport } = await import("@/lib/evidenceReport");
    const lecturer = await prisma.user.findUniqueOrThrow({ where: { id: lecturerA } });
    const report = await buildEvidenceReport(sub.id, sessionFor(lecturer.id, "LECTURER", instA) as never);

    expect(report.events).toHaveLength(1);
    expect(report.events[0].eventType).toBe("CAMERA_STOPPED");
    expect(report.riskScore).toBe(7); // HIGH weight
  });
});
