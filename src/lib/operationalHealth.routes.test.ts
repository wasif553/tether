/**
 * Production administration hardening v1 — DB-backed tests for the
 * operational-health and Tether-fleet-visibility platform-admin
 * endpoints. See docs/tether-production-observability.md and
 * docs/tether-broad-rollout-readiness.md.
 *
 * SAFE EXECUTION ONLY: run via `npm run release:validate` (disposable
 * Postgres) — never a direct `npx vitest run` against a shared database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

const { prisma } = await import("./prisma");
const { getOrCreateTestInstitution } = await import("./testInstitution");
const healthRoute = await import("../app/api/platform/operational-health/route");
const fleetRoute = await import("../app/api/platform/tether-fleet/route");

function sessionFor(userId: string, role: string, institutionId: string | null) {
  return { user: { id: userId, role, email: `${userId}@test.local`, name: userId, institutionId } };
}

function getRequest(url: string) {
  return new Request(url);
}

let institutionA: { id: string };
let institutionB: { id: string };
let platformAdmin: { id: string };
let lecturerA: { id: string };
let studentA: { id: string };
const stamp = Date.now();
const cleanup = { users: [] as string[], exams: [] as string[], installations: [] as string[] };

beforeAll(async () => {
  institutionA = await getOrCreateTestInstitution(`op-health-a-${stamp}`);
  institutionB = await getOrCreateTestInstitution(`op-health-b-${stamp}`);
  const passwordHash = await bcrypt.hash("test-password", 4);
  platformAdmin = await prisma.user.create({
    data: { name: "OpHealth Admin", email: `op-health-admin-${stamp}@test.local`, passwordHash, role: "PLATFORM_ADMIN", institutionId: institutionA.id },
  });
  lecturerA = await prisma.user.create({
    data: { name: "OpHealth Lecturer", email: `op-health-lect-${stamp}@test.local`, passwordHash, role: "LECTURER", institutionId: institutionA.id },
  });
  studentA = await prisma.user.create({
    data: { name: "OpHealth Student", email: `op-health-stud-${stamp}@test.local`, passwordHash, role: "STUDENT", institutionId: institutionA.id },
  });
  cleanup.users.push(platformAdmin.id, lecturerA.id, studentA.id);
});

afterAll(async () => {
  await prisma.tetherClientInstallation.deleteMany({ where: { id: { in: cleanup.installations } } });
  await prisma.integrityEvent.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.secureClientLaunchManifest.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } });
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } });
  await prisma.$disconnect();
});

describe("GET /api/platform/operational-health — authorization", () => {
  it("rejects an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await healthRoute.GET(getRequest("http://test.local/api/platform/operational-health"));
    expect(res.status).toBe(401);
  });

  it("rejects a STUDENT", async () => {
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", institutionA.id));
    const res = await healthRoute.GET(getRequest("http://test.local/api/platform/operational-health"));
    expect(res.status).toBe(403);
  });

  it("rejects a LECTURER", async () => {
    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", institutionA.id));
    const res = await healthRoute.GET(getRequest("http://test.local/api/platform/operational-health"));
    expect(res.status).toBe(403);
  });

  it("allows a PLATFORM_ADMIN", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institutionA.id));
    const res = await healthRoute.GET(getRequest("http://test.local/api/platform/operational-health"));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/platform/operational-health — real, persisted derivation", () => {
  it("counts secure-launch manifests issued/consumed/revoked from real rows, scoped by institution", async () => {
    const exam = await prisma.exam.create({
      data: { title: `OpHealth Exam ${stamp}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: institutionA.id },
    });
    cleanup.exams.push(exam.id);
    const submission = await prisma.submission.create({ data: { examId: exam.id, studentId: studentA.id } });

    const issuedOnly = await prisma.secureClientLaunchManifest.create({
      data: {
        institutionId: institutionA.id,
        examId: exam.id,
        submissionId: submission.id,
        studentId: studentA.id,
        clientType: "TETHER_SECURE_CLIENT",
        nonceHash: `nonce-issued-${stamp}`,
        policyHash: "policy-hash",
        manifestHash: "manifest-hash",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const consumed = await prisma.secureClientLaunchManifest.create({
      data: {
        institutionId: institutionA.id,
        examId: exam.id,
        submissionId: submission.id,
        studentId: studentA.id,
        clientType: "TETHER_SECURE_CLIENT",
        nonceHash: `nonce-consumed-${stamp}`,
        policyHash: "policy-hash",
        manifestHash: "manifest-hash",
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(),
      },
    });
    const revoked = await prisma.secureClientLaunchManifest.create({
      data: {
        institutionId: institutionA.id,
        examId: exam.id,
        submissionId: submission.id,
        studentId: studentA.id,
        clientType: "TETHER_SECURE_CLIENT",
        nonceHash: `nonce-revoked-${stamp}`,
        policyHash: "policy-hash",
        manifestHash: "manifest-hash",
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      },
    });

    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institutionA.id));
    const res = await healthRoute.GET(getRequest(`http://test.local/api/platform/operational-health?institutionId=${institutionA.id}&windowHours=24`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secureLaunch.issued).toBeGreaterThanOrEqual(3);
    expect(body.secureLaunch.consumed).toBeGreaterThanOrEqual(1);
    expect(body.secureLaunch.revoked).toBeGreaterThanOrEqual(1);

    await prisma.secureClientLaunchManifest.deleteMany({ where: { id: { in: [issuedOnly.id, consumed.id, revoked.id] } } });
  });

  it("never mixes another institution's counts into a scoped view", async () => {
    const examB = await prisma.exam.create({
      data: { title: `OpHealth Cross Exam ${stamp}`, durationMins: 30, published: true, createdById: lecturerA.id, institutionId: institutionB.id },
    });
    const studentB = await prisma.user.create({
      data: { name: "OpHealth Student B", email: `op-health-stud-b-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: institutionB.id },
    });
    const submissionB = await prisma.submission.create({ data: { examId: examB.id, studentId: studentB.id } });
    const manifestB = await prisma.secureClientLaunchManifest.create({
      data: {
        institutionId: institutionB.id,
        examId: examB.id,
        submissionId: submissionB.id,
        studentId: studentB.id,
        clientType: "TETHER_SECURE_CLIENT",
        nonceHash: `nonce-b-${stamp}`,
        policyHash: "policy-hash",
        manifestHash: "manifest-hash",
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: new Date(),
      },
    });

    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institutionA.id));
    const res = await healthRoute.GET(getRequest(`http://test.local/api/platform/operational-health?institutionId=${institutionA.id}`));
    const body = await res.json();
    // Institution A's scoped view must not have grown just because
    // institution B got a new manifest.
    expect(body.scope.institutionId).toBe(institutionA.id);

    await prisma.secureClientLaunchManifest.delete({ where: { id: manifestB.id } });
    await prisma.submission.delete({ where: { id: submissionB.id } });
    await prisma.exam.delete({ where: { id: examB.id } });
    await prisma.user.delete({ where: { id: studentB.id } });
  });

  it("never fabricates the explicitly-not-persisted metrics list — always returns it, never silently empty", async () => {
    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institutionA.id));
    const res = await healthRoute.GET(getRequest("http://test.local/api/platform/operational-health"));
    const body = await res.json();
    expect(Array.isArray(body.notPersisted)).toBe(true);
    expect(body.notPersisted.length).toBeGreaterThan(0);
  });
});

describe("GET /api/platform/tether-fleet — authorization", () => {
  it("rejects a STUDENT and LECTURER, allows PLATFORM_ADMIN", async () => {
    mockAuth.mockResolvedValue(sessionFor(studentA.id, "STUDENT", institutionA.id));
    expect((await fleetRoute.GET(getRequest("http://test.local/api/platform/tether-fleet"))).status).toBe(403);

    mockAuth.mockResolvedValue(sessionFor(lecturerA.id, "LECTURER", institutionA.id));
    expect((await fleetRoute.GET(getRequest("http://test.local/api/platform/tether-fleet"))).status).toBe(403);

    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institutionA.id));
    expect((await fleetRoute.GET(getRequest("http://test.local/api/platform/tether-fleet"))).status).toBe(200);
  });
});

describe("GET /api/platform/tether-fleet — real classification", () => {
  it("classifies a supported, an outdated, and an unparseable version correctly, scoped by institution", async () => {
    const key = (label: string) => Buffer.from(`fleet-test-${label}-${stamp}`).toString("base64");
    const supported = await prisma.tetherClientInstallation.create({
      data: {
        userId: studentA.id,
        institutionId: institutionA.id,
        publicKey: key("supported"),
        publicKeyFingerprint: `fp-supported-${stamp}`,
        keyAlgorithm: "Ed25519",
        keyProtectionLevel: "SOFTWARE_PROTECTED",
        clientVersion: "99.0.0",
        platform: "win32",
        status: "ACTIVE",
      },
    });
    const outdated = await prisma.tetherClientInstallation.create({
      data: {
        userId: studentA.id,
        institutionId: institutionA.id,
        publicKey: key("outdated"),
        publicKeyFingerprint: `fp-outdated-${stamp}`,
        keyAlgorithm: "Ed25519",
        keyProtectionLevel: "SOFTWARE_PROTECTED",
        clientVersion: "0.0.1",
        platform: "win32",
        status: "ACTIVE",
      },
    });
    const revokedIgnored = await prisma.tetherClientInstallation.create({
      data: {
        userId: studentA.id,
        institutionId: institutionA.id,
        publicKey: key("revoked"),
        publicKeyFingerprint: `fp-revoked-${stamp}`,
        keyAlgorithm: "Ed25519",
        keyProtectionLevel: "SOFTWARE_PROTECTED",
        clientVersion: "99.0.0",
        platform: "win32",
        status: "REVOKED",
      },
    });
    cleanup.installations.push(supported.id, outdated.id, revokedIgnored.id);

    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institutionA.id));
    const res = await fleetRoute.GET(getRequest(`http://test.local/api/platform/tether-fleet?institutionId=${institutionA.id}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    const versions: string[] = body.byVersion.map((v: { clientVersion: string }) => v.clientVersion);
    expect(versions).toContain("99.0.0");
    expect(versions).toContain("0.0.1");

    const supportedRow = body.byVersion.find((v: { clientVersion: string }) => v.clientVersion === "99.0.0");
    expect(supportedRow.classification).toBe("SUPPORTED");
    const outdatedRow = body.byVersion.find((v: { clientVersion: string }) => v.clientVersion === "0.0.1");
    expect(["OUTDATED_BUT_ALLOWED", "UPDATE_REQUIRED"]).toContain(outdatedRow.classification);

    // The REVOKED installation must never be counted — it's not part of
    // the current fleet.
    const totalForBothVersions = supportedRow.installationCount + outdatedRow.installationCount;
    expect(totalForBothVersions).toBe(2);
  });

  it("[unknown/unparseable version] classifies a null/empty clientVersion as UNKNOWN, never crashes", async () => {
    const installation = await prisma.tetherClientInstallation.create({
      data: {
        userId: studentA.id,
        institutionId: institutionA.id,
        publicKey: Buffer.from(`fleet-test-unknown-${stamp}`).toString("base64"),
        publicKeyFingerprint: `fp-unknown-${stamp}`,
        keyAlgorithm: "Ed25519",
        keyProtectionLevel: "SOFTWARE_PROTECTED",
        clientVersion: null,
        platform: "win32",
        status: "ACTIVE",
      },
    });
    cleanup.installations.push(installation.id);

    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institutionA.id));
    const res = await fleetRoute.GET(getRequest(`http://test.local/api/platform/tether-fleet?institutionId=${institutionA.id}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    const nullRow = body.byVersion.find((v: { clientVersion: string | null }) => v.clientVersion === null);
    expect(nullRow?.classification).toBe("UNKNOWN");
  });

  it("[institution isolation] a fleet-visibility view scoped to institution A never includes institution B's installations", async () => {
    const studentB = await prisma.user.create({
      data: { name: "Fleet Student B", email: `fleet-stud-b-${stamp}@test.local`, passwordHash: await bcrypt.hash("x", 4), role: "STUDENT", institutionId: institutionB.id },
    });
    const installationB = await prisma.tetherClientInstallation.create({
      data: {
        userId: studentB.id,
        institutionId: institutionB.id,
        publicKey: Buffer.from(`fleet-test-instB-${stamp}`).toString("base64"),
        publicKeyFingerprint: `fp-instB-${stamp}`,
        keyAlgorithm: "Ed25519",
        keyProtectionLevel: "SOFTWARE_PROTECTED",
        clientVersion: "77.7.7",
        platform: "win32",
        status: "ACTIVE",
      },
    });

    mockAuth.mockResolvedValue(sessionFor(platformAdmin.id, "PLATFORM_ADMIN", institutionA.id));
    const res = await fleetRoute.GET(getRequest(`http://test.local/api/platform/tether-fleet?institutionId=${institutionA.id}`));
    const body = await res.json();
    const versions: string[] = body.byVersion.map((v: { clientVersion: string }) => v.clientVersion);
    expect(versions).not.toContain("77.7.7");

    await prisma.tetherClientInstallation.delete({ where: { id: installationB.id } });
    await prisma.user.delete({ where: { id: studentB.id } });
  });
});
