/**
 * Answer-Development Provenance v1 — see
 * docs/answer-development-provenance-v1.md.
 *
 * PUT /api/submissions/[id]/answer-development/artifacts/[artifactType]
 *
 * Authenticated-student-owned route for outline / calculation-working /
 * code-working / source-declaration artifacts. Plain text/structured text
 * only — never unsafe HTML rendering, never executed. History is
 * preserved (AnswerDevelopmentArtifactVersion) — a PUT never silently
 * discards prior working.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isValidArtifactType, ATTEMPT_LEVEL_ARTIFACT_TYPES, type DevelopmentEventType } from "@/lib/answerDevelopment";
import { ARTIFACT_MAX_CHARACTERS } from "@/lib/answerDevelopmentThresholds";
import { AnswerDevelopmentError, loadValidatedStudentContext, upsertAnswerDevelopmentArtifact, recordDevelopmentEvent } from "@/lib/answerDevelopmentRunner";

const bodySchema = z.object({
  content: z.string(),
  questionId: z.string().optional(),
  clientRequestId: z.string().max(100).optional(),
});

const CREATED_EVENT_FOR_TYPE: Record<string, DevelopmentEventType> = {
  OUTLINE: "OUTLINE_CREATED",
  CALCULATION_WORKING: "CALCULATION_WORKING_CREATED",
  CODE_WORKING: "CODE_WORKING_CREATED",
  AI_SOURCE_DECLARATION: "SOURCE_DECLARATION_CREATED",
  GENERAL_SOURCE_DECLARATION: "SOURCE_DECLARATION_CREATED",
};
const UPDATED_EVENT_FOR_TYPE: Record<string, DevelopmentEventType> = {
  OUTLINE: "OUTLINE_UPDATED",
  CALCULATION_WORKING: "CALCULATION_WORKING_UPDATED",
  CODE_WORKING: "CODE_WORKING_UPDATED",
  AI_SOURCE_DECLARATION: "SOURCE_DECLARATION_UPDATED",
  GENERAL_SOURCE_DECLARATION: "SOURCE_DECLARATION_UPDATED",
};

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; artifactType: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id, artifactType } = await params;
  if (!isValidArtifactType(artifactType)) {
    return NextResponse.json({ error: "Invalid artifact type" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const isAttemptLevel = ATTEMPT_LEVEL_ARTIFACT_TYPES.has(artifactType);
  if (!isAttemptLevel && !parsed.data.questionId) {
    return NextResponse.json({ error: "questionId is required for this artifact type" }, { status: 400 });
  }

  let context;
  try {
    context = await loadValidatedStudentContext(id, session.user.id, isAttemptLevel ? undefined : parsed.data.questionId);
  } catch (err) {
    if (err instanceof AnswerDevelopmentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const workspaceEnabled =
    artifactType === "OUTLINE"
      ? context.policy.enableOutlineWorkspace
      : artifactType === "CALCULATION_WORKING"
        ? context.policy.enableCalculationWorkspace
        : artifactType === "CODE_WORKING"
          ? context.policy.enableCodeWorkspace
          : context.policy.requireAiSourceDeclaration; // AI_SOURCE_DECLARATION / GENERAL_SOURCE_DECLARATION
  if (!workspaceEnabled) {
    return NextResponse.json({ error: "This workspace is not enabled for this exam" }, { status: 403 });
  }

  const maxChars = ARTIFACT_MAX_CHARACTERS[artifactType] ?? 20_000;
  if (parsed.data.content.length > maxChars) {
    return NextResponse.json({ error: `Content exceeds the ${maxChars}-character limit for this workspace` }, { status: 413 });
  }

  const answer = parsed.data.questionId
    ? await prisma.answer.findUnique({
        where: { submissionId_questionId: { submissionId: id, questionId: parsed.data.questionId } },
        select: { id: true },
      })
    : null;

  const outcome = await upsertAnswerDevelopmentArtifact({
    submissionId: id,
    questionId: isAttemptLevel ? null : (parsed.data.questionId ?? null),
    answerId: answer?.id ?? null,
    artifactType,
    content: parsed.data.content,
    clientRequestId: parsed.data.clientRequestId?.trim() || null,
  });

  if (outcome.kind !== "unchanged") {
    const eventType = outcome.kind === "created" ? CREATED_EVENT_FOR_TYPE[artifactType] : UPDATED_EVENT_FOR_TYPE[artifactType];
    recordDevelopmentEvent({
      submissionId: id,
      answerId: answer?.id ?? null,
      questionId: isAttemptLevel ? null : (parsed.data.questionId ?? null),
      examAttemptSessionId: null,
      eventType,
      clientRequestId: null,
      clientElapsedMs: null,
      metadata: { artifactType, version: outcome.version },
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, artifactId: outcome.artifactId, version: outcome.version, changed: outcome.kind !== "unchanged" });
}

export const dynamic = "force-dynamic";
