import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ examId: string; linkId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { examId, linkId } = await params;
  const exam = await prisma.exam.findFirst({
    where: { id: examId, createdById: session.user.id },
  });
  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const link = await prisma.ltiExamLink.findFirst({ where: { id: linkId, examId } });
  if (!link) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.ltiExamLink.delete({ where: { id: linkId } });

  return new NextResponse(null, { status: 204 });
}

export const dynamic = "force-dynamic";
