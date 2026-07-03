import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";
import { buildMarksReport, toUploadReadyRows, ExamNotFoundError } from "@/lib/assessmentExport";
import {
  marksReportToCsv,
  uploadReadyToCsv,
  marksReportToXlsxBuffer,
  uploadReadyToXlsxBuffer,
  buildPdfReportBuffer,
} from "@/lib/exportFormats";

const FORMATS = ["marks-csv", "marks-xlsx", "upload-csv", "upload-xlsx", "report-pdf"] as const;
type ExportFormat = (typeof FORMATS)[number];

/**
 * Assessment Operations v1 final marks/results exports — see
 * docs/assessment-operations-v1.md. Uses the exact same
 * ownership/institution access-control pattern as the existing
 * analytics and evidence exports (only the exam's owner or a platform
 * admin, same institution) — students are already excluded because
 * this route requires role LECTURER.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ examId: string; format: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId, format } = await params;
  if (!FORMATS.includes(format as ExportFormat)) {
    return NextResponse.json({ error: "Unknown export format" }, { status: 400 });
  }

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!isPlatformAdmin(session) && exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  let report;
  try {
    report = await buildMarksReport(examId);
  } catch (err) {
    if (err instanceof ExamNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("Failed to build marks report", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  const safeTitle = exam.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  switch (format as ExportFormat) {
    case "marks-csv":
      return new NextResponse(marksReportToCsv(report), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeTitle}-full-marks.csv"`,
        },
      });
    case "marks-xlsx": {
      const buffer = await marksReportToXlsxBuffer(report);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${safeTitle}-full-marks.xlsx"`,
        },
      });
    }
    case "upload-csv":
      return new NextResponse(uploadReadyToCsv(toUploadReadyRows(report)), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeTitle}-marks-upload.csv"`,
        },
      });
    case "upload-xlsx": {
      const buffer = await uploadReadyToXlsxBuffer(toUploadReadyRows(report));
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${safeTitle}-marks-upload.xlsx"`,
        },
      });
    }
    case "report-pdf": {
      const buffer = await buildPdfReportBuffer(report);
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${safeTitle}-report.pdf"`,
        },
      });
    }
  }
}

export const dynamic = "force-dynamic";
