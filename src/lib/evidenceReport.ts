import { prisma } from "@/lib/prisma";
import { computeRiskScore, riskLevelForScore, type RiskLevel } from "@/lib/integrityRisk";
import { labelForEventType } from "@/lib/integrityEventLabels";

export const EVIDENCE_DISCLAIMER =
  "Integrity events are signals for human review and are not automatic misconduct determinations.";

export class EvidenceNotFoundError extends Error {}
export class EvidenceForbiddenError extends Error {}

export type EvidenceReport = {
  submissionId: string;
  student: { name: string; email: string };
  exam: { id: string; title: string };
  status: string;
  startedAt: string;
  submittedAt: string | null;
  gradedAt: string | null;
  totalScore: number | null;
  riskScore: number;
  riskLevel: RiskLevel;
  events: Array<{
    eventType: string;
    eventLabel: string;
    severity: string;
    message: string;
    occurredAt: string;
    resolvedAt: string | null;
    resolvedByName: string | null;
    resolutionNote: string | null;
  }>;
  canvasPassback: {
    status: string;
    scoreGiven: number | null;
    sentAt: string | null;
    errorMessage: string | null;
  } | null;
  aiMarking: {
    answeredEssayCount: number;
    aiDraftedCount: number;
  } | null;
  disclaimer: string;
};

export async function buildEvidenceReport(
  submissionId: string,
  lecturerId: string,
): Promise<EvidenceReport> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    include: {
      student: { select: { name: true, email: true } },
      exam: { select: { id: true, title: true, createdById: true } },
      integrityEvents: {
        include: { resolvedBy: { select: { name: true } } },
        orderBy: { occurredAt: "asc" },
      },
      gradePassback: true,
      answers: { include: { question: { select: { type: true } } } },
    },
  });

  if (!submission) throw new EvidenceNotFoundError(`Submission ${submissionId} not found`);
  if (submission.exam.createdById !== lecturerId) {
    throw new EvidenceForbiddenError("Not the owner of this exam");
  }

  const riskScore = computeRiskScore(submission.integrityEvents);
  const riskLevel = riskLevelForScore(riskScore);

  const essayAnswers = submission.answers.filter((a) => a.question.type === "ESSAY");
  const aiMarking = essayAnswers.length
    ? {
        answeredEssayCount: essayAnswers.filter((a) => a.response != null && a.response !== "").length,
        aiDraftedCount: essayAnswers.filter((a) => a.aiGradedAt != null).length,
      }
    : null;

  return {
    submissionId: submission.id,
    student: { name: submission.student.name, email: submission.student.email },
    exam: { id: submission.exam.id, title: submission.exam.title },
    status: submission.status,
    startedAt: submission.startedAt.toISOString(),
    submittedAt: submission.submittedAt?.toISOString() ?? null,
    gradedAt: submission.gradedAt?.toISOString() ?? null,
    totalScore: submission.totalScore,
    riskScore,
    riskLevel,
    events: submission.integrityEvents.map((e) => ({
      eventType: e.eventType,
      eventLabel: labelForEventType(e.eventType),
      severity: e.severity,
      message: e.message,
      occurredAt: e.occurredAt.toISOString(),
      resolvedAt: e.resolvedAt?.toISOString() ?? null,
      resolvedByName: e.resolvedBy?.name ?? null,
      resolutionNote: e.resolutionNote,
    })),
    canvasPassback: submission.gradePassback
      ? {
          status: submission.gradePassback.status,
          scoreGiven: submission.gradePassback.scoreGiven,
          sentAt: submission.gradePassback.sentAt?.toISOString() ?? null,
          errorMessage: submission.gradePassback.errorMessage,
        }
      : null,
    aiMarking,
    disclaimer: EVIDENCE_DISCLAIMER,
  };
}

export function evidenceReportToCsv(report: EvidenceReport): string {
  const lines: string[] = [];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;

  lines.push("Field,Value");
  lines.push(`Student,${esc(report.student.name)}`);
  lines.push(`Email,${esc(report.student.email)}`);
  lines.push(`Exam,${esc(report.exam.title)}`);
  lines.push(`Status,${esc(report.status)}`);
  lines.push(`Started At,${esc(report.startedAt)}`);
  lines.push(`Submitted At,${esc(report.submittedAt ?? "")}`);
  lines.push(`Score,${esc(report.totalScore != null ? String(report.totalScore) : "")}`);
  lines.push(`Risk Score,${esc(String(report.riskScore))}`);
  lines.push(`Risk Level,${esc(report.riskLevel)}`);
  lines.push("");
  lines.push("Event Type,Severity,Message,Occurred At,Resolved At,Resolved By,Note");
  for (const e of report.events) {
    lines.push(
      [
        esc(e.eventLabel),
        esc(e.severity),
        esc(e.message),
        esc(e.occurredAt),
        esc(e.resolvedAt ?? ""),
        esc(e.resolvedByName ?? ""),
        esc(e.resolutionNote ?? ""),
      ].join(","),
    );
  }
  lines.push("");
  lines.push(esc(report.disclaimer));

  return lines.join("\n");
}
