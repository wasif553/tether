/**
 * Controlled AI Brainstorming Assistance v1 — lecturer read-only review.
 * See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * GET /api/lecturer/submissions/[id]/ai-assistance
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  buildAiAssistanceReview,
  AiAssistanceReviewForbiddenError,
  AiAssistanceReviewNotFoundError,
} from "@/lib/aiAssistanceReview";
import { institutionErrorResponse } from "@/lib/institutionScope";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const review = await buildAiAssistanceReview(id, session);
    return NextResponse.json(review);
  } catch (err) {
    if (err instanceof AiAssistanceReviewNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (err instanceof AiAssistanceReviewForbiddenError) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
