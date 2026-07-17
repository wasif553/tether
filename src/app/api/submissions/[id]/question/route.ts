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
    const { submission, settings } = await loadOneQuestionSubmission(id, session.user.id);
    const payload = buildOneQuestionPayload(submission, settings, submission.currentQuestionIndex);
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
