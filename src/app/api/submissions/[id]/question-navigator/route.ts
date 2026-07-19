/**
 * Question Navigator v1 — see docs/question-navigator-v1.md.
 *
 * GET /api/submissions/[id]/question-navigator
 *
 * Student-only, own submission only — same access rules as the existing
 * current-question route. Returns ONLY safe per-question metadata
 * (index/number/state/lock/navigability/flag) for the questions actually
 * selected for THIS submission — never question text, options, correct
 * answers, answer text, unselected pool questions, or another student's
 * state.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { buildQuestionNavigatorResponse, QuestionNavigatorError } from "@/lib/questionNavigatorRunner";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const response = await buildQuestionNavigatorResponse(id, session.user.id);
    return NextResponse.json(response);
  } catch (err) {
    if (err instanceof QuestionNavigatorError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
