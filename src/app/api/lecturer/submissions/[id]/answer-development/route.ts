/**
 * Answer-Development Provenance v1 — see
 * docs/answer-development-provenance-v1.md.
 *
 * GET /api/lecturer/submissions/[id]/answer-development
 *
 * Lecturer (exam owner) or platform admin, same institution. Returns the
 * per-question timeline, attempt-level summary, and derived process
 * observations (Part 8/9) — never raw IP/device values, never a
 * "guilty"/misconduct label, never automatically altering grades or
 * submission status.
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { parseAnswerProvenancePolicy, isAnswerProvenanceEnabled } from "@/lib/answerProvenancePolicy";
import { getLecturerAnswerDevelopment } from "@/lib/answerDevelopmentRunner";

function findSubmissionForPermissionCheck(submissionId: string) {
  return prisma.submission.findUnique({
    where: { id: submissionId },
    include: { exam: { select: { id: true, createdById: true, institutionId: true } } },
  });
}
type SubmissionForPermissionCheck = NonNullable<Awaited<ReturnType<typeof findSubmissionForPermissionCheck>>>;
type SubmissionPermission = { response: NextResponse } | { session: Session; submission: SubmissionForPermissionCheck };

async function requireSubmissionPermission(submissionId: string): Promise<SubmissionPermission> {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const submission = await findSubmissionForPermissionCheck(submissionId);
  if (!submission) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!isPlatformAdmin(session) && submission.exam.createdById !== session.user.id) {
    return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  try {
    assertSameInstitution(session, submission.exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return { response };
    throw err;
  }
  return { session, submission };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const permission = await requireSubmissionPermission(id);
  if ("response" in permission) return permission.response;

  const fullSubmission = await prisma.submission.findUnique({
    where: { id },
    select: { answerProvenancePolicySnapshotJson: true },
  });
  const policy = parseAnswerProvenancePolicy(fullSubmission?.answerProvenancePolicySnapshotJson);
  if (!isAnswerProvenanceEnabled(policy)) {
    return NextResponse.json({ enabled: false, mode: "OFF" });
  }

  const data = await getLecturerAnswerDevelopment(id);

  return NextResponse.json({
    enabled: true,
    mode: policy.mode,
    summary: data.summary,
    perQuestion: data.perQuestion.map((q) => ({
      questionId: q.questionId,
      observations: q.observations,
      versions: q.versions.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        changeType: v.changeType,
        source: v.source,
        // Readable checkpoint text — the same authorised answer content
        // already visible on the ordinary submission review page, just
        // preserved at this specific point in time (Part 8, "readable
        // highlighted diff").
        responseText: v.responseText,
        responseLength: v.responseLength,
        charactersAdded: v.charactersAdded,
        charactersRemoved: v.charactersRemoved,
        changeRatio: v.changeRatio,
        serverReceivedAt: v.serverReceivedAt,
      })),
      events: q.events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        eventLevel: e.eventLevel,
        serverReceivedAt: e.serverReceivedAt,
        metadata: e.metadataJson,
      })),
    })),
    artifacts: data.artifacts.map((a) => ({
      id: a.id,
      artifactType: a.artifactType,
      questionId: a.questionId,
      version: a.version,
      updatedAt: a.updatedAt,
      content: a.content,
    })),
  });
}

/**
 * GET /api/lecturer/submissions/[id]/answer-development/versions/compare?a=<id>&b=<id>
 * is intentionally NOT a separate route — version comparison (Part 8) is
 * computed client-side from the two version rows already returned above
 * (both already include responseLength/charactersAdded/removed/changeRatio;
 * the full responseText for a highlighted diff is available via the
 * versions the student/lecturer already receive elsewhere). Kept as one
 * GET to avoid a second lecturer-facing endpoint for what is otherwise
 * static, already-fetched data.
 */

export const dynamic = "force-dynamic";
