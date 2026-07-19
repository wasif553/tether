/**
 * Question Navigator v1 — see docs/question-navigator-v1.md.
 *
 * PATCH /api/submissions/[id]/question-state/[questionId]
 *
 * Flag/unflag one question for review. Student-only, own IN_PROGRESS
 * submission only, question must belong to this submission's persisted
 * selected question set, and allowFlagForReview must be true. Never
 * accepts an arbitrary submission/question combination. Returns only the
 * updated safe flag state — never answer text or correct-answer
 * information. This is a student workflow action, never an integrity
 * event.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { setQuestionFlag, QuestionNavigatorError } from "@/lib/questionNavigatorRunner";

const bodySchema = z.object({
  flaggedForReview: z.boolean(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; questionId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, questionId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const updated = await setQuestionFlag(id, session.user.id, questionId, parsed.data.flaggedForReview);
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof QuestionNavigatorError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
