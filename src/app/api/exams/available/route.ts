import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { institutionWhere, institutionErrorResponse } from "@/lib/institutionScope";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const exams = await prisma.exam.findMany({
      where: { published: true, ...institutionWhere(session) },
      orderBy: { createdAt: "desc" },
      include: {
        submissions: { where: { studentId: session.user.id } },
        _count: { select: { questions: true } },
      },
    });

    const result = exams.map((exam) => ({
      id: exam.id,
      title: exam.title,
      description: exam.description,
      durationMins: exam.durationMins,
      startsAt: exam.startsAt,
      endsAt: exam.endsAt,
      questionCount: exam._count.questions,
      submission: exam.submissions[0]
        ? { id: exam.submissions[0].id, status: exam.submissions[0].status }
        : null,
    }));

    return NextResponse.json(result);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export const dynamic = "force-dynamic";
