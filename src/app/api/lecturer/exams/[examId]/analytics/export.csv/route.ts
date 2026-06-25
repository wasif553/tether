import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { calculateExamAnalytics, ExamNotFoundError } from "@/lib/analytics";

function csvEscape(value: string | number | null): string {
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(values: Array<string | number | null>): string {
  return values.map(csvEscape).join(",");
}

export async function GET(
  _req: Request,
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
  if (exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let analytics;
  try {
    analytics = await calculateExamAnalytics(examId);
  } catch (err) {
    if (err instanceof ExamNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("Failed to calculate exam analytics for export", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  const lines: string[] = [];

  lines.push("Student Results");
  lines.push(
    toCsvRow(["Student", "Email", "Status", "Total Score", "Max Score", "Score %", "Submitted At", "Graded At"]),
  );
  for (const s of analytics.studentResults) {
    lines.push(
      toCsvRow([
        s.studentName,
        s.studentEmail,
        s.status,
        s.totalScore,
        s.maxScore,
        s.scorePct != null ? Math.round(s.scorePct) : null,
        s.submittedAt,
        s.gradedAt,
      ]),
    );
  }

  lines.push("");
  lines.push("Question Analytics");
  lines.push(
    toCsvRow([
      "Question",
      "Type",
      "Max Score",
      "Attempts",
      "Correct Rate %",
      "Average Score %",
      "Average Time (s)",
      "Review Recommended",
      "Review Reason",
    ]),
  );
  for (const q of analytics.questionAnalytics) {
    lines.push(
      toCsvRow([
        q.questionText,
        q.questionType,
        q.maxScore,
        q.attempts,
        q.correctRatePct != null ? Math.round(q.correctRatePct) : null,
        q.averageScorePct != null ? Math.round(q.averageScorePct) : null,
        q.averageTimeSpentSeconds != null ? Math.round(q.averageTimeSpentSeconds) : null,
        q.reviewRecommended ? "Yes" : "No",
        q.reviewReason,
      ]),
    );
  }

  lines.push("");
  lines.push("Integrity Summary");
  lines.push(toCsvRow(["Total Events", "High Severity", "Medium Severity", "Low Severity", "Unresolved", "Students With Events"]));
  lines.push(
    toCsvRow([
      analytics.integritySummary.totalEvents,
      analytics.integritySummary.highSeverityEvents,
      analytics.integritySummary.mediumSeverityEvents,
      analytics.integritySummary.lowSeverityEvents,
      analytics.integritySummary.unresolvedEvents,
      analytics.integritySummary.studentsWithEvents,
    ]),
  );

  const csv = lines.join("\n");
  const filename = `exam-${examId}-analytics.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export const dynamic = "force-dynamic";
