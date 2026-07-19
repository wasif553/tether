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
import { questionPoolsActive, severityFor } from "@/lib/secureExam";
import { isBlockedBackNavigation, nextAllowedIndex, resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import { buildOneQuestionPayload, loadOneQuestionSubmission, OneQuestionModeError } from "@/lib/submissionQuestionPayload";
import { recordSimpleActivityEvent } from "@/lib/answerActivityTelemetry";
import { authoriseDirectNavigation, markQuestionVisited, QuestionNavigatorError } from "@/lib/questionNavigatorRunner";

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
  const session = await auth();
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
      const { submission, settings } = await loadOneQuestionSubmission(id, session.user.id);
      const payload = buildOneQuestionPayload(submission, settings, finalIndex);
      if (!payload) return NextResponse.json({ error: "This exam has no questions" }, { status: 404 });
      return NextResponse.json(payload);
    } catch (err) {
      if (err instanceof QuestionNavigatorError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      if (err instanceof OneQuestionModeError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  const requestedIndex = parsed.data.currentIndex!;

  try {
    const { submission, settings } = await loadOneQuestionSubmission(id, session.user.id);
    const storedIndex = submission.currentQuestionIndex;
    // Question Pools v1 — total is the SELECTED question count for this
    // submission when pools are active, never the full exam question
    // count. See docs/question-pools-v1.md.
    const total = resolveEffectiveQuestionIds({
      examQuestionIds: submission.exam.questions.map((q) => q.id),
      stored: submission.questionOrderJson,
      questionPoolsActive: questionPoolsActive(settings),
    }).length;

    const blocked = isBlockedBackNavigation(requestedIndex, storedIndex, settings.allowBackNavigation);
    const finalIndex = nextAllowedIndex(requestedIndex, storedIndex, settings.allowBackNavigation, total);

    if (finalIndex !== storedIndex) {
      await prisma.submission.update({
        where: { id: submission.id },
        data: { currentQuestionIndex: finalIndex },
      });
      submission.currentQuestionIndex = finalIndex;
    }

    // Lightweight navigation logging — INFO/LOW severity (see
    // severityFor in secureExam.ts), never blocks the response.
    const eventType = blocked
      ? "QUESTION_BACK_NAVIGATION_BLOCKED"
      : finalIndex > storedIndex
        ? "QUESTION_NAVIGATED_NEXT"
        : finalIndex < storedIndex
          ? "QUESTION_NAVIGATED_PREVIOUS"
          : null;
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
    const orderedIds = resolveEffectiveQuestionIds({
      examQuestionIds: submission.exam.questions.map((q) => q.id),
      stored: submission.questionOrderJson,
      questionPoolsActive: questionPoolsActive(settings),
    });
    const visitedQuestionId = orderedIds[finalIndex];
    if (visitedQuestionId) markQuestionVisited(submission.id, visitedQuestionId).catch(() => {});

    const payload = buildOneQuestionPayload(submission, settings, finalIndex);
    if (!payload) {
      return NextResponse.json({ error: "This exam has no questions" }, { status: 404 });
    }
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof OneQuestionModeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
