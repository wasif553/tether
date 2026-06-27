import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { labelForEventType } from "@/lib/integrityEventLabels";

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

  const events = await prisma.integrityEvent.findMany({
    where: { examId },
    include: { student: { select: { name: true, email: true } } },
    orderBy: { occurredAt: "desc" },
  });

  const lines: string[] = [];
  lines.push(
    toCsvRow([
      "Occurred At",
      "Student Name",
      "Student Email",
      "Event Type",
      "Severity",
      "Message",
      "Resolved At",
      "Resolution Note",
    ]),
  );

  for (const e of events) {
    lines.push(
      toCsvRow([
        e.occurredAt.toISOString(),
        e.student.name,
        e.student.email,
        labelForEventType(e.eventType),
        e.severity,
        e.message,
        e.resolvedAt?.toISOString() ?? null,
        e.resolutionNote,
      ]),
    );
  }

  const csv = lines.join("\n");
  const filename = `exam-${examId}-integrity-events.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export const dynamic = "force-dynamic";
