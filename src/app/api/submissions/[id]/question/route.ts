/**
 * One-Question-At-A-Time Exam Delivery v1. See
 * docs/one-question-delivery-v1.md.
 *
 * GET /api/submissions/[id]/question
 *
 * Read-only: returns the student's CURRENTLY STORED question index (never
 * accepts an index to jump to — that is POST .../question-progress's
 * job), so a plain refresh/reload always restores exactly where the
 * student left off without side effects. Student-only, own submission
 * only, only when the exam has oneQuestionAtATime enabled. Never returns
 * other questions, never returns correctAnswer, never returns the raw
 * questionOrderJson.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildOneQuestionPayload, loadOneQuestionSubmission, OneQuestionModeError } from "@/lib/submissionQuestionPayload";
import { markQuestionVisited } from "@/lib/questionNavigatorRunner";
import { renewContentAccessLeaseFromValidatedDecision } from "@/lib/secureClient/requireTetherContentAccess";
import { createTimingCollector, timeSpan, attachServerTimingHeader, logBoundedNavigationTiming } from "@/lib/serverTiming";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestStartedAtMs = performance.now();
  const timing = createTimingCollector();
  const authStartMs = performance.now();
  const session = await auth();
  timing.record("authMs", performance.now() - authStartMs);
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    // Exam-load latency follow-up (physical acceptance review) — this
    // helper already supported an optional TimingCollector (used by
    // POST question-progress/save-and-navigate) but this, the very first
    // one-question fetch a student's browser makes, never passed one —
    // so this route's own share of "time to first question visible" was
    // previously invisible. Wired through unchanged otherwise.
    const { submission, settings, leaseDecision } = await loadOneQuestionSubmission(id, session.user.id, req, timing);
    const payload = await timeSpan(timing, "payloadBuildMs", () => buildOneQuestionPayload(submission, settings, submission.currentQuestionIndex));
    if (!payload) {
      return NextResponse.json({ error: "This exam has no questions" }, { status: 404 });
    }
    // Question Navigator v1 — covers "the attempt initially opens on the
    // first question" and every subsequent refresh. Best-effort.
    markQuestionVisited(id, payload.question.id).catch(() => {});
    const response = NextResponse.json(payload);
    // Rolling lease renewal, from the SAME decision loadOneQuestionSubmission
    // already computed — no second decode/verify/DB read (see
    // renewContentAccessLeaseFromValidatedDecision's own doc comment).
    if (leaseDecision) {
      renewContentAccessLeaseFromValidatedDecision(response, leaseDecision, { submissionId: submission.id, studentId: submission.studentId });
    }
    timing.record("totalMs", performance.now() - requestStartedAtMs);
    attachServerTimingHeader(response, timing, process.env.TETHER_TIMING_HEADERS_ENABLED);
    logBoundedNavigationTiming("question-load", timing, process.env.TETHER_TIMING_HEADERS_ENABLED);
    return response;
  } catch (err) {
    if (err instanceof OneQuestionModeError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
