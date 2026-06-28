import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { computeRiskScore, riskLevelForScore, type Severity } from "@/lib/integrityRisk";
import { labelForEventType } from "@/lib/integrityEventLabels";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";

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
  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });
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

  const events = await prisma.integrityEvent.findMany({
    where: { examId },
    include: {
      student: { select: { id: true, name: true, email: true } },
      submission: { select: { id: true, status: true } },
      resolvedBy: { select: { id: true, name: true } },
    },
    orderBy: { occurredAt: "desc" },
  });

  const eventsByStudent = new Map<
    string,
    {
      studentId: string;
      studentName: string;
      studentEmail: string;
      submissionId: string;
      submissionStatus: string;
      eventCount: number;
      severityCounts: Record<string, number>;
      events: Array<{ severity: Severity; resolvedAt: Date | null }>;
    }
  >();

  for (const event of events) {
    const existing = eventsByStudent.get(event.studentId);
    if (existing) {
      existing.eventCount += 1;
      existing.severityCounts[event.severity] = (existing.severityCounts[event.severity] ?? 0) + 1;
      existing.events.push({ severity: event.severity, resolvedAt: event.resolvedAt });
    } else {
      eventsByStudent.set(event.studentId, {
        studentId: event.studentId,
        studentName: event.student.name,
        studentEmail: event.student.email,
        submissionId: event.submission.id,
        submissionStatus: event.submission.status,
        eventCount: 1,
        severityCounts: { [event.severity]: 1 },
        events: [{ severity: event.severity, resolvedAt: event.resolvedAt }],
      });
    }
  }

  const severityCounts: Record<string, number> = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0 };
  for (const event of events) {
    severityCounts[event.severity] = (severityCounts[event.severity] ?? 0) + 1;
  }

  const unresolvedHighSeverityCount = events.filter(
    (e) => e.severity === "HIGH" && !e.resolvedAt,
  ).length;

  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      submissionId: e.submissionId,
      eventType: e.eventType,
      eventLabel: labelForEventType(e.eventType),
      severity: e.severity,
      message: e.message,
      occurredAt: e.occurredAt.toISOString(),
      resolvedAt: e.resolvedAt?.toISOString() ?? null,
      resolvedByName: e.resolvedBy?.name ?? null,
      resolutionNote: e.resolutionNote,
      student: { id: e.student.id, name: e.student.name, email: e.student.email },
      submissionStatus: e.submission.status,
    })),
    studentGroups: Array.from(eventsByStudent.values())
      .map((group) => {
        const riskScore = computeRiskScore(group.events);
        const unresolvedHighCount = group.events.filter(
          (e) => e.severity === "HIGH" && !e.resolvedAt,
        ).length;
        return {
          studentId: group.studentId,
          studentName: group.studentName,
          studentEmail: group.studentEmail,
          submissionId: group.submissionId,
          submissionStatus: group.submissionStatus,
          eventCount: group.eventCount,
          severityCounts: group.severityCounts,
          riskScore,
          riskLevel: riskLevelForScore(riskScore),
          unresolvedHighCount,
          reviewRecommended: unresolvedHighCount > 0 || riskScore >= 5,
        };
      })
      .sort((a, b) => b.riskScore - a.riskScore),
    severityCounts,
    unresolvedHighSeverityCount,
  });
}

export const dynamic = "force-dynamic";
