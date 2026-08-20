/**
 * Auth and Token Abuse Protection v1 — exam access-code rate-limit
 * helper tests. See docs/auth-token-abuse-protection-v1.md.
 *
 * Tested at the dedicated helper-module boundary
 * (src/lib/security/examAccessCodeRateLimit.ts) rather than through the
 * full POST /api/exams/[id]/start route: that route is large,
 * protected-area exam-start logic with many other concerns (secure
 * client, attestation, time accommodations, question delivery); this
 * feature's change to it is a deliberately minimal, isolated two-call
 * addition (a reserve, and a release-on-correct-code call) right at the
 * existing accessCodeRequired block, and the underlying reserve/release
 * mechanics are exactly the same generic, already-tested primitive
 * (reserveRateLimitSlot/safeReleaseRateLimitSlot) every other surface in
 * this feature uses — proven directly here rather than by standing up a
 * new, heavy test harness for that route.
 *
 * Security review v2: the identity now includes an authenticated
 * studentId (source+studentId+examId, not just source+examId) — see this
 * module's own doc comment for why. All tests below reflect the updated
 * function signatures.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 */
import { afterAll, describe, expect, it } from "vitest";

const { prisma } = await import("../prisma");
const { reserveExamAccessCodeSlot, releaseExamAccessCodeSlot } = await import("./examAccessCodeRateLimit");
const { EXAM_ACCESS_CODE_SOURCE_SCOPE, EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS } = await import("./rateLimitScopes");

afterAll(async () => {
  await prisma.securityRateLimitBucket.deleteMany({ where: { scope: EXAM_ACCESS_CODE_SOURCE_SCOPE } });
  await prisma.$disconnect();
});

function uniqueSource(label: string): string {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}-${label}-${Date.now()}`;
}

describe("exam access-code rate limit", () => {
  it("allows attempts under the threshold for a given (source, studentId, examId)", async () => {
    const source = uniqueSource("allow");
    const reservation = await reserveExamAccessCodeSlot(source, "student-1", "exam-1");
    expect(reservation.status).toBe("reserved");
  });

  it("blocks after repeated reservations against the same (source, studentId, examId) that are never released", async () => {
    const source = uniqueSource("block");
    for (let i = 0; i < EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS; i++) {
      await reserveExamAccessCodeSlot(source, "student-2", "exam-2");
    }
    const reservation = await reserveExamAccessCodeSlot(source, "student-2", "exam-2");
    expect(reservation.status).toBe("blocked");
    if (reservation.status === "blocked") expect(reservation.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("a released reservation frees exactly one slot, not the whole bucket", async () => {
    const source = uniqueSource("release");
    let last: Awaited<ReturnType<typeof reserveExamAccessCodeSlot>> | undefined;
    for (let i = 0; i < EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS; i++) {
      last = await reserveExamAccessCodeSlot(source, "student-release", "exam-release");
    }
    if (last?.status !== "reserved") throw new Error("expected reserved");
    await releaseExamAccessCodeSlot(source, "student-release", "exam-release", last.windowStartMs);
    const afterOneRelease = await reserveExamAccessCodeSlot(source, "student-release", "exam-release");
    expect(afterOneRelease.status).toBe("reserved"); // exactly one slot freed, one more fits
    const blockedAgain = await reserveExamAccessCodeSlot(source, "student-release", "exam-release");
    expect(blockedAgain.status).toBe("blocked"); // back to full
  });

  it("a different exam from the same source+student is independent", async () => {
    const source = uniqueSource("nat-exam");
    for (let i = 0; i < EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS; i++) {
      await reserveExamAccessCodeSlot(source, "student-nat", "exam-guessed");
    }
    const reservation = await reserveExamAccessCodeSlot(source, "student-nat", "exam-different");
    expect(reservation.status).toBe("reserved");
  });

  it("security review v2: a different STUDENT from the same source+exam is independent (campus-NAT safety — one student's guesses never lock out another)", async () => {
    const source = uniqueSource("nat-student");
    for (let i = 0; i < EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS; i++) {
      await reserveExamAccessCodeSlot(source, "student-a-guessing", "exam-shared");
    }
    const studentBBlockedCheck = await reserveExamAccessCodeSlot(source, "student-a-guessing", "exam-shared");
    expect(studentBBlockedCheck.status).toBe("blocked"); // student A is genuinely exhausted

    const studentB = await reserveExamAccessCodeSlot(source, "student-b-different", "exam-shared");
    expect(studentB.status).toBe("reserved"); // student B, same source+exam, is unaffected
  });

  it("a different source is independent from another source's guessing against the same student+exam", async () => {
    const guessingSource = uniqueSource("indep-guess");
    for (let i = 0; i < EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS; i++) {
      await reserveExamAccessCodeSlot(guessingSource, "student-indep", "exam-3");
    }
    const otherSource = uniqueSource("indep-other");
    const reservation = await reserveExamAccessCodeSlot(otherSource, "student-indep", "exam-3");
    expect(reservation.status).toBe("reserved");
  });

  it("security review v2: concurrent reservations by ONE student cannot bypass the threshold (Promise.all)", async () => {
    const source = uniqueSource("concurrency");
    const results = await Promise.all(
      Array.from({ length: EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS + 10 }, () =>
        reserveExamAccessCodeSlot(source, "student-concurrency", "exam-concurrency"),
      ),
    );
    const reservedCount = results.filter((r) => r.status === "reserved").length;
    const blockedCount = results.filter((r) => r.status === "blocked").length;
    expect(reservedCount).toBe(EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS);
    expect(blockedCount).toBe(10);
  });
});
