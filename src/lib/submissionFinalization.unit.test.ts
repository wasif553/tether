/**
 * Auto-submit server-backstop v1 — pre-deployment audit follow-up.
 * Focused unit test for runPostFinalizationEffects' failure isolation:
 * the DB transaction that finalizes a submission (IN_PROGRESS ->
 * SUBMITTED/GRADED) has ALREADY COMMITTED by the time this function
 * runs, so nothing it does may ever propagate a rejection back to the
 * caller (which would otherwise surface as a misleading 500 "Failed to
 * submit exam" on a submission that, in fact, finalized correctly).
 *
 * Entirely mocked — no real Prisma client, no disposable database
 * required; runs under the ordinary `npm test`.
 */
import { describe, expect, it, vi } from "vitest";

const findFirstMock = vi.fn();
const countMock = vi.fn();
const integrityEventCreateMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    networkEvidence: { findFirst: findFirstMock },
    examAttemptSession: { count: countMock },
    integrityEvent: { create: integrityEventCreateMock },
  },
}));

const pushGradeToCanvasMock = vi.fn();
vi.mock("@/lib/lti/gradePassback", () => ({ pushGradeToCanvas: pushGradeToCanvasMock }));

const recordSimpleActivityEventMock = vi.fn();
vi.mock("@/lib/answerActivityTelemetry", () => ({ recordSimpleActivityEvent: recordSimpleActivityEventMock }));

const endExamAttemptSessionsForSubmissionMock = vi.fn();
vi.mock("@/lib/examAttemptSessionRunner", () => ({ endExamAttemptSessionsForSubmission: endExamAttemptSessionsForSubmissionMock }));

const captureNetworkEvidenceMock = vi.fn();
const getClientIpFromRequestMock = vi.fn();
vi.mock("@/lib/networkEvidence", () => ({
  captureNetworkEvidence: captureNetworkEvidenceMock,
  getClientIpFromRequest: getClientIpFromRequestMock,
}));

const { runPostFinalizationEffects } = await import("./submissionFinalization");

function resetMocks() {
  findFirstMock.mockReset().mockResolvedValue(null);
  countMock.mockReset().mockResolvedValue(0);
  integrityEventCreateMock.mockReset().mockResolvedValue(undefined);
  pushGradeToCanvasMock.mockReset().mockReturnValue(Promise.resolve());
  recordSimpleActivityEventMock.mockReset().mockReturnValue(Promise.resolve());
  endExamAttemptSessionsForSubmissionMock.mockReset().mockResolvedValue(undefined);
  captureNetworkEvidenceMock.mockReset().mockReturnValue(Promise.resolve());
  getClientIpFromRequestMock.mockReset().mockReturnValue("203.0.113.1");
}

describe("runPostFinalizationEffects — every step is isolated; the function itself never rejects", () => {
  it("baseline: resolves cleanly when every dependency succeeds", async () => {
    resetMocks();
    await expect(
      runPostFinalizationEffects({ submissionId: "s1", examId: "e1", studentId: "u1", hasEssay: false, req: new Request("http://test.local/x") }),
    ).resolves.toBeUndefined();
  });

  it("the previously-unguarded networkEvidence.findFirst lookup rejecting does NOT propagate — this is the exact pre-deployment-audit defect: a false 500 after the DB already committed", async () => {
    resetMocks();
    findFirstMock.mockRejectedValue(new Error("transient connection blip"));
    await expect(
      runPostFinalizationEffects({ submissionId: "s1", examId: "e1", studentId: "u1", hasEssay: false, req: new Request("http://test.local/x") }),
    ).resolves.toBeUndefined();
  });

  it("pushGradeToCanvas rejecting does not propagate, and is never awaited (fire-and-forget, matching its pre-existing external-system contract)", async () => {
    resetMocks();
    pushGradeToCanvasMock.mockReturnValue(Promise.reject(new Error("Canvas is down")));
    await expect(
      runPostFinalizationEffects({ submissionId: "s1", examId: "e1", studentId: "u1", hasEssay: false }),
    ).resolves.toBeUndefined();
  });

  it("endExamAttemptSessionsForSubmission rejecting (an unexpected escape from its own internal catch) does not propagate", async () => {
    resetMocks();
    endExamAttemptSessionsForSubmissionMock.mockRejectedValue(new Error("db down"));
    await expect(
      runPostFinalizationEffects({ submissionId: "s1", examId: "e1", studentId: "u1", hasEssay: false }),
    ).resolves.toBeUndefined();
  });

  it("captureNetworkEvidence rejecting does not propagate", async () => {
    resetMocks();
    captureNetworkEvidenceMock.mockReturnValue(Promise.reject(new Error("evidence capture failed")));
    await expect(
      runPostFinalizationEffects({ submissionId: "s1", examId: "e1", studentId: "u1", hasEssay: false, req: new Request("http://test.local/x") }),
    ).resolves.toBeUndefined();
  });

  it("session-teardown non-convergence is observable: logs a warning when a non-ENDED ExamAttemptSession row remains after teardown, but still never throws", async () => {
    resetMocks();
    countMock.mockResolvedValue(1); // simulates a stale, still-non-ENDED row after teardown
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runPostFinalizationEffects({ submissionId: "s1", examId: "e1", studentId: "u1", hasEssay: false }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("did not converge"), expect.objectContaining({ submissionId: "s1", stillActive: 1 }));
    errorSpy.mockRestore();
  });

  it("no req (SERVER_BACKSTOP trigger) skips request/IP-attributed evidence entirely — no findFirst/captureNetworkEvidence call at all", async () => {
    resetMocks();
    await runPostFinalizationEffects({ submissionId: "s1", examId: "e1", studentId: "u1", hasEssay: false });
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(captureNetworkEvidenceMock).not.toHaveBeenCalled();
  });
});
