import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair } from "jose";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    submission: { findUnique: vi.fn() },
    ltiLaunch: { findFirst: vi.fn(), update: vi.fn() },
    ltiPlatform: { findUnique: vi.fn() },
    canvasGradePassback: { upsert: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

let testPrivateKey: CryptoKey;

vi.mock("@/lib/lti/keys", () => ({
  getPrivateKey: vi.fn(async () => testPrivateKey),
  LTI_KEY_ID: "test-key",
  LTI_SIGNING_ALG: "RS256",
}));

const { normalizeScore, buildAgsScorePayload, pushGradeToCanvas } = await import(
  "./gradePassback"
);

const baseSubmission = {
  id: "sub-1",
  status: "GRADED" as const,
  totalScore: 8,
  exam: { questions: [{ points: 6 }, { points: 4 }] },
  student: { canvasUserId: "canvas-user-1" },
  gradePassback: null as null | { status: string; scoreGiven: number; canvasResponseJson: unknown },
};

const baseLaunch = {
  id: "launch-1",
  platformId: "platform-1",
  lineitemUrl: "https://canvas.example/lineitems/1",
  lineitemsUrl: null,
  lineitems: null,
  agsScopeJson: ["https://purl.imsglobal.org/spec/lti-ags/scope/score"],
};

const basePlatform = {
  id: "platform-1",
  clientId: "client-1",
  tokenEndpoint: "https://canvas.example/login/oauth2/token",
};

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256");
  testPrivateKey = privateKey;
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizeScore", () => {
  it("clamps a negative score to 0", () => {
    expect(normalizeScore(-5, 10)).toEqual({ scoreGiven: 0, scoreMaximum: 10, scorePct: 0 });
  });

  it("clamps a score above scoreMaximum down to scoreMaximum", () => {
    expect(normalizeScore(15, 10)).toEqual({ scoreGiven: 10, scoreMaximum: 10, scorePct: 100 });
  });

  it("computes the percentage for a normal score", () => {
    expect(normalizeScore(5, 10)).toEqual({ scoreGiven: 5, scoreMaximum: 10, scorePct: 50 });
  });

  it("returns a null percentage when scoreMaximum is 0", () => {
    expect(normalizeScore(0, 0)).toEqual({ scoreGiven: 0, scoreMaximum: 0, scorePct: null });
  });
});

describe("buildAgsScorePayload", () => {
  it("builds the exact LTI-AGS score shape", () => {
    const payload = buildAgsScorePayload({
      userId: "canvas-user-1",
      scoreGiven: 8,
      scoreMaximum: 10,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(payload).toEqual({
      userId: "canvas-user-1",
      scoreGiven: 8,
      scoreMaximum: 10,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });

  it("defaults the timestamp to now when not provided", () => {
    const before = Date.now();
    const payload = buildAgsScorePayload({ userId: "u1", scoreGiven: 1, scoreMaximum: 1 });
    const parsed = Date.parse(payload.timestamp);
    expect(parsed).toBeGreaterThanOrEqual(before);
  });
});

describe("pushGradeToCanvas", () => {
  it("skips when the student has no canvasUserId (not an LTI user)", async () => {
    mockPrisma.submission.findUnique.mockResolvedValue({
      ...baseSubmission,
      student: { canvasUserId: null },
    });
    mockPrisma.canvasGradePassback.upsert.mockResolvedValue({});

    const result = await pushGradeToCanvas("sub-1");

    expect(result).toMatchObject({ skipped: true, status: "SKIPPED" });
    expect(mockPrisma.ltiLaunch.findFirst).not.toHaveBeenCalled();
  });

  it("is NOT_READY when the submission is not GRADED", async () => {
    mockPrisma.submission.findUnique.mockResolvedValue({
      ...baseSubmission,
      status: "SUBMITTED",
      totalScore: null,
    });
    mockPrisma.canvasGradePassback.upsert.mockResolvedValue({});

    const result = await pushGradeToCanvas("sub-1");

    expect(result).toMatchObject({ skipped: true, status: "NOT_READY" });
  });

  it("skips when no LTI launch exists for the submission", async () => {
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission);
    mockPrisma.ltiLaunch.findFirst.mockResolvedValue(null);
    mockPrisma.canvasGradePassback.upsert.mockResolvedValue({});

    const result = await pushGradeToCanvas("sub-1");

    expect(result).toMatchObject({ skipped: true, status: "SKIPPED" });
  });

  it("returns FAILED when Canvas's scores endpoint returns a non-2xx response", async () => {
    mockPrisma.submission.findUnique.mockResolvedValue(baseSubmission);
    mockPrisma.ltiLaunch.findFirst.mockResolvedValue(baseLaunch);
    mockPrisma.ltiPlatform.findUnique.mockResolvedValue(basePlatform);
    mockPrisma.canvasGradePassback.upsert.mockResolvedValue({});

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/token")) {
          return new Response(
            JSON.stringify({ access_token: "fake-token", expires_in: 3600, token_type: "Bearer", scope: "score" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
      }),
    );

    const result = await pushGradeToCanvas("sub-1");

    expect(result).toMatchObject({ success: false, status: "FAILED" });
  });

  it("is idempotent: skips re-sending when already SENT with the same score", async () => {
    mockPrisma.submission.findUnique.mockResolvedValue({
      ...baseSubmission,
      gradePassback: { status: "SENT", scoreGiven: 8, canvasResponseJson: { ok: true } },
    });
    mockPrisma.ltiLaunch.findFirst.mockResolvedValue(baseLaunch);
    mockPrisma.ltiPlatform.findUnique.mockResolvedValue(basePlatform);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await pushGradeToCanvas("sub-1");

    expect(result).toMatchObject({ success: true, status: "SENT" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resends when force is true even if already SENT with the same score", async () => {
    mockPrisma.submission.findUnique.mockResolvedValue({
      ...baseSubmission,
      gradePassback: { status: "SENT", scoreGiven: 8, canvasResponseJson: { ok: true } },
    });
    mockPrisma.ltiLaunch.findFirst.mockResolvedValue(baseLaunch);
    mockPrisma.ltiPlatform.findUnique.mockResolvedValue(basePlatform);
    mockPrisma.canvasGradePassback.upsert.mockResolvedValue({});
    mockPrisma.ltiLaunch.update.mockResolvedValue({});

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/token")) {
          return new Response(
            JSON.stringify({ access_token: "fake-token", expires_in: 3600, token_type: "Bearer", scope: "score" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ resultUrl: "https://canvas.example/result" }), { status: 200 });
      }),
    );

    const result = await pushGradeToCanvas("sub-1", { force: true });

    expect(result).toMatchObject({ success: true, status: "SENT" });
  });
});
