/**
 * Controlled AI Brainstorming Assistance v1 — lecturer read-only review.
 * See docs/controlled-ai-brainstorming-assistance-v1.md.
 *
 * Server-only (Prisma). Same ownership-check pattern as
 * src/lib/evidenceReport.ts (buildEvidenceReport): a lecturer may only
 * review interactions for a submission belonging to an exam THEY created
 * (or a platform admin, in the same institution). Never exposes hidden
 * rubric text, model answers, rejected candidate text (never stored at
 * all — see the AiAssistanceInteraction Prisma model comment), verifier
 * system prompts, or provider credentials — only the fields already safe
 * for a student-facing transcript, shown back to the lecturer instead.
 */
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin } from "@/lib/institutionScope";
import type { Session } from "next-auth";

export class AiAssistanceReviewNotFoundError extends Error {}
export class AiAssistanceReviewForbiddenError extends Error {}

export type AiAssistanceReviewInteraction = {
  id: string;
  questionId: string;
  questionText: string;
  studentPrompt: string;
  response: string | null;
  status: string;
  promptNumberForQuestion: number;
  promptNumberForAttempt: number;
  policyVersion: string;
  createdAt: string;
};

export type AiAssistanceReview = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  aiAssistanceEnabled: boolean;
  interactions: AiAssistanceReviewInteraction[];
};

export async function buildAiAssistanceReview(
  submissionId: string,
  session: Session,
): Promise<AiAssistanceReview> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      student: { select: { name: true, email: true } },
      exam: { select: { id: true, title: true, createdById: true, institutionId: true } },
      aiAssistanceInteractions: {
        orderBy: { createdAt: "asc" },
        include: { question: { select: { text: true } } },
      },
    },
  });
  if (!submission) throw new AiAssistanceReviewNotFoundError("Submission not found");

  const lecturerId = session.user.id;
  if (!isPlatformAdmin(session) && submission.exam.createdById !== lecturerId) {
    throw new AiAssistanceReviewForbiddenError("Not the owner of this exam");
  }
  if (session.user.institutionId && submission.exam.institutionId !== session.user.institutionId) {
    throw new AiAssistanceReviewForbiddenError("Submission belongs to a different institution");
  }

  return {
    submissionId: submission.id,
    student: { name: submission.student.name, email: submission.student.email },
    exam: { id: submission.exam.id, title: submission.exam.title },
    aiAssistanceEnabled: submission.aiAssistancePolicySnapshotJson != null,
    interactions: submission.aiAssistanceInteractions.map((interaction) => ({
      id: interaction.id,
      questionId: interaction.questionId,
      questionText: interaction.question.text,
      studentPrompt: interaction.studentPrompt,
      response: interaction.approvedResponse,
      status: interaction.status,
      promptNumberForQuestion: interaction.promptNumberForQuestion,
      promptNumberForAttempt: interaction.promptNumberForAttempt,
      policyVersion: interaction.policyVersion,
      createdAt: interaction.createdAt.toISOString(),
    })),
  };
}
