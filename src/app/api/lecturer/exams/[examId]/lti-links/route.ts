import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const createLinkSchema = z.object({
  platformId: z.string().min(1),
  resourceLinkId: z.string().min(1),
  canvasCourseId: z.string().optional(),
  canvasAssignmentId: z.string().optional(),
  label: z.string().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;
  const exam = await prisma.exam.findFirst({
    where: { id: examId, createdById: session.user.id },
  });
  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const links = await prisma.ltiExamLink.findMany({
    where: { examId },
    include: { platform: { select: { issuer: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(links);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ examId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId } = await params;
  const exam = await prisma.exam.findFirst({
    where: { id: examId, createdById: session.user.id },
  });
  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = createLinkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const platform = await prisma.ltiPlatform.findUnique({
    where: { id: parsed.data.platformId },
  });
  if (!platform) {
    return NextResponse.json({ error: "Unknown Canvas platform" }, { status: 400 });
  }

  const existing = await prisma.ltiExamLink.findUnique({
    where: {
      platformId_resourceLinkId: {
        platformId: parsed.data.platformId,
        resourceLinkId: parsed.data.resourceLinkId,
      },
    },
  });
  if (existing) {
    return NextResponse.json(
      { error: "This Canvas resource link is already linked to an exam" },
      { status: 409 },
    );
  }

  const link = await prisma.ltiExamLink.create({
    data: { ...parsed.data, examId },
  });

  return NextResponse.json(link, { status: 201 });
}

export const dynamic = "force-dynamic";
