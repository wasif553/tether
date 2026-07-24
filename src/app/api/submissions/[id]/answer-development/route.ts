/**
 * Answer-Development Provenance v1 — see
 * docs/answer-development-provenance-v1.md.
 *
 * GET /api/submissions/[id]/answer-development
 *
 * Authenticated-student-owned route: returns the student's OWN
 * checkpoints/events/artifacts for self-review. Never returns derived
 * lecturer-only observations (those live only in the lecturer route) and
 * never another student's data. Available after submission too (not
 * gated on IN_PROGRESS) so a student can review their own development
 * history — but only when the immutable policy both enables provenance
 * and allows student review.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseAnswerProvenancePolicy, isAnswerProvenanceEnabled } from "@/lib/answerProvenancePolicy";
import { toStudentSafeVersionSummary } from "@/lib/answerDevelopment";
import { getStudentAnswerDevelopment } from "@/lib/answerDevelopmentRunner";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const submission = await prisma.submission.findUnique({
    where: { id },
    select: { studentId: true, answerProvenancePolicySnapshotJson: true },
  });
  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const policy = parseAnswerProvenancePolicy(submission.answerProvenancePolicySnapshotJson);
  if (!isAnswerProvenanceEnabled(policy)) {
    return NextResponse.json({ error: "Answer-development provenance is not enabled for this exam" }, { status: 403 });
  }
  if (!policy.allowStudentDevelopmentReview) {
    return NextResponse.json({ error: "Student review of development history is not enabled for this exam" }, { status: 403 });
  }

  const { versions, events, artifacts } = await getStudentAnswerDevelopment(id);

  return NextResponse.json({
    mode: policy.mode,
    versions: versions.map(toStudentSafeVersionSummary),
    events: events.map((e) => ({ id: e.id, eventType: e.eventType, questionId: e.questionId, serverReceivedAt: e.serverReceivedAt })),
    artifacts: artifacts.map((a) => ({
      id: a.id,
      artifactType: a.artifactType,
      questionId: a.questionId,
      content: a.content,
      version: a.version,
      updatedAt: a.updatedAt,
    })),
  });
}

export const dynamic = "force-dynamic";
