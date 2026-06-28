import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateQuestions, AIGenerationError } from "@/lib/ai/questionGenerator";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

const generateQuestionsRequestSchema = z.object({
  sourceMaterial: z.string().min(1),
  subject: z.string().min(1),
  totalCount: z.number().int().positive().max(50),
  difficulty: z
    .object({
      easy: z.number().int().min(0).max(100),
      medium: z.number().int().min(0).max(100),
      hard: z.number().int().min(0).max(100),
    })
    .refine((d) => d.easy + d.medium + d.hard === 100, {
      message: "Difficulty percentages must sum to 100",
    }),
  types: z.array(z.enum(["MCQ", "SHORT_ANSWER", "ESSAY"])).min(1),
  existingQuestions: z.array(z.string()).optional(),
});

export async function POST(
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

  const body = await req.json();
  const parsed = generateQuestionsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const questions = await generateQuestions(parsed.data);
    return NextResponse.json({ questions });
  } catch (err) {
    if (err instanceof AIGenerationError) {
      console.error(`AI question generation failed for exam ${examId}:`, err.message);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error(`Unexpected error generating questions for exam ${examId}:`, err);
    return NextResponse.json({ error: "Failed to generate questions" }, { status: 502 });
  }
}

export const dynamic = "force-dynamic";
