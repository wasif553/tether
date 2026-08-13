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
import { getCurrentSessionForSubmission, recordHeartbeat, recordSecureClientEvent } from "@/lib/secureClientRunner";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";
import { renewTetherContentAccessLeaseIfValid } from "@/lib/secureClient/requireTetherContentAccess";

const bodySchema = z.object({
  timezone: z.string().max(100).optional(),
  screenWidth: z.number().int().positive().max(20_000).optional(),
  cameraPermissionState: z.string().max(50).optional(),
  // Tether Secure Exam Recovery and Resilient Autosave v1 (Part 5) —
  // optional, backward-compatible: a caller that omits it (any client
  // predating this feature) is completely unaffected. Never answer
  // content — see src/lib/pendingSaveQueue.ts, "the queue may store
  // only ... never send answer content through heartbeat" (Part 5's own
  // "do not send" list).
  pendingSaveCount: z.number().int().min(0).max(100_000).optional(),
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

  // Tether Secure Exam Recovery and Resilient Autosave v1 (Part 5) —
  // piggy-backs the SecureClientSession heartbeat (lastHeartbeatAt, and
  // the existing INTERRUPTED -> ACTIVE self-heal) onto this ALREADY
  // wired, already-called-every-~25s heartbeat, rather than requiring a
  // separate client-side call — this is the real fix for
  // SecureClientSession.lastHeartbeatAt previously never being updated by
  // any real exam-taking flow at all (it was only ever touched by the
  // dedicated POST .../secure-client/sessions/[id]/heartbeat route, which
  // nothing in the student exam page actually calls). AWAITED (unlike the
  // pending-save-count event below) — recording contact is this route's
  // own core new purpose, not decorative telemetry, so the response must
  // not be sent before it's actually durable; a failure here still never
  // fails the request itself (caught, not rethrown). No-ops entirely for
  // a non-Tether exam (no current session exists to touch).
  const currentSecureClientSession = await getCurrentSessionForSubmission(id);
  if (currentSecureClientSession) {
    const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
    await recordHeartbeat(currentSecureClientSession.id, {
      heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds,
      heartbeatGraceSeconds: policy.heartbeatGraceSeconds,
    }).catch(() => {});

    // Part 12 — "pending-save count where reliable". Only recorded when
    // actually nonzero, to avoid a steady stream of empty rows on the
    // (very common) common case of nothing pending — the lecturer badge
    // treats "no recent report" as zero/none.
    if (parsed.data.pendingSaveCount != null && parsed.data.pendingSaveCount > 0) {
      recordSecureClientEvent({
        secureClientSessionId: currentSecureClientSession.id,
        submissionId: id,
        examId: currentSecureClientSession.examId,
        institutionId: currentSecureClientSession.institutionId,
        eventType: "AUTOSAVE_PENDING_COUNT_REPORTED",
        clientRequestId: null,
        sequenceNumber: null,
        clientElapsedMs: null,
        metadata: { pendingSaveCount: parsed.data.pendingSaveCount },
      }).catch(() => {});
    }
  }

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

  // Rolling lease renewal — see renewTetherContentAccessLeaseIfValid's own
  // doc comment. This heartbeat is the ONE guaranteed periodic request
  // during an active attempt (fired every ~25s purely on submissionStatus
  // === "IN_PROGRESS" — see the student exam page's sendHeartbeat effect —
  // never gated on the student actually saving an answer or navigating).
  // Without renewing here too, a student who legitimately reads/thinks for
  // >30 minutes without an autosave or navigation event would still lose
  // content access mid-attempt even though this heartbeat kept native
  // lockdown/session trust alive the whole time. Self-gating and a no-op
  // for STANDARD_WEB/SEB_REQUIRED (no lease cookie ever sent) and for any
  // lease that does not independently re-validate right now — this can
  // never bootstrap a missing/expired lease, only extend one that is
  // already good.
  await renewTetherContentAccessLeaseIfValid(req, response, { submissionId: submission.id, studentId: submission.studentId });
  return response;
}

export const dynamic = "force-dynamic";
