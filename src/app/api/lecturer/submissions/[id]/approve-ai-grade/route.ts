import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pushGradeToCanvas } from "@/lib/lti/gradePassback";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";

const approveSchema = z.object({
  finalScore: z.number().min(0),
  comment: z.string().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: { include: { questions: true } }, answers: true, student: true },
  });

  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!isPlatformAdmin(session) && submission.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, submission.exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = await req.json();
  const parsed = approveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const maxScore = submission.exam.questions.reduce((sum, q) => sum + q.points, 0);
  if (parsed.data.finalScore > maxScore) {
    return NextResponse.json(
      { error: `finalScore cannot exceed the exam's total possible score (${maxScore})` },
      { status: 400 },
    );
  }

  const aiDraftTotal = submission.answers.reduce((sum, a) => sum + (a.aiDraftScore ?? 0), 0);

  const updated = await prisma.submission.update({
    where: { id },
    data: {
      totalScore: Math.round(parsed.data.finalScore),
      status: "GRADED",
      gradedAt: new Date(),
    },
  });

  console.log(
    `Submission ${id} graded by lecturer ${session.user.id} (${session.user.email}). ` +
      `AI draft total: ${aiDraftTotal}, final human score: ${parsed.data.finalScore}.` +
      (parsed.data.comment ? ` Comment: ${parsed.data.comment}` : ""),
  );

  const launch = submission.student.canvasUserId
    ? await prisma.ltiLaunch.findFirst({
        where: {
          OR: [
            { submissionId: id },
            { submissionId: null, canvasUserId: submission.student.canvasUserId },
          ],
        },
      })
    : null;
  if (launch) {
    console.log(`Grade passback pending for submission ${id} (LtiLaunch ${launch.id})`);
    pushGradeToCanvas(id).catch(console.error);
  }

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
