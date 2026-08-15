/**
 * One-Question-At-A-Time Exam Delivery v1. See
 * docs/one-question-delivery-v1.md.
 *
 * POST /api/submissions/[id]/question-progress
 *
 * The only way a student's current-question position actually advances.
 * Validates the requested index against allowBackNavigation server-side
 * (never trusts the client's disabled Previous button alone — a direct
 * API call is clamped exactly the same way) and persists the result, then
 * returns the resolved question payload for the new position in the same
 * round trip. Also creates the QUESTION_NAVIGATED_NEXT/PREVIOUS or
 * QUESTION_BACK_NAVIGATION_BLOCKED integrity event directly (rather than
 * relying on the client to separately call the generic integrity-events
 * route), since this route is the single source of truth for whether a
 * requested move was actually a next, a previous, or a blocked
 * back-navigation attempt.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { severityFor } from "@/lib/secureExam";
import { buildOneQuestionPayload, loadOneQuestionSubmission, resolveSequentialQuestionNavigation, OneQuestionModeError } from "@/lib/submissionQuestionPayload";
import { recordSimpleActivityEvent } from "@/lib/answerActivityTelemetry";
import { authoriseDirectNavigation, markQuestionVisited, QuestionNavigatorError } from "@/lib/questionNavigatorRunner";
import { renewContentAccessLeaseFromValidatedDecision } from "@/lib/secureClient/requireTetherContentAccess";
import { logServerTetherDiagnostic } from "@/lib/tetherDiagnosticLog";
import { createTimingCollector, timeSpan, attachServerTimingHeader, logBoundedNavigationTiming } from "@/lib/serverTiming";

// Question Navigator v1 — see docs/question-navigator-v1.md. The GOTO
// action is a DISTINCT navigation surface from the plain `currentIndex`
// body (which is the pre-existing, unaffected sequential Next/Previous
// path — see canNavigateSequential in src/lib/questionNavigator.ts).
// GOTO always requires allowQuestionJumping, even for an adjacent index.
const bodySchema = z
  .object({
    currentIndex: z.number().int().min(0).optional(),
    action: z.literal("GOTO").optional(),
    targetIndex: z.number().int().min(0).optional(),
  })
  .refine(
    (data) => (data.action === "GOTO" ? typeof data.targetIndex === "number" : typeof data.currentIndex === "number"),
    { message: "Provide either currentIndex, or { action: 'GOTO', targetIndex }" },
  );

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestStartedAtMs = performance.now();
  const authStartMs = requestStartedAtMs;
  const session = await auth();
  const authMs = performance.now() - authStartMs;
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Question Navigator v1 — GOTO is authorised entirely by
  // src/lib/questionNavigatorRunner.ts (a distinct, stricter path from
  // the sequential Next/Previous handling below).
  if (parsed.data.action === "GOTO") {
    try {
      const { finalIndex } = await authoriseDirectNavigation(id, session.user.id, parsed.data.targetIndex!);
      const { submission, settings, leaseDecision } = await loadOneQuestionSubmission(id, session.user.id, req);
      const payload = buildOneQuestionPayload(submission, settings, finalIndex);
      if (!payload) return NextResponse.json({ error: "This exam has no questions" }, { status: 404 });
      const response = NextResponse.json(payload);
      // Rolling lease renewal, from the SAME decision loadOneQuestionSubmission
      // already computed — no second decode/verify/DB read (see
      // renewContentAccessLeaseFromValidatedDecision's own doc comment).
      if (leaseDecision) {
        renewContentAccessLeaseFromValidatedDecision(response, leaseDecision, { submissionId: submission.id, studentId: submission.studentId });
      }
      return response;
    } catch (err) {
      if (err instanceof QuestionNavigatorError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      if (err instanceof OneQuestionModeError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
      }
      throw err;
    }
  }

  const requestedIndex = parsed.data.currentIndex!;

  // Latency profiling (physical acceptance follow-up — question
  // navigation latency audit). Bounded, opt-in server-side timing — see
  // logServerTetherDiagnostic's own doc comment. Also exposed via the
  // Server-Timing response header when TETHER_TIMING_HEADERS_ENABLED is
  // set — see serverTiming.ts's own doc comment for why this is a
  // separate, production-usable gate from the diagnostic-log one above.
  const timingStartMs = requestStartedAtMs;
  const timing = createTimingCollector();
  timing.record("authMs", authMs);

  try {
    const { submission, settings, leaseDecision } = await loadOneQuestionSubmission(id, session.user.id, req, timing);

    // Question-navigation performance follow-up — the index-resolution/
    // clamping/update logic now lives in resolveSequentialQuestionNavigation
    // (src/lib/submissionQuestionPayload.ts), shared with POST
    // save-and-navigate. Called here with the plain `prisma` singleton —
    // this route's own currentQuestionIndex update was never
    // transactional, and stays exactly that way.
    const nav = await resolveSequentialQuestionNavigation(prisma, { submission, settings, requestedIndex }, timing);
    const { finalIndex, eventType } = nav;

    // Lightweight navigation logging — INFO/LOW severity (see
    // severityFor in secureExam.ts), never blocks the response.
    if (eventType) {
      prisma.integrityEvent
        .create({
          data: {
            submissionId: submission.id,
            examId: submission.examId,
            studentId: submission.studentId,
            eventType,
            severity: severityFor(eventType, settings),
            message:
              eventType === "QUESTION_BACK_NAVIGATION_BLOCKED"
                ? "A request to return to an earlier question was blocked (back navigation disabled)."
                : eventType === "QUESTION_NAVIGATED_NEXT"
                  ? "Moved to the next question."
                  : "Moved to a previous question.",
            occurredAt: new Date(),
          },
        })
        .catch(() => {
          // Navigation logging is best-effort — never blocks the student.
        });

      // Exam Session Binding + Time Anomaly Review v1 — coarse telemetry
      // marker only, rate-limited so rapid repeat navigation calls don't
      // flood the table. Never blocks navigation.
      recordSimpleActivityEvent({
        submissionId: submission.id,
        eventType: "QUESTION_NAVIGATED",
        questionIndex: finalIndex,
        dedupeWindowMs: 2_000,
      }).catch(() => {});
    }

    // Question Navigator v1 — mark the resolved question visited
    // whenever a sequential move actually lands on a (possibly new)
    // question. Best-effort; never blocks the response.
    if (nav.visitedQuestionId) markQuestionVisited(submission.id, nav.visitedQuestionId).catch(() => {});

    const payload = await timeSpan(timing, "nextQuestionMs", () => buildOneQuestionPayload(submission, settings, finalIndex));
    if (!payload) {
      return NextResponse.json({ error: "This exam has no questions" }, { status: 404 });
    }
    const response = NextResponse.json(payload);
    // Rolling lease renewal, from the SAME decision loadOneQuestionSubmission
    // already computed — no second decode/verify/DB read (see
    // renewContentAccessLeaseFromValidatedDecision's own doc comment).
    const leaseRenewalStartMs = performance.now();
    if (leaseDecision) {
      renewContentAccessLeaseFromValidatedDecision(response, leaseDecision, { submissionId: submission.id, studentId: submission.studentId });
    }
    timing.record("leaseRenewalMs", performance.now() - leaseRenewalStartMs);
    timing.record("totalMs", performance.now() - timingStartMs);
    attachServerTimingHeader(response, timing, process.env.TETHER_TIMING_HEADERS_ENABLED);

    logServerTetherDiagnostic(
      "QUESTION_PROGRESS_TIMING",
      Object.fromEntries(timing.entries().map((e) => [e.name, Math.round(e.durationMs * 100) / 100])),
    );
    // Physical acceptance follow-up — the SAME bounded stages, as one
    // structured JSON log line, gated on the SAME TETHER_TIMING_HEADERS_ENABLED
    // flag as the Server-Timing header above — see save-and-navigate/
    // route.ts's identical wiring for why this is a separate gate from
    // the diagnostic-log one above it.
    logBoundedNavigationTiming("question-progress", timing, process.env.TETHER_TIMING_HEADERS_ENABLED);
    return response;
  } catch (err) {
    if (err instanceof OneQuestionModeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
