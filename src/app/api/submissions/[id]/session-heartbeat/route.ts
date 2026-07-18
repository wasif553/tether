/**
 * Exam Session Binding v1 — see docs/exam-session-binding-v1.md.
 *
 * POST /api/submissions/[id]/session-heartbeat — the ONLY route that
 * creates or resumes an ExamAttemptSession (see
 * examAttemptSessionRunner.ts for why binding happens here rather than
 * at attempt start). Student-only, own IN_PROGRESS submission only.
 * Recommended client cadence: every 20–30 seconds while the exam page is
 * active. Response contains ONLY safe operational status — never a raw
 * IP, IP-prefix value, raw user-agent, device-token hash, browser-
 * session-token hash, fingerprint hash, or any other hash.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { recordExamAttemptHeartbeat } from "@/lib/examAttemptSessionRunner";
import { recordSimpleActivityEvent } from "@/lib/answerActivityTelemetry";
import {
  BROWSER_SESSION_COOKIE_NAME,
  DEVICE_TOKEN_COOKIE_NAME,
  browserSessionCookieOptions,
  deviceTokenCookieOptions,
} from "@/lib/sessionBinding";

const bodySchema = z.object({
  timezone: z.string().max(100).optional(),
  screenWidth: z.number().int().positive().max(20_000).optional(),
  cameraPermissionState: z.string().max(50).optional(),
});

/** Heartbeat rows are simple markers — rate-limited so a fast client retry loop can't flood the table. */
const HEARTBEAT_DEDUPE_WINDOW_MS = 15_000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.submission.findUnique({ where: { id } });
  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (submission.status !== "IN_PROGRESS") {
    return NextResponse.json({ error: "This attempt is no longer in progress." }, { status: 409 });
  }

  const rawBody = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await recordExamAttemptHeartbeat(req, id, session.user.id, {
    timezone: parsed.data.timezone ?? null,
    screenWidth: parsed.data.screenWidth ?? null,
    cameraPermissionState: parsed.data.cameraPermissionState ?? null,
  });

  recordSimpleActivityEvent({
    submissionId: id,
    examAttemptSessionId: result.sessionId,
    eventType: "HEARTBEAT",
    dedupeWindowMs: HEARTBEAT_DEDUPE_WINDOW_MS,
  }).catch(() => {});

  const response = NextResponse.json({
    sessionStatus: "ACTIVE",
    cameraPermissionState: result.cameraPermissionState,
    concurrentSessionDetected: result.concurrentSessionDetected,
  });

  if (result.browserSessionIsNew) {
    response.cookies.set(BROWSER_SESSION_COOKIE_NAME, result.browserSessionToken, browserSessionCookieOptions());
  }
  if (result.deviceTokenIsNew) {
    response.cookies.set(DEVICE_TOKEN_COOKIE_NAME, result.deviceToken, deviceTokenCookieOptions());
  }

  return response;
}

export const dynamic = "force-dynamic";
