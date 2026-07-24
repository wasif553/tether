/**
 * Answer-Development Provenance v1 — see
 * docs/answer-development-provenance-v1.md.
 *
 * POST /api/submissions/[id]/answer-development/checkpoint
 *
 * Authenticated-student-owned route. Creates a readable answer-version
 * checkpoint when the centralised rules in src/lib/answerDevelopment.ts
 * decide one is warranted — never on every keystroke, never more than
 * the immutable policy's per-question maximum (except for the
 * always-preserved change types). THIS IS PROCESS EVIDENCE, NOT A
 * MISCONDUCT DETECTOR.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { CHECKPOINT_SOURCES, isValidCheckpointSource, toStudentSafeVersionSummary } from "@/lib/answerDevelopment";
import { CHECKPOINT_RESPONSE_TEXT_MAX_CHARS, CHECKPOINT_RATE_LIMIT_WINDOW_MS } from "@/lib/answerDevelopmentThresholds";
import { isWithinCheckpointRateLimit } from "@/lib/answerProvenancePolicy";
import {
  AnswerDevelopmentError,
  loadValidatedStudentContext,
  reserveAndCreateCheckpoint,
  checkPasteRetentionAfterCheckpoint,
} from "@/lib/answerDevelopmentRunner";

const checkpointSchema = z.object({
  questionId: z.string(),
  response: z.string().max(CHECKPOINT_RESPONSE_TEXT_MAX_CHARS),
  source: z.enum(CHECKPOINT_SOURCES),
  clientRequestId: z.string().max(100).optional(),
  clientElapsedMs: z.number().int().nonnegative().optional(),
  pasteInsertedChars: z.number().int().nonnegative().optional(),
  isManualCheckpoint: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = checkpointSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (!isValidCheckpointSource(parsed.data.source)) {
    return NextResponse.json({ error: "Invalid source" }, { status: 400 });
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

  const recentTimestamps = (
    await prisma.answerDevelopmentVersion.findMany({
      where: { submissionId: id, serverReceivedAt: { gte: new Date(Date.now() - CHECKPOINT_RATE_LIMIT_WINDOW_MS) } },
      select: { serverReceivedAt: true },
    })
  ).map((v) => v.serverReceivedAt.getTime());
  if (!isWithinCheckpointRateLimit(recentTimestamps, Date.now())) {
    return NextResponse.json({ error: "Too many checkpoint requests in a short period" }, { status: 429 });
  }

  const clientRequestId = parsed.data.clientRequestId?.trim() || null;
  const outcome = await reserveAndCreateCheckpoint(context.policy, {
    submissionId: id,
    questionId: parsed.data.questionId,
    currentText: parsed.data.response,
    source: parsed.data.source,
    clientRequestId,
    clientElapsedMs: parsed.data.clientElapsedMs ?? null,
    pasteInsertedChars: parsed.data.pasteInsertedChars,
    isManualCheckpoint: parsed.data.isManualCheckpoint,
  });

  if (outcome.kind === "created") {
    checkPasteRetentionAfterCheckpoint(id, parsed.data.questionId).catch(() => {});
    return NextResponse.json(
      {
        ok: true,
        version: toStudentSafeVersionSummary({
          id: outcome.versionId,
          versionNumber: outcome.versionNumber,
          responseLength: parsed.data.response.length,
          changeType: outcome.changeType,
          source: parsed.data.source,
          serverReceivedAt: new Date(),
        }),
      },
      { status: 201 },
    );
  }
  if (outcome.kind === "replay") {
    return NextResponse.json({ ok: true, replay: true, versionId: outcome.versionId }, { status: 200 });
  }
  if (outcome.kind === "suppressed_for_capacity") {
    return NextResponse.json({ ok: true, created: false, reason: "MAX_CHECKPOINTS_REACHED" }, { status: 200 });
  }
  return NextResponse.json({ ok: true, created: false, reason: outcome.reasonCode }, { status: 200 });
}

export const dynamic = "force-dynamic";
