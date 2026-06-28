import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isPlatformAdmin, assertSameInstitution, institutionErrorResponse } from "@/lib/institutionScope";

const resolveSchema = z.object({
  resolutionNote: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "LECTURER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { eventId } = await params;
  const event = await prisma.integrityEvent.findUnique({
    where: { id: eventId },
    include: { exam: true },
  });

  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPlatformAdmin(session) && event.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    assertSameInstitution(session, event.exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const body = await req.json();
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = await prisma.integrityEvent.update({
    where: { id: eventId },
    data: {
      resolvedAt: new Date(),
      resolvedById: session.user.id,
      resolutionNote: parsed.data.resolutionNote,
    },
  });

  return NextResponse.json(updated);
}

export const dynamic = "force-dynamic";
