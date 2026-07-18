/**
 * Oral Verification Workflow v1 — see
 * docs/oral-verification-workflow-v1.md.
 *
 * POST /api/lecturer/submissions/[id]/oral-verification — the ONLY way
 * an OralVerification record is ever created: an explicit lecturer
 * action ("Require oral verification"), never automatic. Generates
 * deterministic, editable follow-up questions from the student's actual
 * answers (no LLM — see src/lib/oralVerificationQuestions.ts). Audited.
 *
 * GET — lists the submission's oral verifications for the lecturer.
 * Lecturer-only; nothing here is ever exposed to students (risk scores,
 * comparison details, and lecturerNotes stay staff-side).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { generateOralVerificationQuestions } from "@/lib/oralVerificationQuestions";
import { resolveEffectiveQuestionIds } from "@/lib/questionDelivery";
import { parseSecureSettings, questionPoolsActive } from "@/lib/secureExam";

function findSubmissionForPermissionCheck(submissionId: string) {
  return prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      exam: {
        select: {
          id: true,
          createdById: true,
          institutionId: true,
          secureSettings: true,
          questions: { select: { id: true, text: true, order: true, type: true }, orderBy: { order: "asc" } },
        },
      },
      answers: { select: { questionId: true, response: true } },
    },
  });
}
type SubmissionForPermissionCheck = NonNullable<Awaited<ReturnType<typeof findSubmissionForPermissionCheck>>>;

type SubmissionPermission =
  | { response: NextResponse }
  | { session: Session; submission: SubmissionForPermissionCheck };

async function requireSubmissionPermission(submissionId: string): Promise<SubmissionPermission> {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const submission = await findSubmissionForPermissionCheck(submissionId);
  if (!submission) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!isPlatformAdmin(session) && submission.exam.createdById !== session.user.id) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  try {
    assertSameInstitution(session, submission.exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return { response };
    throw err;
  }
  return { session, submission };
}

const createSchema = z.object({
  reason: z.string().min(1).max(2000),
  /** Optional: generate discussion questions anchored to this specific question's answer. */
  questionId: z.string().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const permission = await requireSubmissionPermission(id);
  if ("response" in permission) return permission.response;
  const { session, submission } = permission;

  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Anchor question generation to the requested question, or the first
  // answered non-MCQ question this submission was actually given
  // (respects question pools), or fall back to generic templates.
  const settings = parseSecureSettings(submission.exam.secureSettings);
  const effectiveIds = resolveEffectiveQuestionIds({
    examQuestionIds: submission.exam.questions.map((q) => q.id),
    stored: submission.questionOrderJson,
    questionPoolsActive: questionPoolsActive(settings),
  });
  const answersByQuestion = new Map(submission.answers.map((a) => [a.questionId, a.response]));
  const anchorQuestionId =
    parsed.data.questionId && effectiveIds.includes(parsed.data.questionId)
      ? parsed.data.questionId
      : effectiveIds.find((qid) => {
          const q = submission.exam.questions.find((eq) => eq.id === qid);
          return q && q.type !== "MULTIPLE_CHOICE" && (answersByQuestion.get(qid) ?? "").length > 0;
        }) ?? effectiveIds[0];
  const anchorQuestion = submission.exam.questions.find((q) => q.id === anchorQuestionId);
  const questions = anchorQuestion
    ? generateOralVerificationQuestions({
        questionNumber: effectiveIds.indexOf(anchorQuestion.id) + 1,
        questionText: anchorQuestion.text,
        answerText: answersByQuestion.get(anchorQuestion.id) ?? null,
      })
    : [];

  const verification = await prisma.oralVerification.create({
    data: {
      submissionId: id,
      requestedById: session.user.id,
      status: "REQUIRED",
      reason: parsed.data.reason,
      generatedQuestionsJson: questions,
    },
  });

  createPlatformAuditLog({
    actorId: session.user.id,
    action: "ORAL_VERIFICATION_REQUIRED",
    targetType: "OralVerification",
    targetId: verification.id,
    institutionId: submission.exam.institutionId,
    metadata: { examId: submission.exam.id, submissionId: id, newStatus: "REQUIRED" },
  }).catch(() => {});

  return NextResponse.json(verification, { status: 201 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const permission = await requireSubmissionPermission(id);
  if ("response" in permission) return permission.response;

  const verifications = await prisma.oralVerification.findMany({
    where: { submissionId: id },
    orderBy: { createdAt: "desc" },
    include: {
      requestedBy: { select: { name: true } },
      completedBy: { select: { name: true } },
    },
  });
  return NextResponse.json(verifications);
}

export const dynamic = "force-dynamic";
