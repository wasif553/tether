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
 * addition (a gate check, and a record-on-invalid call) right at the
 * existing accessCodeRequired block, and the underlying gate/record
 * mechanics are exactly the same generic, already-tested primitive
 * (consumeRateLimit/peekRateLimitBlocked) every other surface in this
 * feature uses — proven directly here rather than by standing up a new,
 * heavy test harness for that route.
 *
 * Requires the local test Postgres instance (run via
 * `npm run release:validate`) — src/lib/prisma.ts's
 * assertSafeDatabaseUrlForTests guard blocks a plain `vitest run`.
 */
import { afterAll, describe, expect, it } from "vitest";

const { prisma } = await import("../prisma");
const { examAccessCodeRateLimitGate, recordExamAccessCodeInvalidGuess } = await import("./examAccessCodeRateLimit");
const { EXAM_ACCESS_CODE_SOURCE_SCOPE, EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS } = await import("./rateLimitScopes");

afterAll(async () => {
  await prisma.securityRateLimitBucket.deleteMany({ where: { scope: EXAM_ACCESS_CODE_SOURCE_SCOPE } });
  await prisma.$disconnect();
});

function uniqueSource(label: string): string {
  return `203.0.113.${Math.floor(Math.random() * 254) + 1}-${label}-${Date.now()}`;
}

describe("exam access-code rate limit", () => {
  it("allows attempts under the threshold for a given (source, examId)", async () => {
    const source = uniqueSource("allow");
    const gate = await examAccessCodeRateLimitGate(source, "exam-1");
    expect(gate.allowed).toBe(true);
  });

  it("blocks after repeated recorded invalid guesses against the same exam from the same source", async () => {
    const source = uniqueSource("block");
    for (let i = 0; i < EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS; i++) {
      await recordExamAccessCodeInvalidGuess(source, "exam-2");
    }
    const gate = await examAccessCodeRateLimitGate(source, "exam-2");
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("a different exam from the same source is independent (campus-NAT safety — no shared global quota)", async () => {
    const source = uniqueSource("nat");
    for (let i = 0; i < EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS; i++) {
      await recordExamAccessCodeInvalidGuess(source, "exam-guessed");
    }
    const gate = await examAccessCodeRateLimitGate(source, "exam-different");
    expect(gate.allowed).toBe(true);
  });

  it("a different source is independent from another source's guessing against the same exam", async () => {
    const guessingSource = uniqueSource("indep-guess");
    for (let i = 0; i < EXAM_ACCESS_CODE_SOURCE_MAX_ATTEMPTS; i++) {
      await recordExamAccessCodeInvalidGuess(guessingSource, "exam-3");
    }
    const otherSource = uniqueSource("indep-other");
    const gate = await examAccessCodeRateLimitGate(otherSource, "exam-3");
    expect(gate.allowed).toBe(true);
  });
});
