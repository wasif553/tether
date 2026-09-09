/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * GET /api/submissions/[id]/secure-client/status
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureClientPolicy, describeDisplayRequirement } from "@/lib/secureClientPolicy";
import { createTimingCollector, timeSpan, attachServerTimingHeader, logBoundedNavigationTiming } from "@/lib/serverTiming";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestStartedAtMs = performance.now();
  const timing = createTimingCollector();
  const authStartMs = performance.now();
  const session = await auth();
  timing.record("authMs", performance.now() - authStartMs);
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const submission = await timeSpan(timing, "submissionLookupMs", () =>
    prisma.submission.findUnique({
      where: { id },
      select: { studentId: true, secureClientPolicySnapshotJson: true, activatedAt: true, examId: true },
    }),
  );
  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const policy = parseSecureClientPolicy(submission.secureClientPolicySnapshotJson);
  const current = await timeSpan(timing, "sessionLookupMs", () =>
    prisma.secureClientSession.findFirst({
      where: { submissionId: id, status: { in: ["CREATED", "PREFLIGHT", "ACTIVE", "INTERRUPTED", "RECOVERY_REQUIRED"] } },
      orderBy: { createdAt: "desc" },
    }),
  );

  const response = NextResponse.json({
    // v1.7.5 P0 follow-up — the exam CONTENT page needs to build the
    // tether-launch redirect URL (/student/exams/[examId]/tether-launch)
    // BEFORE it is ever safe to fetch GET /api/submissions/[id] (which
    // returns full question text/options once the submission is
    // server-activated) — this is the one thing this narrow, no-content
    // endpoint was missing to make that possible. A bare opaque id, no
    // more sensitive than the submissionId already in the URL.
    examId: submission.examId,
    deliveryMode: policy.deliveryMode,
    studentPreflightRequired: policy.studentPreflightRequired,
    // Corrective pass v1.2.1, Task A — bounded, non-secret policy fields
    // the local diagnostic panel needs verbatim (never a token/cookie/
    // manifest/PII, just the same enum/boolean/number already visible via
    // displayRequirement below in a different shape).
    requireDisplayCheck: policy.requireDisplayCheck,
    maximumDisplays: policy.maximumDisplays,
    displayRequirement: describeDisplayRequirement(policy),
    // v1.7.4 pre-exam readiness — the Phase 2 native-activation handshake
    // (tether-launch/page.tsx's ensureSecureActivation) needs this
    // FROZEN per-attempt value to know whether to ask
    // activateSecureExamLockdown() to run a fresh remote-session check.
    requireRemoteSessionCheck: policy.requireRemoteSessionCheck,
    // PR #22 release-blocking review — the narrow, read-only reconciliation
    // signal tether-launch/page.tsx's ensureSecureActivation uses when
    // POST /api/submissions/[id]/activate's own response is ambiguous
    // (network exception, timeout, or an unrecognized status) — a plain
    // boolean derived from activatedAt, never the raw timestamp or any
    // question content. See src/lib/tetherLaunch.ts's
    // classifyReconciliationCheck.
    activated: submission.activatedAt !== null,
    session: current
      ? {
          id: current.id,
          status: current.status,
          verificationStatus: current.verificationStatus,
          clientType: current.clientType,
          lastHeartbeatAt: current.lastHeartbeatAt,
        }
      : null,
  });
  timing.record("totalMs", performance.now() - requestStartedAtMs);
  attachServerTimingHeader(response, timing, process.env.TETHER_TIMING_HEADERS_ENABLED);
  logBoundedNavigationTiming("secure-client-status", timing, process.env.TETHER_TIMING_HEADERS_ENABLED);
  return response;
}

export const dynamic = "force-dynamic";
