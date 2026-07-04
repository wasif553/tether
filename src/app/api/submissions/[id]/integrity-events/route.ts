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
  // Camera Monitoring v1
  "CAMERA_PERMISSION_GRANTED",
  "CAMERA_PERMISSION_DENIED",
  "CAMERA_STARTED",
  "CAMERA_STOPPED",
  "CAMERA_UNAVAILABLE",
  "CAMERA_HEARTBEAT_MISSED",
  "CAMERA_PRECHECK_FAILED",
  // Browser-Level Friction v1
  "KEYBOARD_SHORTCUT_BLOCKED",
  "FULLSCREEN_FORCED_RETURN",
  // Optional Student Verification + On-Device AI Camera Integrity
  // Detection v1 — see docs/on-device-ai-integrity-detection-v1.md.
  "STUDENT_VERIFICATION_CONFIRMED",
  "POSSIBLE_PHONE_VISIBLE",
  "POSSIBLE_SECOND_PERSON_VISIBLE",
  "NO_PERSON_VISIBLE",
  "CAMERA_VIEW_BLOCKED",
  "CAMERA_TOO_DARK",
  "AI_CAMERA_CHECK_UNAVAILABLE",
] as const;

const INTEGRITY_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH"] as const;

// Metadata is for AI-detection confidence/source details only — never
// image, frame, or video data. Reject any key that even suggests media
// content, and any string value that looks like a data: URL or long
// base64 blob, so this is enforced structurally, not just by convention.
const FORBIDDEN_METADATA_KEY_PATTERN = /image|frame|screenshot|thumbnail|snapshot|base64|blob|dataurl/i;
const DATA_URL_PATTERN = /^data:/i;

function metadataContainsMediaData(metadata: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEY_PATTERN.test(key)) return true;
    if (typeof value === "string") {
      if (DATA_URL_PATTERN.test(value)) return true;
      // A long, high-entropy-looking base64 string is a strong signal
      // of accidentally-attached image data even under an innocuous key.
      if (value.length > 2000 && /^[A-Za-z0-9+/=]+$/.test(value)) return true;
    }
  }
  return false;
}

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
  KEYBOARD_SHORTCUT_BLOCKED: 5_000,
  CAMERA_HEARTBEAT_MISSED: 30_000,
  // AI camera checks run every 5-10s client-side; server-side cooldowns
  // are a second, independent layer against event flooding (see
  // docs/on-device-ai-integrity-detection-v1.md, "Timing and cooldown").
  POSSIBLE_PHONE_VISIBLE: 45_000,
  POSSIBLE_SECOND_PERSON_VISIBLE: 45_000,
  NO_PERSON_VISIBLE: 45_000,
  CAMERA_VIEW_BLOCKED: 60_000,
  CAMERA_TOO_DARK: 60_000,
  AI_CAMERA_CHECK_UNAVAILABLE: 60_000,
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

  if (metadata && metadataContainsMediaData(metadata)) {
    return NextResponse.json(
      { error: "Event metadata must not contain image, frame, or media data" },
      { status: 400 },
    );
  }

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
