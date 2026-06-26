import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const linkSchema = z.object({
  examId: z.string().min(1),
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
  const launch = await prisma.ltiLaunch.findUnique({ where: { id } });
  if (!launch || !launch.resourceLinkId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const exam = await prisma.exam.findFirst({
    where: { id: parsed.data.examId, createdById: session.user.id },
  });
  if (!exam) {
    return NextResponse.json({ error: "Exam not found" }, { status: 404 });
  }

  const existingLink = await prisma.ltiExamLink.findUnique({
    where: {
      platformId_resourceLinkId: {
        platformId: launch.platformId,
        resourceLinkId: launch.resourceLinkId,
      },
    },
  });

  let link;
  if (existingLink) {
    if (existingLink.examId !== exam.id) {
      return NextResponse.json(
        { error: "This Canvas resource is already linked to a different exam" },
        { status: 409 },
      );
    }
    link = existingLink;
  } else {
    link = await prisma.ltiExamLink.create({
      data: {
        examId: exam.id,
        platformId: launch.platformId,
        resourceLinkId: launch.resourceLinkId,
        canvasCourseId: launch.canvasCourseId || undefined,
        canvasAssignmentId: launch.canvasAssignmentId || undefined,
      },
    });
  }

  // Backfill every previously-unmatched launch for this resource link so the
  // unmatched-launches inbox and pilot readiness counts update immediately.
  await prisma.ltiLaunch.updateMany({
    where: {
      platformId: launch.platformId,
      resourceLinkId: launch.resourceLinkId,
      examId: null,
    },
    data: { examId: exam.id },
  });

  return NextResponse.json({ linkId: link.id, examId: link.examId });
}

export const dynamic = "force-dynamic";
