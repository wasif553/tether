/**
 * Answer-Development Provenance v1 — see
 * docs/answer-development-provenance-v1.md ("Code-run limitation").
 *
 * POST /api/submissions/[id]/answer-development/code-run
 *
 * No secure isolated code runner exists in this repo/environment — this
 * route NEVER executes student code inside the Next.js/Vercel application
 * process and NEVER fabricates a pass/fail result. It exists to give the
 * code-working editor's "Run code" contract a real, typed, persisted
 * shape: every request is recorded as a CodeExecutionEvent with
 * exitStatus "NOT_CONFIGURED" and a clear message is returned so the
 * student interface can show a disabled/unavailable state truthfully.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { CODE_WORKING_MAX_CHARACTERS } from "@/lib/answerDevelopmentThresholds";
import { AnswerDevelopmentError, loadValidatedStudentContext, recordDevelopmentEvent } from "@/lib/answerDevelopmentRunner";

const bodySchema = z.object({
  questionId: z.string(),
  code: z.string().max(CODE_WORKING_MAX_CHARACTERS),
  language: z.string().max(50).optional(),
  clientRequestId: z.string().max(100).optional(),
});

export const CODE_EXECUTION_UNAVAILABLE_MESSAGE =
  "Code execution is not configured for this exam. Your code is saved as working, but it is not run or tested automatically.";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
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
  if (!context.policy.enableCodeWorkspace) {
    return NextResponse.json({ error: "Code workspace is not enabled for this exam" }, { status: 403 });
  }

  const answer = await prisma.answer.findUnique({
    where: { submissionId_questionId: { submissionId: id, questionId: parsed.data.questionId } },
    select: { id: true },
  });

  const codeHash = createHash("sha256").update(parsed.data.code).digest("hex");

  if (parsed.data.clientRequestId) {
    const existing = await prisma.codeExecutionEvent.findUnique({
      where: { clientRequestId: parsed.data.clientRequestId },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ ok: true, replay: true, executed: false, message: CODE_EXECUTION_UNAVAILABLE_MESSAGE }, { status: 200 });
    }
  }

  await prisma.codeExecutionEvent.create({
    data: {
      submissionId: id,
      answerId: answer?.id ?? null,
      questionId: parsed.data.questionId,
      clientRequestId: parsed.data.clientRequestId?.trim() || null,
      runType: "RUN",
      language: parsed.data.language ?? null,
      codeHash,
      codeLength: parsed.data.code.length,
      exitStatus: "NOT_CONFIGURED",
      outputSummaryJson: { message: CODE_EXECUTION_UNAVAILABLE_MESSAGE },
    },
  });

  recordDevelopmentEvent({
    submissionId: id,
    answerId: answer?.id ?? null,
    questionId: parsed.data.questionId,
    examAttemptSessionId: null,
    eventType: "CODE_RUN_REQUESTED",
    clientRequestId: null,
    clientElapsedMs: null,
    metadata: { exitStatus: "NOT_CONFIGURED" },
  }).catch(() => {});

  return NextResponse.json({ ok: true, executed: false, message: CODE_EXECUTION_UNAVAILABLE_MESSAGE }, { status: 200 });
}

export const dynamic = "force-dynamic";
