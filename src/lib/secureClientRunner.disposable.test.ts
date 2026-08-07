/**
 * Tether Secure Client Foundation v1 — hardening pass, Part 5 ("Disposable
 * database validation"). See docs/migration-ledger.md.
 *
 * These tests exercise real concurrency/isolation guarantees that only a
 * genuine Postgres instance with docs/secure-client-foundation-seb-v1-migration.sql
 * actually applied can prove (partial unique indexes, advisory-lock
 * serialisation, P2002 races) — they cannot be faked with a mocked Prisma
 * client. Since that migration is still PENDING — NOT APPLIED anywhere
 * (see docs/migration-ledger.md), and the only reachable database in this
 * environment is the shared Preview/Production Supabase instance (which
 * correctly does NOT have this schema), this file must NEVER run against
 * the ambient DATABASE_URL from .env.
 *
 * Excluded from the default `vitest run` (see the `exclude` pattern in
 * vitest.config.ts) and from `npm test`/CI. Run explicitly against a
 * disposable Postgres database that already has the baseline schema (via
 * `prisma db push`) AND this feature's migration applied on top, e.g.:
 *
 *   docker run -d --name tether-disposable-pg -e POSTGRES_PASSWORD=disposable \
 *     -e POSTGRES_DB=tether_disposable -p 55432:5432 postgres:16-alpine
 *   npx prisma db push --url "postgresql://postgres:disposable@localhost:55432/tether_disposable" --accept-data-loss
 *   # then drop the 7 secure-client tables + Submission column and re-apply
 *   # docs/secure-client-foundation-seb-v1-migration.sql by hand, to
 *   # exercise the ACTUAL hand-written SQL rather than Prisma's DSL
 *   # interpretation of it (see the schema-consistency check this same
 *   # commit adds to docs/migration-ledger.md) — or simply `db push` alone
 *   # is sufficient if only the application-logic tests below (not the
 *   # migration-SQL-fidelity check) are needed.
 *   DATABASE_URL="postgresql://postgres:disposable@localhost:55432/tether_disposable" \
 *     npx vitest run src/lib/secureClientRunner.disposable.test.ts
 *
 * The fail-fast guard below refuses to run at all if DATABASE_URL is
 * unset or looks like the shared Supabase project, so an accidental bare
 * `vitest run --no-exclude` (or similar) errors immediately instead of
 * touching shared data.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import type { Prisma } from "@/generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl || /supabase/i.test(databaseUrl)) {
  throw new Error(
    "secureClientRunner.disposable.test.ts refuses to run: DATABASE_URL is missing or references the shared Supabase project. " +
      "This file must only be run with DATABASE_URL pointed at a disposable, migrated Postgres database — see the file header.",
  );
}

const KEY_A = "aa".repeat(32);
vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_KEYS_JSON", JSON.stringify({ k1: KEY_A }));
vi.stubEnv("TETHER_SEB_KEY_ENCRYPTION_ACTIVE_KEY_ID", "k1");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PUBLIC_KEY", publicKey.export({ type: "spki", format: "pem" }).toString());
vi.stubEnv("TETHER_SECURE_CLIENT_SIGNING_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());

const { prisma } = await import("./prisma");
const {
  activateConfiguration,
  createDraftConfiguration,
  addSebAllowedExamKey,
  revokeSebAllowedExamKey,
  validateSebKeyForConfiguration,
  issueLaunchManifest,
  consumeLaunchManifest,
  recordSecureClientEvent,
  recordAttestation,
  getCurrentSessionForSubmission,
  resolveSecureLaunchConsumeTransactionTimeoutMs,
} = await import("./secureClientRunner");
const { computeExpectedRequestHash } = await import("./secureClient/sebBrowserExamKey");
const { computeStudentSubjectHash } = await import("./secureClient/secureLaunchManifest");

const stamp = Date.now();
const cleanup = { institutions: [] as string[], users: [] as string[], exams: [] as string[] };

async function makeInstitution(slug: string) {
  const inst = await prisma.institution.create({ data: { name: `Disposable Test (${slug})`, slug, plan: "pilot", active: true } });
  cleanup.institutions.push(inst.id);
  return inst;
}
async function makeLecturer(institutionId: string, tag: string) {
  const user = await prisma.user.create({
    data: { name: `Lecturer ${tag}`, email: `lecturer-${tag}-${stamp}@test.local`, passwordHash: "x", role: "LECTURER", institutionId },
  });
  cleanup.users.push(user.id);
  return user;
}
async function makeStudent(institutionId: string, tag: string) {
  const user = await prisma.user.create({
    data: { name: `Student ${tag}`, email: `student-${tag}-${stamp}@test.local`, passwordHash: "x", role: "STUDENT", institutionId },
  });
  cleanup.users.push(user.id);
  return user;
}
async function makeExam(institutionId: string, createdById: string, tag: string) {
  const exam = await prisma.exam.create({
    data: { title: `Disposable Exam ${tag} ${stamp}`, durationMins: 30, published: true, createdById, institutionId },
  });
  cleanup.exams.push(exam.id);
  return exam;
}
async function makeSubmission(examId: string, studentId: string) {
  return prisma.submission.create({ data: { examId, studentId } });
}

afterAll(async () => {
  // Best-effort cleanup — this is a disposable database that will be
  // destroyed entirely after this run, but tidying up keeps a re-run
  // against the same container (without re-migrating) meaningful.
  await prisma.secureClientEvent.deleteMany({ where: { examId: { in: cleanup.exams } } }).catch(() => {});
  await prisma.secureClientRecoveryGrant.deleteMany({ where: {} }).catch(() => {});
  await prisma.secureClientAttestation.deleteMany({ where: {} }).catch(() => {});
  await prisma.secureClientSession.deleteMany({ where: { examId: { in: cleanup.exams } } }).catch(() => {});
  await prisma.secureClientLaunchManifest.deleteMany({ where: { examId: { in: cleanup.exams } } }).catch(() => {});
  await prisma.sebAllowedExamKey.deleteMany({ where: {} }).catch(() => {});
  await prisma.secureClientConfiguration.deleteMany({ where: { examId: { in: cleanup.exams } } }).catch(() => {});
  await prisma.submission.deleteMany({ where: { examId: { in: cleanup.exams } } }).catch(() => {});
  await prisma.exam.deleteMany({ where: { id: { in: cleanup.exams } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: cleanup.users } } }).catch(() => {});
  await prisma.institution.deleteMany({ where: { id: { in: cleanup.institutions } } }).catch(() => {});
});

describe("disposable database schema verification", () => {
  it("all seven new tables exist and start empty", async () => {
    const counts = await Promise.all([
      prisma.secureClientConfiguration.count(),
      prisma.sebAllowedExamKey.count(),
      prisma.secureClientLaunchManifest.count(),
      prisma.secureClientSession.count(),
      prisma.secureClientAttestation.count(),
      prisma.secureClientEvent.count(),
      prisma.secureClientRecoveryGrant.count(),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("Submission.secureClientPolicySnapshotJson exists and defaults to null", async () => {
    const inst = await makeInstitution(`schema-check-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `schema-${stamp}`);
    const student = await makeStudent(inst.id, `schema-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "schema-check");
    const submission = await makeSubmission(exam.id, student.id);
    expect(submission.secureClientPolicySnapshotJson).toBeNull();
  });

  it("the active-configuration partial unique index exists with the correct WHERE clause", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'SecureClientConfiguration' AND indexname = 'SecureClientConfiguration_exam_provider_active_key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("WHERE (status = 'ACTIVE'::text)");
  });

  it("the non-terminal-session partial unique index exists with the correct WHERE clause", async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'SecureClientSession' AND indexname = 'SecureClientSession_submission_nonterminal_key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("ENDED");
    expect(rows[0].indexdef).toContain("REJECTED");
  });
});

describe("one active configuration per exam/provider", () => {
  it("a second activation attempt is rejected once one configuration is ACTIVE", async () => {
    const inst = await makeInstitution(`single-active-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `single-active-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "single-active");
    const configA = await createDraftConfiguration({ institutionId: inst.id, examId: exam.id, provider: "SAFE_EXAM_BROWSER" }, lecturer.id);
    const configB = await createDraftConfiguration({ institutionId: inst.id, examId: exam.id, provider: "SAFE_EXAM_BROWSER" }, lecturer.id);

    await activateConfiguration(configA.id, lecturer.id);
    await expect(activateConfiguration(configB.id, lecturer.id)).rejects.toMatchObject({ code: "ALREADY_ACTIVE" });
  });

  it("concurrent activation attempts for the same exam/provider allow exactly one winner (DB-enforced, not just app-level)", async () => {
    const inst = await makeInstitution(`race-active-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `race-active-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "race-active");
    const configA = await createDraftConfiguration({ institutionId: inst.id, examId: exam.id, provider: "SAFE_EXAM_BROWSER" }, lecturer.id);
    const configB = await createDraftConfiguration({ institutionId: inst.id, examId: exam.id, provider: "SAFE_EXAM_BROWSER" }, lecturer.id);

    const results = await Promise.allSettled([activateConfiguration(configA.id, lecturer.id), activateConfiguration(configB.id, lecturer.id)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const activeCount = await prisma.secureClientConfiguration.count({ where: { examId: exam.id, provider: "SAFE_EXAM_BROWSER", status: "ACTIVE" } });
    expect(activeCount).toBe(1);
  });

  it("a configuration ACTIVE in one institution's exam is never returned when looking up another institution's exam (cross-institution isolation)", async () => {
    const instA = await makeInstitution(`cross-inst-a-${stamp}`);
    const instB = await makeInstitution(`cross-inst-b-${stamp}`);
    const lecturerA = await makeLecturer(instA.id, `cross-a-${stamp}`);
    const lecturerB = await makeLecturer(instB.id, `cross-b-${stamp}`);
    const examA = await makeExam(instA.id, lecturerA.id, "cross-a");
    const examB = await makeExam(instB.id, lecturerB.id, "cross-b");

    const configA = await createDraftConfiguration({ institutionId: instA.id, examId: examA.id, provider: "SAFE_EXAM_BROWSER" }, lecturerA.id);
    const configB = await createDraftConfiguration({ institutionId: instB.id, examId: examB.id, provider: "SAFE_EXAM_BROWSER" }, lecturerB.id);
    await activateConfiguration(configA.id, lecturerA.id);
    await activateConfiguration(configB.id, lecturerB.id);

    // Mirrors the exact query the launch route uses (see
    // src/app/api/submissions/[id]/secure-client/launch/route.ts) — always
    // scoped to the submission's OWN examId, so a configuration belonging
    // to a different institution's exam can never be selected.
    const resolvedForExamA = await prisma.secureClientConfiguration.findFirst({ where: { examId: examA.id, status: "ACTIVE" } });
    expect(resolvedForExamA?.id).toBe(configA.id);
    expect(resolvedForExamA?.id).not.toBe(configB.id);
  });
});

describe("terminal sessions do not block a new active session", () => {
  it("an ENDED session never blocks creating a new non-terminal session for the same submission", async () => {
    const inst = await makeInstitution(`terminal-session-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `terminal-${stamp}`);
    const student = await makeStudent(inst.id, `terminal-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "terminal-session");
    const submission = await makeSubmission(exam.id, student.id);

    const ended = await prisma.secureClientSession.create({
      data: { institutionId: inst.id, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType: "SAFE_EXAM_BROWSER", status: "ENDED", endedAt: new Date(), endReason: "test" },
    });
    expect(ended.status).toBe("ENDED");

    const created = await prisma.secureClientSession.create({
      data: { institutionId: inst.id, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType: "SAFE_EXAM_BROWSER", status: "CREATED" },
    });
    expect(created.id).not.toBe(ended.id);
  });

  it("two concurrently-non-terminal sessions for the same submission are rejected by the partial unique index", async () => {
    const inst = await makeInstitution(`two-nonterminal-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `two-nonterminal-${stamp}`);
    const student = await makeStudent(inst.id, `two-nonterminal-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "two-nonterminal");
    const submission = await makeSubmission(exam.id, student.id);

    await prisma.secureClientSession.create({
      data: { institutionId: inst.id, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType: "SAFE_EXAM_BROWSER", status: "ACTIVE" },
    });

    await expect(
      prisma.secureClientSession.create({
        data: { institutionId: inst.id, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType: "SAFE_EXAM_BROWSER", status: "CREATED" },
      }),
    ).rejects.toThrow();
  });
});

describe("resolveSecureLaunchConsumeTransactionTimeoutMs — URGENT fix, Part E timeout policy", () => {
  // Deliberately never vi.unstubAllEnvs() here — that resets EVERY
  // stubbed env var process-wide (not just this describe block's own),
  // which would wipe the signing-key/SEB-key stubs every other test in
  // this file depends on (they're stubbed once, at module top-level,
  // before any dynamic import). Each test below simply overwrites the
  // same TETHER_SECURE_LAUNCH_CONSUME_TRANSACTION_TIMEOUT_MS key, which
  // is safe and self-contained.
  it("defaults to 10 seconds — a conservative, explicit margin over the ~6-round-trip worst case, never Prisma's bare 5s default", () => {
    vi.stubEnv("TETHER_SECURE_LAUNCH_CONSUME_TRANSACTION_TIMEOUT_MS", "");
    expect(resolveSecureLaunchConsumeTransactionTimeoutMs()).toBe(10_000);
  });

  it("respects a valid explicit override", () => {
    vi.stubEnv("TETHER_SECURE_LAUNCH_CONSUME_TRANSACTION_TIMEOUT_MS", "7000");
    expect(resolveSecureLaunchConsumeTransactionTimeoutMs()).toBe(7000);
  });

  it("clamps an absurdly low override to a conservative floor — never lets ops accidentally configure a near-zero timeout", () => {
    vi.stubEnv("TETHER_SECURE_LAUNCH_CONSUME_TRANSACTION_TIMEOUT_MS", "1");
    expect(resolveSecureLaunchConsumeTransactionTimeoutMs()).toBeGreaterThanOrEqual(2000);
  });

  it("clamps a very large override — never the 'blanket increase to a huge number' this fix explicitly avoids", () => {
    vi.stubEnv("TETHER_SECURE_LAUNCH_CONSUME_TRANSACTION_TIMEOUT_MS", "999999");
    expect(resolveSecureLaunchConsumeTransactionTimeoutMs()).toBeLessThanOrEqual(30_000);
  });

  it("falls back to the default for a non-numeric value", () => {
    vi.stubEnv("TETHER_SECURE_LAUNCH_CONSUME_TRANSACTION_TIMEOUT_MS", "not-a-number");
    expect(resolveSecureLaunchConsumeTransactionTimeoutMs()).toBe(10_000);
  });
});

describe("launch manifest consumption", () => {
  async function issueForFreshSubmission(tag: string) {
    const inst = await makeInstitution(`launch-${tag}-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `launch-${tag}-${stamp}`);
    const student = await makeStudent(inst.id, `launch-${tag}-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, `launch-${tag}`);
    const submission = await makeSubmission(exam.id, student.id);
    const { manifest, signature } = await issueLaunchManifest({
      institutionId: inst.id,
      examId: exam.id,
      submissionId: submission.id,
      studentId: student.id,
      configurationId: null,
      clientType: "MOCK_TETHER_CLIENT",
      policy: { ...(await import("./secureClientPolicy")).DISABLED_SECURE_CLIENT_POLICY, secureLaunchTokenTtlSeconds: 300 },
      canonicalExamOrigin: "https://example.test",
      launchPath: `/student/exams/${exam.id}`,
      audience: "tether-secure-client",
    });
    return { manifest, signature, submission };
  }

  // URGENT fix — secure launch consume transaction latency. Every test
  // below exercises the restructured consumeLaunchManifest (pre-check +
  // signature verification BEFORE the transaction, minimum race-sensitive
  // work inside it, best-effort audit logging after it) against the real
  // disposable database — the concurrency/atomicity guarantees this
  // module depends on (the per-submission pg_advisory_xact_lock, the
  // partial unique index on non-terminal sessions) cannot be faked with a
  // mocked Prisma client.

  it("[1] one valid consume succeeds and returns a real session id", async () => {
    const { manifest, signature, submission } = await issueForFreshSubmission("valid");
    const result = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    expect(result.outcome).toBe("CONSUMED");
    if (result.outcome !== "CONSUMED") throw new Error("unreachable");
    const session = await prisma.secureClientSession.findUniqueOrThrow({ where: { id: result.sessionId } });
    expect(session.submissionId).toBe(submission.id);
    expect(session.status).toBe("CREATED");
  });

  it("[2] replay is rejected: consuming the same manifest twice sequentially yields CONSUMED then REPLAY", async () => {
    const { manifest, signature } = await issueForFreshSubmission("replay");
    const first = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    expect(first.outcome).toBe("CONSUMED");
    const second = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    expect(second.outcome).toBe("REPLAY");
  });

  it("[3, 4] two concurrent consumption attempts for the same manifest allow exactly one winner, and no duplicate SecureClientSession is created", async () => {
    const { manifest, signature } = await issueForFreshSubmission("race");
    const [a, b] = await Promise.all([consumeLaunchManifest(manifest, signature, manifest.nonce), consumeLaunchManifest(manifest, signature, manifest.nonce)]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["CONSUMED", "REPLAY"]);

    const sessionCount = await prisma.secureClientSession.count({ where: { submissionId: (await prisma.secureClientLaunchManifest.findUniqueOrThrow({ where: { id: manifest.manifestId } })).submissionId } });
    expect(sessionCount).toBe(1);
  });

  it("[5] an expired manifest (past its DB-row expiresAt) is rejected as EXPIRED by the pre-transaction check, before any session is created", async () => {
    const { manifest, signature, submission } = await issueForFreshSubmission("expired");
    await prisma.secureClientLaunchManifest.update({ where: { id: manifest.manifestId }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const result = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    expect(result.outcome).toBe("EXPIRED");

    const sessionCount = await prisma.secureClientSession.count({ where: { submissionId: submission.id } });
    expect(sessionCount).toBe(0);
  });

  it("[6] an already-consumed manifest is rejected on a fresh call (not just the immediately-following one)", async () => {
    const { manifest, signature } = await issueForFreshSubmission("already-consumed");
    await consumeLaunchManifest(manifest, signature, manifest.nonce);
    const secondCallLater = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    expect(secondCallLater.outcome).toBe("REPLAY");
  });

  it("[8] an invalid signature is rejected before any transactional mutation — no session created, manifest remains unconsumed", async () => {
    const { manifest, submission } = await issueForFreshSubmission("badsig");
    const tamperedSignature = Buffer.from("this is not a real ed25519 signature").toString("base64");

    const result = await consumeLaunchManifest(manifest, tamperedSignature, manifest.nonce);
    expect(result.outcome).toBe("INVALID_SIGNATURE");

    const record = await prisma.secureClientLaunchManifest.findUniqueOrThrow({ where: { id: manifest.manifestId } });
    expect(record.consumedAt).toBeNull();
    const sessionCount = await prisma.secureClientSession.count({ where: { submissionId: submission.id } });
    expect(sessionCount).toBe(0);
  });

  it("[9] a transaction failure (e.g. the production P2028) is caught, translated to TRANSIENT_FAILURE, and leaves no partial state", async () => {
    const { manifest, signature, submission } = await issueForFreshSubmission("txfail");
    const p2028 = Object.assign(new Error('Transaction API error: A query cannot be executed on an expired transaction.\ntimeout: 5000 ms\ntimeTaken: 5623 ms'), { code: "P2028" });
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(p2028);

    const result = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    spy.mockRestore();

    expect(result.outcome).toBe("TRANSIENT_FAILURE");
    const record = await prisma.secureClientLaunchManifest.findUniqueOrThrow({ where: { id: manifest.manifestId } });
    expect(record.consumedAt).toBeNull();
    expect(record.clientSessionId).toBeNull();
    const sessionCount = await prisma.secureClientSession.count({ where: { submissionId: submission.id } });
    expect(sessionCount).toBe(0);
  });

  it("[10] retry after a transient pre-commit failure behaves safely — the manifest is still consumable and produces exactly one session", async () => {
    const { manifest, signature, submission } = await issueForFreshSubmission("txretry");
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(Object.assign(new Error("simulated transient failure"), { code: "P2028" }));

    const failedAttempt = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    spy.mockRestore();
    expect(failedAttempt.outcome).toBe("TRANSIENT_FAILURE");

    const retriedAttempt = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    expect(retriedAttempt.outcome).toBe("CONSUMED");

    const sessionCount = await prisma.secureClientSession.count({ where: { submissionId: submission.id } });
    expect(sessionCount).toBe(1);
  });

  it("Tether launch/install flow v1 — installed-client protocol launch uses a short-lived token bound to policy.secureLaunchTokenTtlSeconds", async () => {
    const inst = await makeInstitution(`ttl-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `ttl-${stamp}`);
    const student = await makeStudent(inst.id, `ttl-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "ttl");
    const submission = await makeSubmission(exam.id, student.id);
    const { DISABLED_SECURE_CLIENT_POLICY } = await import("./secureClientPolicy");
    const ttlSeconds = 120;

    const before = Date.now();
    const { manifest } = await issueLaunchManifest({
      institutionId: inst.id,
      examId: exam.id,
      submissionId: submission.id,
      studentId: student.id,
      configurationId: null,
      clientType: "TETHER_SECURE_CLIENT",
      policy: { ...DISABLED_SECURE_CLIENT_POLICY, secureLaunchTokenTtlSeconds: ttlSeconds },
      canonicalExamOrigin: "https://example.test",
      launchPath: `/student/exams/${exam.id}/tether-launch`,
      audience: "tether-secure-client",
    });
    const after = Date.now();

    const issuedAtMs = Date.parse(manifest.issuedAt);
    const expiresAtMs = Date.parse(manifest.expiresAt);
    // Exactly the configured TTL, never a longer-lived or unbounded token.
    expect(expiresAtMs - issuedAtMs).toBe(ttlSeconds * 1000);
    // issuedAt itself is genuinely server time at issuance, not something
    // a caller could stretch out — bounded by the wall-clock window this
    // test ran in.
    expect(issuedAtMs).toBeGreaterThanOrEqual(before);
    expect(issuedAtMs).toBeLessThanOrEqual(after);
  });
});

describe("wrong authenticated student cannot consume another student's launch", () => {
  it("the manifest's studentSubjectHash is bound to the original student and never matches a different student's hash", async () => {
    const inst = await makeInstitution(`wrong-student-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `wrong-student-${stamp}`);
    const owningStudent = await makeStudent(inst.id, `wrong-student-owner-${stamp}`);
    const otherStudent = await makeStudent(inst.id, `wrong-student-other-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "wrong-student");
    const submission = await makeSubmission(exam.id, owningStudent.id);
    const { DISABLED_SECURE_CLIENT_POLICY } = await import("./secureClientPolicy");

    const { manifest } = await issueLaunchManifest({
      institutionId: inst.id,
      examId: exam.id,
      submissionId: submission.id,
      studentId: owningStudent.id,
      configurationId: null,
      clientType: "TETHER_SECURE_CLIENT",
      policy: { ...DISABLED_SECURE_CLIENT_POLICY, secureLaunchTokenTtlSeconds: 300 },
      canonicalExamOrigin: "https://example.test",
      launchPath: `/student/exams/${exam.id}/tether-launch`,
      audience: "tether-secure-client",
    });

    expect(manifest.studentSubjectHash).toBe(computeStudentSubjectHash(owningStudent.id));
    expect(manifest.studentSubjectHash).not.toBe(computeStudentSubjectHash(otherStudent.id));

    // This is the exact invariant POST /api/secure-client/launch/[manifestId]/consume
    // depends on (see consume/route.ts: `owning.studentId !== session.user.id`
    // -> 404, checked BEFORE consumeLaunchManifest is ever called) — the
    // submission this manifest is bound to resolves to exactly one
    // student, never the other one, regardless of who is currently
    // authenticated when the consume request arrives.
    const owning = await prisma.submission.findUniqueOrThrow({ where: { id: manifest.submissionId }, select: { studentId: true } });
    expect(owning.studentId).toBe(owningStudent.id);
    expect(owning.studentId).not.toBe(otherStudent.id);
  });
});

describe("concurrent sequence numbers remain consistent", () => {
  it("N concurrent events with distinct clientRequestIds and sequential sequenceNumbers all persist exactly once, with no duplicate rows", async () => {
    const inst = await makeInstitution(`seq-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `seq-${stamp}`);
    const student = await makeStudent(inst.id, `seq-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "seq");
    const submission = await makeSubmission(exam.id, student.id);
    const session = await prisma.secureClientSession.create({
      data: { institutionId: inst.id, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType: "MOCK_TETHER_CLIENT", status: "ACTIVE" },
    });

    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordSecureClientEvent({
          secureClientSessionId: session.id,
          submissionId: submission.id,
          examId: exam.id,
          institutionId: inst.id,
          eventType: "SECURE_CLIENT_LAUNCH_REQUESTED",
          clientRequestId: `seq-req-${stamp}-${i}`,
          sequenceNumber: i,
          clientElapsedMs: i * 1000,
          metadata: {},
        }),
      ),
    );

    const persisted = await prisma.secureClientEvent.count({ where: { secureClientSessionId: session.id } });
    expect(persisted).toBe(N);

    // A duplicate clientRequestId sent again (simulating a client retry)
    // must never create a second row — this is the idempotency guarantee
    // sequence-number consistency depends on.
    const retry = await recordSecureClientEvent({
      secureClientSessionId: session.id,
      submissionId: submission.id,
      examId: exam.id,
      institutionId: inst.id,
      eventType: "SECURE_CLIENT_LAUNCH_REQUESTED",
      clientRequestId: `seq-req-${stamp}-0`,
      sequenceNumber: 0,
      clientElapsedMs: 0,
      metadata: {},
    });
    expect(retry.replay).toBe(true);
    const persistedAfterRetry = await prisma.secureClientEvent.count({ where: { secureClientSessionId: session.id } });
    expect(persistedAfterRetry).toBe(N);
  });
});

describe("Corrective pass v1.2.2 — real direct-launch workflow establishes a genuinely VERIFIED session", () => {
  /**
   * This is the exact defect physical testing traced Tasks 1/2 to:
   * consuming a launch manifest only CREATES a session with
   * verificationStatus NOT_CHECKED — it does NOT verify it. Verification
   * only ever happens via recordAttestation (see
   * POST /api/secure-client/sessions/[sessionId]/attestation). Nothing in
   * the real launch flow called it before this corrective pass (only the
   * dev mock-client simulator did) — these tests exercise the exact
   * sequence src/app/student/exams/[id]/tether-launch/page.tsx now runs:
   * issue -> consume -> attest -> verified, against a real database, so a
   * regression that silently drops the attestation call again would be
   * caught here even though no jsdom/Electron is available to catch it
   * at the UI layer.
   */
  async function setupTetherRequiredSubmission(tag: string, requireDisplayCheck: boolean) {
    const inst = await makeInstitution(`attest-flow-${tag}-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `attest-flow-${tag}-${stamp}`);
    const student = await makeStudent(inst.id, `attest-flow-${tag}-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, `attest-flow-${tag}`);
    const { DISABLED_SECURE_CLIENT_POLICY } = await import("./secureClientPolicy");
    const submission = await prisma.submission.create({
      data: {
        examId: exam.id,
        studentId: student.id,
        secureClientPolicySnapshotJson: {
          ...DISABLED_SECURE_CLIENT_POLICY,
          deliveryMode: "TETHER_CLIENT_REQUIRED",
          displayPolicy: requireDisplayCheck ? "SINGLE_DISPLAY_REQUIRED" : "UNRESTRICTED",
          requireDisplayCheck,
          maximumDisplays: requireDisplayCheck ? 1 : 4,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    cleanup.exams.push(exam.id);
    const { manifest, signature } = await issueLaunchManifest({
      institutionId: inst.id,
      examId: exam.id,
      submissionId: submission.id,
      studentId: student.id,
      configurationId: null,
      clientType: "TETHER_SECURE_CLIENT",
      policy: { ...DISABLED_SECURE_CLIENT_POLICY, deliveryMode: "TETHER_CLIENT_REQUIRED", secureLaunchTokenTtlSeconds: 300 },
      canonicalExamOrigin: "https://example.test",
      launchPath: `/student/exams/${exam.id}/tether-launch`,
      audience: "tether-secure-client",
    });
    return { inst, exam, student, submission, manifest, signature };
  }

  it("consuming the manifest alone leaves the session NOT_CHECKED — the actual pre-fix defect, asserted directly so a regression can't silently reintroduce it", async () => {
    const { submission, manifest, signature } = await setupTetherRequiredSubmission("bug-repro", true);
    const consumed = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    expect(consumed.outcome).toBe("CONSUMED");

    const current = await getCurrentSessionForSubmission(submission.id);
    expect(current?.verificationStatus).toBe("NOT_CHECKED");

    const { resolveSecureClientStartGate } = await import("./secureClientStartGate");
    const gate = resolveSecureClientStartGate({
      effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED",
      hasVerifiedTetherSession: current?.verificationStatus === "VERIFIED",
      devBypassAllowed: false,
    });
    expect(gate.kind).toBe("REDIRECT_TO_TETHER_LAUNCH");
  });

  it("issue -> consume -> attest (displayCheck PASS, one display) establishes a genuinely VERIFIED session and the start gate then ALLOWs", async () => {
    const { submission, manifest, signature } = await setupTetherRequiredSubmission("verified-pass", true);
    const consumed = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    if (consumed.outcome !== "CONSUMED") throw new Error(`expected CONSUMED, got ${consumed.outcome}`);
    expect(consumed.sessionId).toBeTruthy();

    const { overallStatus } = await recordAttestation({
      sessionId: consumed.sessionId,
      clientType: "TETHER_SECURE_CLIENT",
      checks: { displayCheck: "PASS" },
      required: { displayCheck: true },
      clientVerificationFailed: false,
      configurationInvalid: false,
      versionUnsupported: false,
      technicalFailure: false,
      displayCount: 1,
      displayTopology: "SINGLE",
    });
    expect(overallStatus).toBe("READY");

    const current = await getCurrentSessionForSubmission(submission.id);
    expect(current?.verificationStatus).toBe("VERIFIED");

    const { resolveSecureClientStartGate } = await import("./secureClientStartGate");
    const gate = resolveSecureClientStartGate({
      effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED",
      hasVerifiedTetherSession: current?.verificationStatus === "VERIFIED",
      devBypassAllowed: false,
    });
    expect(gate.kind).toBe("ALLOW");
  });

  it("issue -> consume -> attest with displayCheck FAIL (two displays at entry) never reaches VERIFIED — the start gate stays blocked, matching Electron's own BLOCKED decision for the same condition", async () => {
    const { submission, manifest, signature } = await setupTetherRequiredSubmission("verified-fail", true);
    const consumed = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    if (consumed.outcome !== "CONSUMED") throw new Error(`expected CONSUMED, got ${consumed.outcome}`);

    const { overallStatus } = await recordAttestation({
      sessionId: consumed.sessionId,
      clientType: "TETHER_SECURE_CLIENT",
      checks: { displayCheck: "FAIL" },
      required: { displayCheck: true },
      clientVerificationFailed: false,
      configurationInvalid: false,
      versionUnsupported: false,
      technicalFailure: false,
      displayCount: 2,
      displayTopology: "EXTEND",
    });
    expect(overallStatus).not.toBe("READY");

    const current = await getCurrentSessionForSubmission(submission.id);
    expect(current?.verificationStatus).not.toBe("VERIFIED");

    const { resolveSecureClientStartGate } = await import("./secureClientStartGate");
    const gate = resolveSecureClientStartGate({
      effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED",
      hasVerifiedTetherSession: current?.verificationStatus === "VERIFIED",
      devBypassAllowed: false,
    });
    expect(gate.kind).toBe("REDIRECT_TO_TETHER_LAUNCH");
  });

  it("when the policy does not require a display check, an empty attestation (no checks at all) still reaches VERIFIED — nothing required, nothing to fail", async () => {
    const { submission, manifest, signature } = await setupTetherRequiredSubmission("no-display-check", false);
    const consumed = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    if (consumed.outcome !== "CONSUMED") throw new Error(`expected CONSUMED, got ${consumed.outcome}`);

    const { overallStatus } = await recordAttestation({
      sessionId: consumed.sessionId,
      clientType: "TETHER_SECURE_CLIENT",
      checks: {},
      required: {},
      clientVerificationFailed: false,
      configurationInvalid: false,
      versionUnsupported: false,
      technicalFailure: false,
      displayCount: null,
      displayTopology: null,
    });
    expect(overallStatus).toBe("READY");

    const current = await getCurrentSessionForSubmission(submission.id);
    expect(current?.verificationStatus).toBe("VERIFIED");
  });

  it("Continue (existing IN_PROGRESS submission, already-verified session) resolves ALLOW without re-issuing a manifest — mirrors what the tether-launch page's early-return branch depends on", async () => {
    const { submission, manifest, signature } = await setupTetherRequiredSubmission("continue-verified", true);
    const consumed = await consumeLaunchManifest(manifest, signature, manifest.nonce);
    if (consumed.outcome !== "CONSUMED") throw new Error(`expected CONSUMED, got ${consumed.outcome}`);
    await recordAttestation({
      sessionId: consumed.sessionId,
      clientType: "TETHER_SECURE_CLIENT",
      checks: { displayCheck: "PASS" },
      required: { displayCheck: true },
      clientVerificationFailed: false,
      configurationInvalid: false,
      versionUnsupported: false,
      technicalFailure: false,
      displayCount: 1,
      displayTopology: "SINGLE",
    });

    // Simulates the student closing and reopening Tether, or a page
    // refresh: the SAME submission is resolved again, and the SAME
    // (already-verified) session is found — /start's idempotent
    // existingInProgress branch depends on exactly this.
    const current = await getCurrentSessionForSubmission(submission.id);
    expect(current?.verificationStatus).toBe("VERIFIED");
    const { resolveSecureClientStartGate } = await import("./secureClientStartGate");
    const gate = resolveSecureClientStartGate({
      effectiveDeliveryMode: "TETHER_CLIENT_REQUIRED",
      hasVerifiedTetherSession: current?.verificationStatus === "VERIFIED",
      devBypassAllowed: false,
    });
    expect(gate.kind).toBe("ALLOW");
    expect(submission.status).toBe("IN_PROGRESS");
  });
});

describe("SEB allowed key encryption round trip against the real database", () => {
  it("an encrypted key can be decrypted server-side and used for request-hash verification", async () => {
    const inst = await makeInstitution(`key-verify-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `key-verify-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "key-verify");
    const config = await createDraftConfiguration({ institutionId: inst.id, examId: exam.id, provider: "SAFE_EXAM_BROWSER" }, lecturer.id);

    const rawKey = "a-real-browser-exam-key-value";
    await addSebAllowedExamKey({ configurationId: config.id, keyType: "BROWSER_EXAM_KEY", rawKey }, lecturer.id);

    const canonicalUrl = "https://example.test/student/exams/abc";
    const suppliedHash = computeExpectedRequestHash(canonicalUrl, rawKey);
    const result = await validateSebKeyForConfiguration(config.id, "BROWSER_EXAM_KEY", suppliedHash, canonicalUrl);
    expect(result.status).toBe("VALID");
  });

  it("a revoked key is rejected even with the correct hash", async () => {
    const inst = await makeInstitution(`key-revoke-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `key-revoke-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, "key-revoke");
    const config = await createDraftConfiguration({ institutionId: inst.id, examId: exam.id, provider: "SAFE_EXAM_BROWSER" }, lecturer.id);

    const rawKey = "a-key-that-will-be-revoked";
    const key = await addSebAllowedExamKey({ configurationId: config.id, keyType: "BROWSER_EXAM_KEY", rawKey }, lecturer.id);
    await revokeSebAllowedExamKey(key.id);

    const canonicalUrl = "https://example.test/student/exams/abc";
    const suppliedHash = computeExpectedRequestHash(canonicalUrl, rawKey);
    const result = await validateSebKeyForConfiguration(config.id, "BROWSER_EXAM_KEY", suppliedHash, canonicalUrl);
    expect(result.status).not.toBe("VALID");
  });
});

describe("Single Display Requirement v1 — attestation display fields against the real database", () => {
  async function makeSessionOfType(tag: string, clientType: "SAFE_EXAM_BROWSER" | "MOCK_TETHER_CLIENT") {
    const inst = await makeInstitution(`disp-attest-${tag}-${stamp}`);
    const lecturer = await makeLecturer(inst.id, `disp-attest-${tag}-${stamp}`);
    const student = await makeStudent(inst.id, `disp-attest-${tag}-${stamp}`);
    const exam = await makeExam(inst.id, lecturer.id, `disp-attest-${tag}`);
    const submission = await makeSubmission(exam.id, student.id);
    const session = await prisma.secureClientSession.create({
      data: { institutionId: inst.id, examId: exam.id, submissionId: submission.id, studentId: student.id, clientType, status: "PREFLIGHT" },
    });
    return session;
  }

  it("a MOCK_TETHER_CLIENT session's reported displayCount and displayTopology are actually persisted", async () => {
    const session = await makeSessionOfType("mock", "MOCK_TETHER_CLIENT");
    await recordAttestation({
      sessionId: session.id,
      clientType: "MOCK_TETHER_CLIENT",
      checks: { displayCheck: "FAIL" },
      required: { displayCheck: true },
      clientVerificationFailed: false,
      configurationInvalid: false,
      versionUnsupported: false,
      technicalFailure: false,
      displayCount: 2,
      displayTopology: "EXTEND",
    });
    const stored = await prisma.secureClientAttestation.findFirstOrThrow({ where: { secureClientSessionId: session.id } });
    expect(stored.displayCount).toBe(2);
    expect((stored.detailsJson as { displayTopology?: string } | null)?.displayTopology).toBe("EXTEND");
  });

  it("a SAFE_EXAM_BROWSER session's claimed displayCount/displayTopology is silently dropped, never persisted", async () => {
    const session = await makeSessionOfType("seb", "SAFE_EXAM_BROWSER");
    await recordAttestation({
      sessionId: session.id,
      clientType: "SAFE_EXAM_BROWSER",
      checks: { displayCheck: "PASS" },
      required: {},
      clientVerificationFailed: false,
      configurationInvalid: false,
      versionUnsupported: false,
      technicalFailure: false,
      displayCount: 1,
      displayTopology: "SINGLE",
    });
    const stored = await prisma.secureClientAttestation.findFirstOrThrow({ where: { secureClientSessionId: session.id } });
    expect(stored.displayCount).toBeNull();
    expect((stored.detailsJson as { displayTopology?: string } | null)?.displayTopology).toBeUndefined();
    // The claimed displayCheck: "PASS" is also force-corrected to
    // NOT_SUPPORTED — SEB has no trustworthy channel to report this.
    expect(stored.displayCheckStatus).toBe("NOT_SUPPORTED");
  });
});
