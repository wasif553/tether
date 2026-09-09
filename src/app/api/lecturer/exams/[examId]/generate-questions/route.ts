import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateQuestions, AIGenerationError } from "@/lib/ai/questionGenerator";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import { deploymentEnvironment } from "@/lib/secureClientAvailability";

/**
 * AI question-generation schema follow-up, Part 8 — never the raw Zod
 * dump a lecturer previously saw ("MCQ correctAnswer must be one of...").
 * A technical `details` field is only ever attached outside Production —
 * an allowlist (preview/local-development), deliberately never a
 * `!== "production"` denylist, so an unrecognised/misconfigured
 * environment fails closed to "hidden" rather than ever risking exposure
 * on a real lecturer's Production account. See
 * src/lib/secureClientAvailability.ts's own doc comment for why
 * VERCEL_ENV (via deploymentEnvironment()), not NODE_ENV, is what
 * actually distinguishes Preview from Production here.
 */
function showTechnicalDetail(): boolean {
  const env = deploymentEnvironment();
  return env === "preview" || env === "local-development";
}

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
    const result = await generateQuestions(parsed.data);

    // Part 7 — partial success is never silently discarded, and never an
    // all-or-nothing failure when SOME questions validated. Only a
    // genuinely empty result (nothing survived normalization + the one
    // bounded repair attempt) is reported as a failure.
    if (result.producedCount === 0) {
      console.error(
        `AI question generation produced 0 valid questions of ${result.requestedCount} requested for exam ${examId}.`,
      );
      return NextResponse.json(
        {
          error:
            "Tether could not generate a valid set of questions. It tried to repair the output but was not able to produce a valid set. Please try again.",
          ...(showTechnicalDetail() ? { details: "0 of " + result.requestedCount + " generated questions passed schema validation, even after one repair attempt." } : {}),
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      questions: result.questions,
      requestedCount: result.requestedCount,
      producedCount: result.producedCount,
      // Human-readable only when some (but not all) requested questions
      // validated — never exposes schema/validation internals.
      warning:
        result.failedCount > 0
          ? `${result.producedCount} of ${result.requestedCount} questions were generated successfully. ${result.failedCount} could not be validated.`
          : null,
    });
  } catch (err) {
    if (err instanceof AIGenerationError) {
      console.error(`AI question generation failed for exam ${examId}:`, err.message);
      return NextResponse.json(
        {
          error: "Tether could not generate questions right now. Please try again.",
          ...(showTechnicalDetail() ? { details: err.message } : {}),
        },
        { status: 502 },
      );
    }
    console.error(`Unexpected error generating questions for exam ${examId}:`, err);
    return NextResponse.json({ error: "Failed to generate questions" }, { status: 502 });
  }
}

export const dynamic = "force-dynamic";
