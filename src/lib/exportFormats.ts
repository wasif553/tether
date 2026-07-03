/**
 * Assessment Operations v1 — export format writers. See
 * docs/assessment-operations-v1.md.
 *
 * Pure formatting functions over the data already assembled by
 * src/lib/assessmentExport.ts — no Prisma/auth logic here, so the same
 * row data can be rendered to CSV, Excel, or PDF without duplicating
 * the access-control or field-selection decisions made upstream.
 */
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { MarksReport, MarksRow, UploadReadyRow } from "@/lib/assessmentExport";
import { RISK_LEVEL_LABELS } from "@/lib/integrityRisk";

function csvEscape(value: string | number | boolean | null): string {
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(values: Array<string | number | boolean | null>): string {
  return values.map(csvEscape).join(",");
}

const FULL_REPORT_HEADERS = [
  "Institution",
  "Course Code",
  "Course Name",
  "Exam Title",
  "Exam ID",
  "Student Name",
  "Student ID",
  "Student Email",
  "Submission ID",
  "Status",
  "Started At",
  "Submitted At",
  "Graded At",
  "Total Score",
  "Max Score",
  "Percentage",
  "Integrity Risk Level",
  "Integrity Event Count",
  "Access Code Required",
  "Camera Required",
  "Notes",
];

function fullReportRowValues(r: MarksRow): Array<string | number | boolean | null> {
  return [
    r.institutionName,
    r.courseCode,
    r.courseName,
    r.examTitle,
    r.examId,
    r.studentName,
    r.institutionStudentId,
    r.studentEmail,
    r.submissionId,
    r.status,
    r.startedAt,
    r.submittedAt,
    r.gradedAt,
    r.totalScore,
    r.maxScore,
    r.percentage != null ? Math.round(r.percentage * 100) / 100 : null,
    RISK_LEVEL_LABELS[r.riskLevel],
    r.integrityEventCount,
    r.accessCodeRequired ? "Yes" : "No",
    r.cameraRequired ? "Yes" : "No",
    r.notes,
  ];
}

export function marksReportToCsv(report: MarksReport): string {
  const lines = [toCsvRow(FULL_REPORT_HEADERS)];
  for (const row of report.rows) lines.push(toCsvRow(fullReportRowValues(row)));
  return lines.join("\n");
}

const UPLOAD_READY_HEADERS = [
  "Student ID",
  "Student Name",
  "Student Email",
  "Exam/Assignment Name",
  "Mark",
  "Mark Out Of",
  "Percentage",
  "Submitted At",
  "Status",
];

function uploadReadyRowValues(r: UploadReadyRow): Array<string | number | boolean | null> {
  return [
    r.studentId,
    r.studentName,
    r.studentEmail,
    r.examName,
    r.mark,
    r.markOutOf,
    r.percentage != null ? Math.round(r.percentage * 100) / 100 : null,
    r.submittedAt,
    r.status,
  ];
}

export function uploadReadyToCsv(rows: UploadReadyRow[]): string {
  const lines = [toCsvRow(UPLOAD_READY_HEADERS)];
  for (const row of rows) lines.push(toCsvRow(uploadReadyRowValues(row)));
  return lines.join("\n");
}

export async function marksReportToXlsxBuffer(report: MarksReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Full Marks Report");
  sheet.addRow(FULL_REPORT_HEADERS);
  for (const row of report.rows) sheet.addRow(fullReportRowValues(row));
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function uploadReadyToXlsxBuffer(rows: UploadReadyRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Marks Upload");
  sheet.addRow(UPLOAD_READY_HEADERS);
  for (const row of rows) sheet.addRow(uploadReadyRowValues(row));
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export const EVIDENCE_DISCLAIMER =
  "Integrity signals are indicators for review. The lecturer or institution makes the final academic decision.";

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;

export async function buildPdfReportBuffer(report: MarksReport): Promise<Buffer> {
  const { meta, rows, integritySummary } = report;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function ensureSpace(lineHeight: number) {
    if (y - lineHeight < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  }

  function writeLine(text: string, opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {}) {
    const size = opts.size ?? 10;
    const useFont = opts.bold ? boldFont : font;
    const [r, g, b] = opts.color ?? [0.1, 0.1, 0.1];
    ensureSpace(size + 6);
    page.drawText(text, { x: MARGIN, y, size, font: useFont, color: rgb(r, g, b) });
    y -= size + 6;
  }

  writeLine("Exam Results Report", { size: 16, bold: true, color: [0, 0, 0] });
  y -= 4;
  writeLine(`Institution: ${meta.institutionName}`, { color: [0.27, 0.27, 0.27] });
  if (meta.courseCode || meta.courseName) {
    writeLine(`Course: ${meta.courseCode ?? ""} ${meta.courseName ?? ""}`.trim(), { color: [0.27, 0.27, 0.27] });
  }
  writeLine(`Exam: ${meta.examTitle} (${meta.examId})`, { color: [0.27, 0.27, 0.27] });
  writeLine(`Lecturer: ${meta.lecturerName}`, { color: [0.27, 0.27, 0.27] });
  if (meta.scheduleFrom || meta.scheduleUntil) {
    writeLine(
      `Schedule: ${meta.scheduleFrom ? new Date(meta.scheduleFrom).toLocaleString() : "no start restriction"}` +
        ` - ${meta.scheduleUntil ? new Date(meta.scheduleUntil).toLocaleString() : "no end restriction"}`,
      { color: [0.27, 0.27, 0.27] },
    );
  }
  writeLine(`Exported: ${new Date().toLocaleString()}`, { color: [0.27, 0.27, 0.27] });
  y -= 8;

  writeLine("Summary", { size: 12, bold: true, color: [0, 0, 0] });
  if (meta.totalAssignedOrEnrolled != null) {
    writeLine(`Students assigned/enrolled: ${meta.totalAssignedOrEnrolled}`, { color: [0.27, 0.27, 0.27] });
  }
  writeLine(`Submissions received: ${meta.submissionsReceived}`, { color: [0.27, 0.27, 0.27] });
  writeLine(`Pending submissions (not yet graded): ${meta.pendingSubmissions}`, { color: [0.27, 0.27, 0.27] });
  writeLine(
    `Average score: ${meta.averageScorePct != null ? `${Math.round(meta.averageScorePct)}%` : "N/A"}`,
    { color: [0.27, 0.27, 0.27] },
  );
  y -= 8;

  writeLine("Integrity Summary", { size: 12, bold: true, color: [0, 0, 0] });
  writeLine(`Clean submissions: ${integritySummary.cleanCount}`, { color: [0.27, 0.27, 0.27] });
  writeLine(`Needing review (low/medium risk): ${integritySummary.needsReviewCount}`, {
    color: [0.27, 0.27, 0.27],
  });
  writeLine(`High-risk count: ${integritySummary.highRiskCount}`, { color: [0.27, 0.27, 0.27] });
  y -= 8;

  writeLine("Marks", { size: 12, bold: true, color: [0, 0, 0] });
  y -= 2;

  const colWidths = [110, 70, 130, 60, 45, 55, 60];
  const headers = ["Student", "Student ID", "Email", "Score", "%", "Status", "Submitted"];
  ensureSpace(20);
  let x = MARGIN;
  headers.forEach((h, i) => {
    page.drawText(h, { x, y, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    x += colWidths[i];
  });
  y -= 14;

  for (const row of rows) {
    ensureSpace(14);
    x = MARGIN;
    const cells = [
      row.studentName,
      row.institutionStudentId ?? "",
      row.studentEmail,
      row.totalScore != null ? `${row.totalScore}/${row.maxScore}` : "",
      row.percentage != null ? `${Math.round(row.percentage)}%` : "",
      row.status,
      row.submittedAt ? new Date(row.submittedAt).toLocaleDateString() : "",
    ];
    cells.forEach((c, i) => {
      const text = String(c).slice(0, 40);
      page.drawText(text, { x, y, size: 8, font, color: rgb(0.2, 0.2, 0.2) });
      x += colWidths[i];
    });
    y -= 14;
  }

  y -= 10;
  ensureSpace(20);
  page.drawText(EVIDENCE_DISCLAIMER, { x: MARGIN, y, size: 8, font, color: rgb(0.4, 0.4, 0.4) });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
