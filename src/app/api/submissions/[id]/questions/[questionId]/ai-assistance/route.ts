/**
 * Controlled AI Brainstorming Assistance v1. See
 * docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * POST /api/submissions/[id]/questions/[questionId]/ai-assistance
 *
 * (Public URL shape matches the task spec's
 * /api/submissions/[submissionId]/questions/[questionId]/ai-assistance —
 * the folder segment is named [id] rather than [submissionId] only
 * because every other route under src/app/api/submissions/ already uses
 * [id], and Next.js requires all dynamic segments at the same path level
 * to share one parameter name.)
 *
 * All actual validation/orchestration lives in
 * src/lib/aiAssistanceRunner.ts — this route only handles auth, request
 * parsing, and mapping AiAssistanceError to a safe, student-friendly HTTP
 * response.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { AiAssistanceError, runAiAssistanceRequest } from "@/lib/aiAssistanceRunner";
import { MAX_STUDENT_PROMPT_CHARACTERS } from "@/lib/aiAssistancePolicy";

const bodySchema = z.object({
  studentPrompt: z.string().min(1).max(MAX_STUDENT_PROMPT_CHARACTERS),
  // Optional — only ever used when the exam's policy snapshot has
  // allowReasoningFeedback true (see the runner); harmless to accept and
  // ignore otherwise.
  studentCurrentReasoning: z.string().max(MAX_STUDENT_PROMPT_CHARACTERS).optional(),
  // Idempotency key (Part 2 hardening) — a client-generated UUID, one per
  // logical "send" action (see src/components/AiBrainstormPanel.tsx).
  // Optional: a request without one is simply never deduplicated.
  clientRequestId: z.string().uuid().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; questionId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: submissionId, questionId } = await params;

  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please enter a message (up to 1000 characters) and try again." },
      { status: 400 },
    );
  }

  try {
    const result = await runAiAssistanceRequest({
      submissionId,
      studentId: session.user.id,
      questionId,
      studentPrompt: parsed.data.studentPrompt,
      studentCurrentReasoning: parsed.data.studentCurrentReasoning ?? null,
      clientRequestId: parsed.data.clientRequestId ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AiAssistanceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Generator/verifier failures (Anthropic errors, malformed model
    // output, etc.) must never surface implementation details to the
    // student — a safe, generic message and a 502 (upstream failure,
    // not the student's fault) instead.
    return NextResponse.json(
      { error: "The brainstorming assistant is temporarily unavailable. Please try again shortly." },
      { status: 502 },
    );
  }
}

export const dynamic = "force-dynamic";
