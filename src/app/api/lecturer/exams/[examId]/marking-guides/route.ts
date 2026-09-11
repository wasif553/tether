/**
 * AI Marking Assistance v1 — question-level marking guide management. See
 * docs/ai-marking-assistance-v1.md.
 *
 * PATCH /api/lecturer/exams/[examId]/marking-guides
 *
 * Saves the lecturer's marking guide for one or more ESSAY questions on
 * this exam in a single request — the "AI Marking Guides" page's "Save
 * marking guides" button saves everything shown on screen at once. A
 * guide belongs to the QUESTION, never a submission/answer: every
 * student's answer to the same question is marked against the same
 * saved guide (see Question.aiMarkingGuide's own schema doc comment).
 * Never touches any existing Answer.aiReasoning snapshot — those remain
 * historical evidence of what was used for that particular draft.
 *
 * All-or-nothing: the complete payload is validated (every questionId
 * genuinely ESSAY and belonging to this exam) BEFORE anything is
 * written; a single invalid/foreign/non-ESSAY id rejects the whole batch
 * with 400 rather than silently dropping it. A lecturer must never see
 * a success response when one requested guide was actually ignored.
 *
 * Reading current guides for the page itself reuses the existing
 * GET /api/exams/[id] (lecturer branch already returns the full,
 * unfiltered Question rows for the owning lecturer) — no new GET route.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

const bodySchema = z.object({
  guides: z
    .array(
      z.object({
        questionId: z.string().min(1),
        // null/empty clears the guide (falls back to the default
        // rubric) — never distinguished from "never configured".
        aiMarkingGuide: z.string().trim().max(4000).nullable(),
      }),
    )
    .min(1)
    .max(200),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;
  let exam;
  try {
    exam = await prisma.exam.findFirst({
      where: { id: examId, createdById: session.user.id, ...institutionWhere(session) },
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
  if (!exam) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Validate the COMPLETE payload before writing anything. Every
  // questionId must genuinely belong to THIS exam and be an ESSAY
  // question — never trust the client's own submitted list beyond that.
  // All-or-nothing: a single invalid/foreign/non-ESSAY id rejects the
  // WHOLE batch (400), never a partial save. A lecturer must never
  // receive "saved" when one requested guide was actually ignored.
  const questionIds = parsed.data.guides.map((g) => g.questionId);
  const validQuestions = await prisma.question.findMany({
    where: { id: { in: questionIds }, examId, type: "ESSAY" },
    select: { id: true },
  });
  const validIds = new Set(validQuestions.map((q) => q.id));
  const invalidQuestionIds = questionIds.filter((id) => !validIds.has(id));
  if (invalidQuestionIds.length > 0) {
    return NextResponse.json(
      {
        error:
          "One or more questionIds are invalid — each must be an ESSAY question belonging to this exam. No marking guides were saved.",
        invalidQuestionIds,
      },
      { status: 400 },
    );
  }

  await prisma.$transaction(
    parsed.data.guides.map((g) =>
      prisma.question.update({
        where: { id: g.questionId },
        data: { aiMarkingGuide: g.aiMarkingGuide?.trim() || null },
      }),
    ),
  );

  return NextResponse.json({ updated: parsed.data.guides.length });
}

export const dynamic = "force-dynamic";
