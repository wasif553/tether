/**
 * Fix exam publish redirect origin handling — see
 * docs/deployment-vercel-supabase.md.
 *
 * Confirms the exam-publish API response never leaks a hardcoded/stale
 * absolute URL (e.g. a specific Vercel deployment domain) — publishing
 * an exam is a plain JSON PATCH with no redirect and no URL of its own,
 * and this locks that in as a regression test.
 *
 * DB-backed — requires the local test Postgres instance.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const examRoute = await import("../app/api/exams/[id]/route");

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://test.local/route", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let testInstitution: { id: string };
let lecturer: { id: string };
const cleanupExamIds: string[] = [];

beforeAll(async () => {
  testInstitution = await getOrCreateTestInstitution("exam-publish-url-test");
  const passwordHash = await bcrypt.hash("test-password", 4);
  lecturer = await prisma.user.create({
    data: {
      name: "Publish URL Lecturer",
      email: `publish-url-lect-${Date.now()}@test.local`,
      passwordHash,
      role: "LECTURER",
      institutionId: testInstitution.id,
    },
  });
});

afterAll(async () => {
  await prisma.exam.deleteMany({ where: { id: { in: cleanupExamIds } } });
  await prisma.user.deleteMany({ where: { id: lecturer.id } });
});

async function createExam() {
  const exam = await prisma.exam.create({
    data: {
      title: `Publish URL Exam ${Date.now()}-${Math.random()}`,
      durationMins: 30,
      createdById: lecturer.id,
      institutionId: testInstitution.id,
      published: false,
    },
  });
  cleanupExamIds.push(exam.id);
  return exam;
}

describe("PATCH /api/exams/[id] — publishing an exam", () => {
  it("1. the publish response body never contains a hardcoded vercel.app URL", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue({
      user: { id: lecturer.id, role: "LECTURER", institutionId: testInstitution.id },
    });

    const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.published).toBe(true);

    const raw = JSON.stringify(body);
    expect(raw.toLowerCase()).not.toContain("vercel.app");
    // No absolute URL of any kind belongs in a plain publish-toggle response.
    expect(raw).not.toMatch(/https?:\/\//);
  });

  it("2. publishing returns a plain JSON body, not a redirect — there is no absolute or relative redirect Location to inspect", async () => {
    const exam = await createExam();
    mockAuth.mockResolvedValue({
      user: { id: lecturer.id, role: "LECTURER", institutionId: testInstitution.id },
    });

    const res = await examRoute.PATCH(jsonRequest("PATCH", { published: true }), {
      params: Promise.resolve({ id: exam.id }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
