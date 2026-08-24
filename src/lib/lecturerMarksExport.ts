/**
 * Exam Archive Lifecycle v1 — Marks Export. See
 * docs/exam-archive-lifecycle-v1.md, "Marks export", for why this is a
 * deliberately separate, purpose-built module rather than a change to
 * the existing src/lib/assessmentExport.ts/exportFormats.ts pipeline
 * (which other export formats — xlsx, pdf, the institutional upload
 * format — depend on, and whose `marks-csv` format includes raw
 * integrity risk-level/event-count columns this feature's own CSV must
 * NOT surface).
 *
 * Reuses scorePercentage() from src/lib/analytics.ts — the SAME
 * percentage-calculation function analytics/reports use — rather than
 * re-deriving it; totalScore/maxScore come straight from the stored
 * Submission.totalScore and the exam's Question.points sum, the same
 * authoritative values shown everywhere else in the lecturer UI.
 */
import { prisma } from "@/lib/prisma";
import { scorePercentage } from "@/lib/analytics";

export class MarksExportExamNotFoundError extends Error {}

export type MarksExportRow = {
  studentName: string;
  studentId: string | null;
  studentEmail: string;
  courseCode: string | null;
  courseName: string | null;
  examTitle: string;
  submissionStatus: string;
  submittedAt: string | null;
  rawMark: number | null;
  maxMark: number;
  percentage: number | null;
  gradingStatus: string;
  integrityReviewStatus: string;
  /** Per-question awarded score, in question order — only populated when the detailed export is requested. */
  questionScores?: (number | null)[];
};

export type MarksExportData = {
  examTitle: string;
  courseCode: string | null;
  questionCount: number;
  rows: MarksExportRow[];
};

// Submission-lifecycle fact — separate from grading progress (see
// gradingStatusFor below). Mirrors the same two-state "has the student
// submitted yet" distinction already used across the lecturer UI.
function submissionStatusFor(submittedAt: Date | null): string {
  return submittedAt ? "Submitted" : "In progress";
}

// Reuses the EXACT vocabulary already shown to lecturers on the
// Submissions list and Analytics pages (MARKING_LABELS in
// src/app/lecturer/exams/[id]/submissions/page.tsx and
// src/app/lecturer/exams/[id]/analytics/page.tsx) — never a
// differently-worded status for the same underlying fact.
function gradingStatusFor(status: "IN_PROGRESS" | "SUBMITTED" | "GRADED"): string {
  if (status === "GRADED") return "Marked";
  if (status === "SUBMITTED") return "Not marked";
  return "In progress";
}

/**
 * Derived ONLY from IntegrityEvent.reviewStatus — never severity, never
 * a raw event count. "Not required" (zero events), "Needs review" (at
 * least one event still NEEDS_REVIEW or ESCALATED), "Reviewed"
 * (has events, all resolved/reviewed). See
 * docs/exam-archive-lifecycle-v1.md's "integrity signals ≠ misconduct
 * determination" principle.
 */
function integrityReviewStatusFor(reviewStatuses: string[]): string {
  if (reviewStatuses.length === 0) return "Not required";
  const stillOpen = reviewStatuses.some((s) => s === "NEEDS_REVIEW" || s === "ESCALATED");
  return stillOpen ? "Needs review" : "Reviewed";
}

export async function buildLecturerMarksExport(examId: string): Promise<MarksExportData> {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      course: { select: { code: true, name: true } },
      questions: { select: { id: true, points: true }, orderBy: { order: "asc" } },
      submissions: {
        include: {
          student: { select: { name: true, email: true, institutionStudentId: true } },
          integrityEvents: { select: { reviewStatus: true } },
          answers: { select: { questionId: true, score: true } },
        },
        orderBy: { startedAt: "asc" },
      },
    },
  });

  if (!exam) throw new MarksExportExamNotFoundError(`Exam ${examId} not found`);

  const maxMark = exam.questions.reduce((sum, q) => sum + q.points, 0);
  const questionIds = exam.questions.map((q) => q.id);

  const rows: MarksExportRow[] = exam.submissions.map((s) => {
    const percentage = s.totalScore != null ? scorePercentage(s.totalScore, maxMark) : null;
    const scoreByQuestionId = new Map(s.answers.map((a) => [a.questionId, a.score]));
    return {
      studentName: s.student.name,
      studentId: s.student.institutionStudentId,
      studentEmail: s.student.email,
      courseCode: exam.course?.code ?? null,
      courseName: exam.course?.name ?? null,
      examTitle: exam.title,
      submissionStatus: submissionStatusFor(s.submittedAt),
      submittedAt: s.submittedAt?.toISOString() ?? null,
      rawMark: s.totalScore,
      maxMark,
      percentage,
      gradingStatus: gradingStatusFor(s.status),
      integrityReviewStatus: integrityReviewStatusFor(s.integrityEvents.map((e) => e.reviewStatus)),
      questionScores: questionIds.map((qId) => scoreByQuestionId.get(qId) ?? null),
    };
  });

  return { examTitle: exam.title, courseCode: exam.course?.code ?? null, questionCount: exam.questions.length, rows };
}

function csvEscape(value: string | number | null): string {
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(values: Array<string | number | null>): string {
  return values.map(csvEscape).join(",");
}

const SUMMARY_HEADERS = [
  "Student name",
  "Student ID",
  "Student email",
  "Course code",
  "Course name",
  "Exam",
  "Submission status",
  "Submitted at",
  "Raw mark",
  "Maximum mark",
  "Percentage",
  "Grading status",
  "Integrity review status",
];

function summaryRowValues(r: MarksExportRow): Array<string | number | null> {
  return [
    r.studentName,
    r.studentId,
    r.studentEmail,
    r.courseCode,
    r.courseName,
    r.examTitle,
    r.submissionStatus,
    r.submittedAt,
    r.rawMark,
    r.maxMark,
    r.percentage != null ? Math.round(r.percentage * 100) / 100 : null,
    r.gradingStatus,
    r.integrityReviewStatus,
  ];
}

/** UTF-8 CSV, CRLF line endings (standard for spreadsheet/Excel compatibility), correct escaping for commas/quotes/newlines. */
export function marksExportToCsv(data: MarksExportData, detail: boolean): string {
  const questionHeaders = detail ? Array.from({ length: data.questionCount }, (_, i) => `Q${i + 1}`) : [];
  const headers = [...SUMMARY_HEADERS, ...questionHeaders];
  const lines = [toCsvRow(headers)];
  for (const row of data.rows) {
    const values = summaryRowValues(row);
    if (detail) values.push(...(row.questionScores ?? []));
    lines.push(toCsvRow(values));
  }
  return lines.join("\r\n") + "\r\n";
}

const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/** `<course-code>_<exam-title>_marks_<YYYY-MM-DD>.csv` — course-code segment omitted for a legacy institution-wide exam with no course. */
export function marksExportFilename(data: MarksExportData, now: Date = new Date()): string {
  const sanitize = (s: string) =>
    s
      .replace(ILLEGAL_FILENAME_CHARS, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const parts = [data.courseCode, data.examTitle].filter((p): p is string => Boolean(p && p.trim())).map(sanitize);
  const dateStr = now.toISOString().slice(0, 10);
  return `${[...parts, "marks", dateStr].join("_")}.csv`;
}
