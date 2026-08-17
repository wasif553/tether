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
import { isStaleReservation, parseAiAssistancePolicy, isAiAssistanceEnabled } from "@/lib/aiAssistancePolicy";
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
  wasRegenerated: boolean;
  promptNumberForQuestion: number;
  promptNumberForAttempt: number;
  policyVersion: string;
  createdAt: string;
};

export type AiAssistanceReviewSummary = {
  totalRequests: number;
  guidanceShownCount: number;
  declinedCount: number;
  failedCount: number;
  questionsUsedCount: number;
};

export type AiAssistanceReview = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  aiAssistanceEnabled: boolean;
  summary: AiAssistanceReviewSummary;
  interactions: AiAssistanceReviewInteraction[];
};

/**
 * Derives the compact lecturer-facing summary (submission review card and
 * the top of the full review page) from the ALREADY-normalized
 * `interactions` produced by buildAiAssistanceReview below — never from
 * raw Prisma rows — so the stale-RESERVED-to-FAILED interpretation is
 * applied exactly once and can't drift between the summary and the detail
 * list. Commercial polish pass — see
 * docs/controlled-ai-brainstorming-assistance-v1.md. Counts here are
 * informational only: BLOCKED/FAILED are never treated as integrity
 * concerns and no risk score is derived from them.
 */
export function summarizeAiAssistanceInteractions(
  interactions: AiAssistanceReviewInteraction[],
): AiAssistanceReviewSummary {
  const questionIds = new Set<string>();
  let guidanceShownCount = 0;
  let declinedCount = 0;
  let failedCount = 0;
  for (const interaction of interactions) {
    questionIds.add(interaction.questionId);
    if (interaction.status === "APPROVED" || interaction.status === "FALLBACK") {
      guidanceShownCount += 1;
    } else if (interaction.status === "BLOCKED") {
      declinedCount += 1;
    } else if (interaction.status === "FAILED") {
      failedCount += 1;
    }
  }
  return {
    totalRequests: interactions.length,
    guidanceShownCount,
    declinedCount,
    failedCount,
    questionsUsedCount: questionIds.size,
  };
}

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

  const interactions: AiAssistanceReviewInteraction[] = submission.aiAssistanceInteractions.map(
    (interaction) => ({
      id: interaction.id,
      questionId: interaction.questionId,
      questionText: interaction.question.text,
      studentPrompt: interaction.studentPrompt,
      response: interaction.approvedResponse,
      // A RESERVED row still showing at review time is either a request
      // genuinely mid-flight (extremely unlikely by the time a lecturer
      // is looking — the whole pipeline runs synchronously within one
      // request) or an abandoned reservation from a crashed/timed-out
      // invocation that hasn't yet been touched again by a client retry
      // (see reserveInteractionSlot's self-healing in
      // src/lib/aiAssistanceRunner.ts, which only fires on the NEXT
      // request with the same clientRequestId). Never shown as a
      // silently-ambiguous "pending" status here (Part 4 — "RESERVED
      // records cannot remain permanently misleading") — displayed as
      // FAILED once stale.
      status:
        interaction.status === "RESERVED" && isStaleReservation(interaction.createdAt)
          ? "FAILED"
          : interaction.status,
      wasRegenerated: interaction.wasRegenerated,
      promptNumberForQuestion: interaction.promptNumberForQuestion,
      promptNumberForAttempt: interaction.promptNumberForAttempt,
      policyVersion: interaction.policyVersion,
      createdAt: interaction.createdAt.toISOString(),
    }),
  );

  // A non-null snapshot alone does NOT mean Controlled AI was enabled for
  // this attempt — POST /api/exams/[id]/start builds and stores an AI
  // assistance policy snapshot unconditionally, even when the frozen mode
  // is DISABLED (see buildAiAssistancePolicySnapshot's call site there).
  // The only authoritative signal is the snapshot's own `mode`, read back
  // through the SAME fail-closed parser every request-time decision uses
  // (null/malformed/DISABLED all resolve to disabled) — never a bespoke
  // re-inspection of the raw JSON here.
  const aiAssistancePolicy = parseAiAssistancePolicy(submission.aiAssistancePolicySnapshotJson);

  return {
    submissionId: submission.id,
    student: { name: submission.student.name, email: submission.student.email },
    exam: { id: submission.exam.id, title: submission.exam.title },
    aiAssistanceEnabled: isAiAssistanceEnabled(aiAssistancePolicy),
    summary: summarizeAiAssistanceInteractions(interactions),
    interactions,
  };
}
