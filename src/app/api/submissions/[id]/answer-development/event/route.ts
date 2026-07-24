/**
 * Answer-Development Provenance v1 — see
 * docs/answer-development-provenance-v1.md.
 *
 * POST /api/submissions/[id]/answer-development/event
 *
 * Authenticated-student-owned route for structured process metadata that
 * does not require a full readable version (paste-blocked notices,
 * workspace-created/updated markers, code-run requests, source-
 * declaration markers, ...). Never a raw clipboard field, never
 * individual keystrokes — see src/lib/answerDevelopment.ts for the
 * validated event-type list.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DEVELOPMENT_EVENT_TYPES, isValidDevelopmentEventType } from "@/lib/answerDevelopment";
import { DEVELOPMENT_EVENT_RATE_LIMIT_WINDOW_MS } from "@/lib/answerDevelopmentThresholds";
import { isWithinDevelopmentEventRateLimit } from "@/lib/answerProvenancePolicy";
import { findMostRecentSessionId } from "@/lib/examAttemptSessionRunner";
import { AnswerDevelopmentError, loadValidatedStudentContext, recordDevelopmentEvent } from "@/lib/answerDevelopmentRunner";

const eventSchema = z.object({
  eventType: z.enum(DEVELOPMENT_EVENT_TYPES),
  questionId: z.string().optional(),
  clientRequestId: z.string().max(100).optional(),
  clientElapsedMs: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (!isValidDevelopmentEventType(parsed.data.eventType)) {
    return NextResponse.json({ error: "Invalid eventType" }, { status: 400 });
  }

  let context;
  try {
    context = await loadValidatedStudentContext(id, session.user.id, parsed.data.questionId);
  } catch (err) {
    if (err instanceof AnswerDevelopmentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  void context;

  const recentTimestamps = (
    await prisma.answerDevelopmentEvent.findMany({
      where: { submissionId: id, serverReceivedAt: { gte: new Date(Date.now() - DEVELOPMENT_EVENT_RATE_LIMIT_WINDOW_MS) } },
      select: { serverReceivedAt: true },
    })
  ).map((e) => e.serverReceivedAt.getTime());
  if (!isWithinDevelopmentEventRateLimit(recentTimestamps, Date.now())) {
    return NextResponse.json({ error: "Too many event requests in a short period" }, { status: 429 });
  }

  const answer = parsed.data.questionId
    ? await prisma.answer.findUnique({
        where: { submissionId_questionId: { submissionId: id, questionId: parsed.data.questionId } },
        select: { id: true },
      })
    : null;
  const examAttemptSessionId = await findMostRecentSessionId(id);

  const result = await recordDevelopmentEvent({
    submissionId: id,
    answerId: answer?.id ?? null,
    questionId: parsed.data.questionId ?? null,
    examAttemptSessionId,
    eventType: parsed.data.eventType,
    clientRequestId: parsed.data.clientRequestId?.trim() || null,
    clientElapsedMs: parsed.data.clientElapsedMs ?? null,
    metadata: parsed.data.metadata ?? null,
  });

  return NextResponse.json({ ok: true, eventId: result.id, replay: "replay" in result }, { status: "replay" in result ? 200 : 201 });
}

export const dynamic = "force-dynamic";
