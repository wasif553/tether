import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await prisma.exam.findFirst({ where: { id, createdById: session.user.id } });
  if (!exam) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const submissions = await prisma.submission.findMany({
    where: { examId: id },
    include: {
      student: { select: { id: true, name: true, email: true } },
      gradePassback: { select: { status: true } },
    },
    orderBy: { startedAt: "desc" },
  });

  return NextResponse.json(
    submissions.map((s) => ({
      ...s,
      canvasStatus: s.gradePassback?.status ?? null,
      gradePassback: undefined,
    })),
  );
}

export const dynamic = "force-dynamic";
