/**
 * Question Bank / Exam Pools redesign v1 — see
 * docs/question-bank-exam-pools-v1.md.
 *
 * POST /api/lecturer/exams/[examId]/questions/[questionId]/save-to-bank
 *
 * "Save copy to Question Bank" for an ALREADY-EXISTING exam question
 * (the reverse direction of the from-bank copy route) — snapshots the
 * exam Question's current field values into a brand-new, independent
 * BankQuestion row. No link is stored back to the exam Question either
 * (BankQuestion has no such field) — editing the exam question
 * afterward never touches this bank copy, and editing the bank copy
 * never touches the exam question.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, requireInstitutionId, institutionErrorResponse } from "@/lib/institutionScope";

const saveToBankSchema = z.object({
  bankId: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ examId: string; questionId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { examId, questionId } = await params;
    const question = await prisma.question.findFirst({
      where: {
        id: questionId,
        examId,
        exam: {
          createdById: session.user.id,
          ...(isPlatformAdmin(session) ? {} : { institutionId: requireInstitutionId(session) }),
        },
      },
    });
    if (!question) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const parsed = saveToBankSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const bank = await prisma.questionBank.findFirst({ where: { id: parsed.data.bankId, lecturerId: session.user.id } });
    if (!bank) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const options = Array.isArray(question.options) ? (question.options as unknown[]) : null;

    const bankQuestion = await prisma.bankQuestion.create({
      data: {
        bankId: bank.id,
        type: question.type,
        text: question.text,
        optionsJson: options && options.length > 0 ? JSON.stringify(options) : undefined,
        correctAnswer: question.correctAnswer ?? undefined,
        points: question.points,
      },
    });

    return NextResponse.json(bankQuestion, { status: 201 });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
