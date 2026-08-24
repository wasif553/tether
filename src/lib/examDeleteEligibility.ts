/**
 * Exam Archive Lifecycle v1 — see docs/exam-archive-lifecycle-v1.md.
 *
 * Authoritative server-side eligibility check for permanently deleting
 * an exam. Every relation from Exam down to Submission/IntegrityEvent/
 * evidence/secure-client tables is `onDelete: Cascade` in
 * prisma/schema.prisma — an unconditional `prisma.exam.delete()` would
 * silently cascade through every academic and integrity record tied to
 * the exam. This is the single choke point every delete path must call
 * BEFORE attempting the delete; never rely on what the UI displays.
 *
 * Fails closed: any relation this function doesn't explicitly know to be
 * safe blocks deletion. Configuration-only relations (Question,
 * QuestionPool, ExamAssignment, ExamTimeAccommodation, LtiExamLink,
 * SecureClientConfiguration, SecureClientLaunchManifest) are
 * deliberately NOT checked — they represent the exam's own never-used
 * setup, not persisted student/assessment activity, and are expected to
 * cascade away with a genuinely unused draft.
 */
import { prisma } from "@/lib/prisma";

export type ExamDeleteEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

export async function checkExamDeleteEligibility(examId: string): Promise<ExamDeleteEligibility> {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { published: true } });
  if (!exam) return { eligible: false, reason: "Exam not found." };

  if (exam.published) {
    return {
      eligible: false,
      reason: "This exam cannot be permanently deleted because it is published. Unpublish it (or archive it) instead.",
    };
  }

  const [
    submissions,
    integrityEvents,
    networkEvidence,
    evidenceAssets,
    similarityAnalyses,
    aiUseReviewAnalyses,
    timingAnalyses,
    aiAssistanceInteractions,
    cohortCollusionAnalyses,
    secureClientSessions,
    secureClientEvents,
    ltiLaunches,
  ] = await Promise.all([
    prisma.submission.count({ where: { examId } }),
    prisma.integrityEvent.count({ where: { examId } }),
    prisma.networkEvidence.count({ where: { examId } }),
    prisma.integrityEvidenceAsset.count({ where: { examId } }),
    prisma.submissionSimilarityAnalysis.count({ where: { examId } }),
    prisma.aiUseReviewAnalysis.count({ where: { examId } }),
    prisma.timingAnalysis.count({ where: { examId } }),
    prisma.aiAssistanceInteraction.count({ where: { examId } }),
    prisma.cohortCollusionAnalysis.count({ where: { examId } }),
    prisma.secureClientSession.count({ where: { examId } }),
    prisma.secureClientEvent.count({ where: { examId } }),
    prisma.ltiLaunch.count({ where: { examId } }),
  ]);

  const counts = {
    submissions,
    integrityEvents,
    networkEvidence,
    evidenceAssets,
    similarityAnalyses,
    aiUseReviewAnalyses,
    timingAnalyses,
    aiAssistanceInteractions,
    cohortCollusionAnalyses,
    secureClientSessions,
    secureClientEvents,
    ltiLaunches,
  };

  const blocking = (Object.keys(counts) as Array<keyof typeof counts>).filter((key) => counts[key] > 0);

  if (blocking.length > 0) {
    return {
      eligible: false,
      reason: "This exam cannot be permanently deleted because assessment records exist. Archive it instead.",
    };
  }

  return { eligible: true };
}
