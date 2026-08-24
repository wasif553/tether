import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";
import { buildLecturerMarksExport, marksExportToCsv, marksExportFilename, MarksExportExamNotFoundError } from "@/lib/lecturerMarksExport";

/**
 * Exam Archive Lifecycle v1 — Marks Export. See
 * docs/exam-archive-lifecycle-v1.md. Same ownership/institution
 * access-control pattern as the existing
 * /api/lecturer/exams/[examId]/export/[format] route (only the exam's
 * owner or a platform admin, same institution) — students are already
 * excluded because this route requires role LECTURER.
 *
 * ?detail=true adds one Q<n> column per question with the per-question
 * awarded score; omitted (default) produces the summary CSV only.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;

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

  const detail = new URL(req.url).searchParams.get("detail") === "true";

  let data;
  try {
    data = await buildLecturerMarksExport(examId);
  } catch (err) {
    if (err instanceof MarksExportExamNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("Failed to build lecturer marks export", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  const csv = marksExportToCsv(data, detail);
  const filename = marksExportFilename(data);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export const dynamic = "force-dynamic";
