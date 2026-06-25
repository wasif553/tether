import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

const INTEGRITY_EVENT_TYPES = [
  "FULLSCREEN_EXIT",
  "WINDOW_BLUR",
  "WINDOW_FOCUS_RETURN",
  "COPY_ATTEMPT",
  "PASTE_ATTEMPT",
  "RIGHT_CLICK_ATTEMPT",
  "DEVTOOLS_SUSPECTED",
  "NETWORK_OFFLINE",
  "NETWORK_ONLINE",
  "AUTOSAVE_FAILED",
  "TIMER_EXPIRED",
  "SUBMIT_AFTER_DEADLINE",
  "MANUAL_WARNING",
] as const;

const INTEGRITY_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH"] as const;

const createEventSchema = z.object({
  eventType: z.enum(INTEGRITY_EVENT_TYPES),
  severity: z.enum(INTEGRITY_SEVERITIES),
  message: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  occurredAt: z.string().datetime().optional(),
});

const DEBOUNCE_WINDOWS_MS: Partial<Record<(typeof INTEGRITY_EVENT_TYPES)[number], number>> = {
  WINDOW_BLUR: 10_000,
  COPY_ATTEMPT: 5_000,
  PASTE_ATTEMPT: 5_000,
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({ where: { id } });

  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.status === "GRADED") {
    return NextResponse.json(
      { error: "This submission is no longer active" },
      { status: 409 },
    );
  }

  const body = await req.json();
  const parsed = createEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { eventType, severity, message, metadata, occurredAt } = parsed.data;

  const debounceWindowMs = DEBOUNCE_WINDOWS_MS[eventType];
  if (debounceWindowMs) {
    const recent = await prisma.integrityEvent.findFirst({
      where: { submissionId: id, eventType },
      orderBy: { occurredAt: "desc" },
    });

    if (recent && Date.now() - recent.occurredAt.getTime() < debounceWindowMs) {
      return NextResponse.json(recent, { status: 200 });
    }
  }

  const event = await prisma.integrityEvent.create({
    data: {
      submissionId: id,
      examId: submission.examId,
      studentId: submission.studentId,
      eventType,
      severity,
      message,
      metadataJson: (metadata as Prisma.InputJsonValue) ?? undefined,
      occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
    },
  });

  return NextResponse.json(event, { status: 201 });
}

export const dynamic = "force-dynamic";
