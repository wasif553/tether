/**
 * Standalone Exam Link v1 — see docs/standalone-exam-link-v1.md.
 *
 * POST   /api/exams/[id]/standalone-invite — generate/regenerate the
 *   invitation link. Atomically switches the exam to assignmentMode
 *   STANDALONE, clears courseId, generates a new high-entropy token,
 *   stores only its hash, and enables future claims. The plaintext
 *   token is returned in this response ONLY — never stored, never
 *   logged, never retrievable again after this request.
 * DELETE /api/exams/[id]/standalone-invite — disable: stops the current
 *   token from granting NEW entitlements. Never touches any
 *   ExamAssignment a student already holds, and never deletes the
 *   stored hash (a subsequent POST simply overwrites it).
 *
 * Lecturer (owner of the exam) only.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";
import {
  generateStandaloneInviteToken,
  hashStandaloneInviteToken,
  buildStandaloneInviteUrl,
} from "@/lib/standaloneInvite";

async function getOwnedExam(examId: string, lecturerId: string, session: Parameters<typeof institutionWhere>[0]) {
  return prisma.exam.findFirst({
    where: { id: examId, createdById: lecturerId, ...institutionWhere(session) },
  });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const exam = await getOwnedExam(id, session.user.id, session);
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const token = generateStandaloneInviteToken();
    const tokenHash = hashStandaloneInviteToken(token);

    // Be conservative (Section 3): this only ever sets assignmentMode/
    // courseId/the invite fields. It never touches ExamAssignment rows —
    // students already assigned via COURSE/SELECTED_STUDENTS keep their
    // assignment rows untouched even as the exam's audience mode
    // changes; they simply stop being reachable through the OLD mode's
    // access path once assignmentMode is STANDALONE, exactly like
    // switching from SELECTED_STUDENTS to COURSE already leaves stale
    // ExamAssignment rows in place today (no existing cleanup semantics
    // to preserve or replicate).
    await prisma.exam.update({
      where: { id },
      data: {
        assignmentMode: "STANDALONE",
        courseId: null,
        standaloneInviteTokenHash: tokenHash,
        standaloneInviteEnabled: true,
      },
    });

    return NextResponse.json({
      inviteUrl: buildStandaloneInviteUrl(id, token),
      enabled: true,
    });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const exam = await getOwnedExam(id, session.user.id, session);
    if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Disable only — never clears the stored hash (a later POST simply
    // overwrites it) and never touches any existing ExamAssignment.
    // Already-accepted students keep their entitlement and any
    // Submission they've started or completed.
    await prisma.exam.update({
      where: { id },
      data: { standaloneInviteEnabled: false },
    });

    return NextResponse.json({ enabled: false });
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
