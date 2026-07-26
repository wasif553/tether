/**
 * Single Display Requirement v1 — MOCKED route tests for the
 * displayPolicy validation added to PATCH /api/exams/[id]. See
 * docs/secure-client-foundation-seb-v1.md, "Display requirement".
 *
 * Fully mocked (vi.fn()) — no real database connection, matching the
 * established pattern in src/lib/answerDevelopment.routes.test.ts and
 * src/lib/secureClient.routes.test.ts. Only covers the display-policy
 * validation branch this feature adds — not the exam PATCH route's other
 * pre-existing behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ auth: mockAuth }));

const mockPrisma = vi.hoisted(() => ({
  exam: { findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const { PATCH } = await import("../app/api/exams/[id]/route");

function lecturerSession(userId: string, institutionId: string) {
  return { user: { id: userId, role: "LECTURER", institutionId } };
}

function examFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "exam-1",
    createdById: "lecturer-a",
    institutionId: "inst-a",
    secureSettings: {},
    ...overrides,
  };
}

function patchRequest(body: unknown) {
  return new Request("http://test.local/route", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(lecturerSession("lecturer-a", "inst-a"));
  mockPrisma.exam.findFirst.mockResolvedValue(examFixture());
  mockPrisma.exam.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...examFixture(),
    ...data,
  }));
});

describe("PATCH /api/exams/[id] — displayPolicy validation", () => {
  it("rejects an unknown displayPolicy value (400) before ever touching the database update", async () => {
    const res = await PATCH(patchRequest({ secureSettings: { displayPolicy: "MAXIMUM_SECURITY" } }), { params: Promise.resolve({ id: "exam-1" }) });
    expect(res.status).toBe(400);
    expect(mockPrisma.exam.update).not.toHaveBeenCalled();
  });

  it("rejects SINGLE_DISPLAY_REQUIRED combined with STANDARD_WEB delivery (400), explaining SEB is needed", async () => {
    mockPrisma.exam.findFirst.mockResolvedValue(examFixture({ secureSettings: { deliveryMode: "STANDARD_WEB" } }));
    const res = await PATCH(patchRequest({ secureSettings: { displayPolicy: "SINGLE_DISPLAY_REQUIRED" } }), { params: Promise.resolve({ id: "exam-1" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Safe Exam Browser/i);
    expect(mockPrisma.exam.update).not.toHaveBeenCalled();
  });

  it("rejects SINGLE_DISPLAY_REQUIRED when displayPolicy is set alone and deliveryMode was already STANDARD_WEB from a prior save (merged-settings check, not just the raw PATCH body)", async () => {
    // Simulates a PATCH that only sends displayPolicy, leaving a
    // previously-saved STANDARD_WEB deliveryMode untouched.
    mockPrisma.exam.findFirst.mockResolvedValue(examFixture({ secureSettings: { deliveryMode: "STANDARD_WEB", requireSebBrowserExamKey: false } }));
    const res = await PATCH(patchRequest({ secureSettings: { displayPolicy: "SINGLE_DISPLAY_REQUIRED" } }), { params: Promise.resolve({ id: "exam-1" }) });
    expect(res.status).toBe(400);
  });

  it("accepts SINGLE_DISPLAY_REQUIRED combined with SEB_REQUIRED delivery", async () => {
    const res = await PATCH(
      patchRequest({ secureSettings: { deliveryMode: "SEB_REQUIRED", displayPolicy: "SINGLE_DISPLAY_REQUIRED" } }),
      { params: Promise.resolve({ id: "exam-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.exam.update).toHaveBeenCalled();
  });

  it("accepts SINGLE_DISPLAY_REQUIRED combined with SEB_OPTIONAL delivery", async () => {
    const res = await PATCH(
      patchRequest({ secureSettings: { deliveryMode: "SEB_OPTIONAL", displayPolicy: "SINGLE_DISPLAY_REQUIRED" } }),
      { params: Promise.resolve({ id: "exam-1" }) },
    );
    expect(res.status).toBe(200);
  });

  it("accepts UNRESTRICTED with any delivery mode, including STANDARD_WEB", async () => {
    const res = await PATCH(
      patchRequest({ secureSettings: { deliveryMode: "STANDARD_WEB", displayPolicy: "UNRESTRICTED" } }),
      { params: Promise.resolve({ id: "exam-1" }) },
    );
    expect(res.status).toBe(200);
  });

  it("a request with no secureSettings at all is unaffected by the display-policy check", async () => {
    const res = await PATCH(patchRequest({ title: "Renamed exam" }), { params: Promise.resolve({ id: "exam-1" }) });
    expect(res.status).toBe(200);
  });
});
