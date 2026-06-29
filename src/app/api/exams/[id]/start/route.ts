import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam || !exam.published) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const now = new Date();
  if (exam.startsAt && now < exam.startsAt) {
    return NextResponse.json({ error: "Exam has not started yet" }, { status: 403 });
  }
  if (exam.endsAt && now > exam.endsAt) {
    return NextResponse.json({ error: "Exam window has closed" }, { status: 403 });
  }

  const existing = await prisma.submission.findUnique({
    where: { examId_studentId: { examId: id, studentId: session.user.id } },
  });
  if (existing) return NextResponse.json(existing);

  // Student Onboarding and Exam Access v1 — see
  // docs/student-onboarding-and-exam-access.md. Checked after the
  // existing-submission idempotency check above, so resuming an
  // already-started exam never re-prompts for the code, but no new
  // submission is ever created without a valid one.
  if (exam.accessCodeRequired) {
    const body = await req.json().catch(() => ({}));
    const accessCode = typeof body?.accessCode === "string" ? body.accessCode : "";
    const valid =
      accessCode.length > 0 &&
      exam.accessCodeHash != null &&
      (await bcrypt.compare(accessCode, exam.accessCodeHash));
    if (!valid) {
      return NextResponse.json(
        { error: "Valid access code required to start this exam." },
        { status: 403 },
      );
    }
  }

  // Two near-simultaneous "start exam" requests from the same student (e.g.
  // a double-click, or a flaky network retry) can both pass the check above
  // before either has created a row. The @@unique([examId, studentId])
  // constraint then rejects the loser — recover by returning the winner's
  // submission instead of a 500, so starting is idempotent under races.
  try {
    const submission = await prisma.submission.create({
      data: { examId: id, studentId: session.user.id },
    });
    return NextResponse.json(submission, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.submission.findUnique({
        where: { examId_studentId: { examId: id, studentId: session.user.id } },
      });
      if (winner) return NextResponse.json(winner);
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
