/**
 * Exam Session Binding v1 — see docs/exam-session-binding-v1.md.
 *
 * GET /api/lecturer/submissions/[id]/session-review — reads the
 * submission's ExamAttemptSession rows and SessionIntegritySignal rows.
 * Lecturer (exam owner) or platform admin, same institution. Students
 * always receive 401/403. Never returns raw IP, IP-prefix value, raw
 * user-agent, device-token hash, browser-session-token hash, or
 * fingerprint hash — only safe, coarse, already-classified fields.
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Submission } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { SESSION_REVIEW_STATUS_LABELS, SESSION_SIGNAL_HEADLINES, type SessionReviewStatus, type SessionSignalType } from "@/lib/sessionIntegrity";

function findSubmissionForPermissionCheck(submissionId: string) {
  return prisma.submission.findUnique({
    where: { id: submissionId },
    include: { exam: { select: { id: true, createdById: true, institutionId: true } } },
  });
}
type SubmissionWithExam = Submission & { exam: { id: string; createdById: string; institutionId: string | null } };
type SubmissionPermission = { response: NextResponse } | { session: Session; submission: SubmissionWithExam };

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

  const [sessions, signals] = await Promise.all([
    prisma.examAttemptSession.findMany({
      where: { submissionId: id },
      orderBy: { firstSeenAt: "asc" },
      select: {
        id: true,
        browserFamily: true,
        operatingSystemFamily: true,
        deviceCategory: true,
        ipVersion: true,
        cameraPermissionState: true,
        startedAt: true,
        firstSeenAt: true,
        lastSeenAt: true,
        endedAt: true,
        status: true,
        // Deliberately NOT selected: browserSessionTokenHash,
        // deviceTokenHash, coarseFingerprintHash, userAgentHash,
        // ipPrefixHash — never returned to any client.
      },
    }),
    prisma.sessionIntegritySignal.findMany({
      where: { submissionId: id },
      orderBy: { createdAt: "asc" },
      include: { reviewedBy: { select: { name: true } } },
    }),
  ]);

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      browserFamily: s.browserFamily,
      operatingSystemFamily: s.operatingSystemFamily,
      deviceCategory: s.deviceCategory,
      ipVersion: s.ipVersion,
      cameraPermissionState: s.cameraPermissionState,
      startedAt: s.startedAt,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
      endedAt: s.endedAt,
      status: s.status,
    })),
    signals: signals.map((s) => ({
      id: s.id,
      signalType: s.signalType,
      headline: SESSION_SIGNAL_HEADLINES[s.signalType as SessionSignalType] ?? "Session review recommended",
      signalLevel: s.signalLevel,
      explanation: s.explanation,
      evidence: s.evidenceJson,
      reviewStatus: s.reviewStatus,
      reviewStatusLabel: SESSION_REVIEW_STATUS_LABELS[s.reviewStatus as SessionReviewStatus] ?? s.reviewStatus,
      reviewedAt: s.reviewedAt,
      reviewedByName: s.reviewedBy?.name ?? null,
      reviewNote: s.reviewNote,
    })),
  });
}

export const dynamic = "force-dynamic";
