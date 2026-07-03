/**
 * Assessment Operations v1 — final marks/results exports. See
 * docs/assessment-operations-v1.md.
 *
 * `buildMarksReport` is the single choke point every export route calls
 * (CSV, Excel, PDF, upload-ready) — fixing a data or scoping bug here
 * fixes every export format, mirroring the pattern already used for
 * evidence reports (src/lib/evidenceReport.ts) and analytics
 * (src/lib/analytics.ts).
 *
 * Never includes: passwordHash, accessCodeHash, correctAnswer, raw
 * network evidence, or camera/video footage — this module only ever
 * selects the specific fields listed in the return types below.
 */
import { prisma } from "@/lib/prisma";
import { scorePercentage } from "@/lib/analytics";
import { computeRiskScore, riskLevelForScore, type RiskLevel } from "@/lib/integrityRisk";
import { parseSecureSettings } from "@/lib/secureExam";

export class ExamNotFoundError extends Error {}

export type MarksRow = {
  institutionName: string;
  courseCode: string | null;
  courseName: string | null;
  examTitle: string;
  examId: string;
  studentName: string;
  institutionStudentId: string | null;
  studentEmail: string;
  submissionId: string;
  status: string;
  startedAt: string;
  submittedAt: string | null;
  gradedAt: string | null;
  totalScore: number | null;
  maxScore: number;
  percentage: number | null;
  riskLevel: RiskLevel;
  integrityEventCount: number;
  accessCodeRequired: boolean;
  cameraRequired: boolean;
  notes: string;
};

export type MarksReportMeta = {
  institutionName: string;
  courseCode: string | null;
  courseName: string | null;
  examTitle: string;
  examId: string;
  lecturerName: string;
  scheduleFrom: string | null;
  scheduleUntil: string | null;
  totalAssignedOrEnrolled: number | null;
  submissionsReceived: number;
  pendingSubmissions: number;
  averageScorePct: number | null;
};

export type MarksReport = {
  meta: MarksReportMeta;
  rows: MarksRow[];
  integritySummary: {
    cleanCount: number;
    needsReviewCount: number;
    highRiskCount: number;
  };
};

/** Truncates a joined feedback string so exports stay reasonably sized. */
function summarizeFeedback(feedbacks: string[]): string {
  const joined = feedbacks.filter(Boolean).join(" | ");
  return joined.length > 300 ? `${joined.slice(0, 297)}...` : joined;
}

export async function buildMarksReport(examId: string): Promise<MarksReport> {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      institution: { select: { name: true } },
      course: { select: { code: true, name: true, id: true } },
      createdBy: { select: { name: true } },
      questions: { select: { points: true } },
      submissions: {
        include: {
          student: { select: { name: true, email: true, institutionStudentId: true } },
          answers: { select: { feedback: true } },
          integrityEvents: { select: { severity: true } },
        },
        orderBy: { startedAt: "asc" },
      },
    },
  });

  if (!exam) throw new ExamNotFoundError(`Exam ${examId} not found`);

  const maxScore = exam.questions.reduce((sum, q) => sum + q.points, 0);
  const secureSettings = parseSecureSettings(exam.secureSettings);

  let totalAssignedOrEnrolled: number | null = null;
  if (exam.course) {
    if (exam.assignmentMode === "SELECTED_STUDENTS") {
      totalAssignedOrEnrolled = await prisma.examAssignment.count({ where: { examId } });
    } else {
      totalAssignedOrEnrolled = await prisma.courseEnrollment.count({
        where: { courseId: exam.course.id, role: "STUDENT" },
      });
    }
  }

  const rows: MarksRow[] = exam.submissions.map((s) => {
    const percentage = s.totalScore != null ? scorePercentage(s.totalScore, maxScore) : null;
    const riskScore = computeRiskScore(s.integrityEvents);
    const riskLevel = riskLevelForScore(riskScore);
    return {
      institutionName: exam.institution?.name ?? "",
      courseCode: exam.course?.code ?? null,
      courseName: exam.course?.name ?? null,
      examTitle: exam.title,
      examId: exam.id,
      studentName: s.student.name,
      institutionStudentId: s.student.institutionStudentId,
      studentEmail: s.student.email,
      submissionId: s.id,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      submittedAt: s.submittedAt?.toISOString() ?? null,
      gradedAt: s.gradedAt?.toISOString() ?? null,
      totalScore: s.totalScore,
      maxScore,
      percentage,
      riskLevel,
      integrityEventCount: s.integrityEvents.length,
      accessCodeRequired: exam.accessCodeRequired,
      cameraRequired: secureSettings.requireCamera,
      notes: summarizeFeedback(s.answers.map((a) => a.feedback ?? "")),
    };
  });

  const gradedScores = rows.map((r) => r.percentage).filter((v): v is number => v != null);
  const averageScorePct =
    gradedScores.length > 0 ? gradedScores.reduce((a, b) => a + b, 0) / gradedScores.length : null;

  return {
    meta: {
      institutionName: exam.institution?.name ?? "",
      courseCode: exam.course?.code ?? null,
      courseName: exam.course?.name ?? null,
      examTitle: exam.title,
      examId: exam.id,
      lecturerName: exam.createdBy.name,
      scheduleFrom: (exam.availableFrom ?? exam.startsAt)?.toISOString() ?? null,
      scheduleUntil: (exam.availableUntil ?? exam.endsAt)?.toISOString() ?? null,
      totalAssignedOrEnrolled,
      submissionsReceived: rows.length,
      pendingSubmissions: rows.filter((r) => r.status === "SUBMITTED").length,
      averageScorePct,
    },
    rows,
    integritySummary: {
      cleanCount: rows.filter((r) => r.riskLevel === "CLEAN").length,
      needsReviewCount: rows.filter((r) => r.riskLevel === "LOW" || r.riskLevel === "MEDIUM").length,
      highRiskCount: rows.filter((r) => r.riskLevel === "HIGH").length,
    },
  };
}

export type UploadReadyRow = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  examName: string;
  mark: number | null;
  markOutOf: number;
  percentage: number | null;
  submittedAt: string | null;
  status: string;
};

/**
 * Deliberately excludes everything not marks-focused: no risk level, no
 * event count, no access-code/camera flags, no notes/feedback — see
 * docs/assessment-operations-v1.md for why this file is kept minimal
 * (intended for direct upload to Canvas/an institutional marks system).
 */
export function toUploadReadyRows(report: MarksReport): UploadReadyRow[] {
  return report.rows.map((r) => ({
    studentId: r.institutionStudentId ?? "",
    studentName: r.studentName,
    studentEmail: r.studentEmail,
    examName: r.examTitle,
    mark: r.totalScore,
    markOutOf: r.maxScore,
    percentage: r.percentage,
    submittedAt: r.submittedAt,
    status: r.status,
  }));
}
