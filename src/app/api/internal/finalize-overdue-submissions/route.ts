/**
 * Auto-submit server-backstop v1 — the scheduled, no-client-required
 * safety net. See src/lib/submissionFinalization.ts for the shared
 * finalization mechanism this calls, and POST /api/exams/[id]/start for
 * the PRIMARY, immediate backstop (this endpoint exists only to catch an
 * overdue IN_PROGRESS attempt that nobody happens to read/resume soon
 * after its deadline).
 *
 * Auth: a single shared bearer secret (OVERDUE_FINALIZATION_SECRET),
 * compared in constant time. Deliberately fails CLOSED if the env var
 * itself is missing/empty — an unconfigured secret must never be treated
 * as "no auth required".
 *
 * Never logs student/exam identifiers on the ordinary/expected path —
 * only aggregate counts. A per-row failure is caught and counted, never
 * allowed to abort the rest of the batch.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings } from "@/lib/secureExam";
import { resolveSubmissionTimingPolicy, submissionDeadline, shouldServerBackstopFinalize } from "@/lib/assessmentLifecycle";
import { finalizeSubmission, runPostFinalizationEffects } from "@/lib/submissionFinalization";

/** Bounded per-invocation batch — a coarse sweep, never a bulk migration; repeated invocations (the scheduled workflow runs every 5-15 minutes) converge on the full backlog without any single call doing unbounded work. */
const BATCH_SIZE = 200;

function isAuthorized(req: Request): boolean {
  const expected = process.env.OVERDUE_FINALIZATION_SECRET;
  if (!expected) return false; // fail closed — an unconfigured secret authorizes nothing.

  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  // timingSafeEqual throws on a length mismatch rather than returning
  // false — a length check here is itself constant-time-irrelevant (an
  // attacker already learns nothing usable from response timing on a
  // shared, unguessable, sufficiently-long secret), so this is "constant
  // time where practical", not a claim of a fully length-hidden compare.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let scanned = 0;
  let eligible = 0;
  let finalized = 0;
  let alreadyFinalized = 0;
  let failed = 0;

  try {
    // Oldest startedAt first — a reasonable, simple proxy for "oldest
    // deadlines first" (the exact per-attempt deadline depends on each
    // row's own frozen timing policy, resolved below in application
    // code, not queryable as a plain column). Candidates only —
    // eligibility (deadline actually passed + autoSubmitOnTimerEnd) is
    // re-decided per row via the exact same canonical functions every
    // other caller uses, never a second deadline implementation.
    const candidates = await prisma.submission.findMany({
      where: { status: "IN_PROGRESS" },
      orderBy: { startedAt: "asc" },
      take: BATCH_SIZE,
      select: {
        id: true,
        examId: true,
        studentId: true,
        startedAt: true,
        examPolicySnapshotJson: true,
        exam: { select: { durationMins: true, secureSettings: true } },
      },
    });

    for (const candidate of candidates) {
      scanned += 1;
      try {
        const settings = parseSecureSettings(candidate.exam.secureSettings);
        const timingPolicy = resolveSubmissionTimingPolicy({
          examPolicySnapshotJson: candidate.examPolicySnapshotJson,
          currentExamDurationMins: candidate.exam.durationMins,
          currentSecureSettings: settings,
        });
        const deadline = submissionDeadline(candidate.startedAt, timingPolicy.durationMins);
        const isEligible = shouldServerBackstopFinalize({
          status: "IN_PROGRESS",
          now: new Date(),
          deadline,
          autoSubmitOnTimerEnd: timingPolicy.autoSubmitOnTimerEnd,
        });
        if (!isEligible) continue;
        eligible += 1;

        const result = await finalizeSubmission({
          submissionId: candidate.id,
          finalResponses: {},
          submissionRequestId: null,
          triggeredBy: "SERVER_BACKSTOP",
          deadline,
        });

        if (result.kind === "FINALIZED") {
          finalized += 1;
          await runPostFinalizationEffects({
            submissionId: candidate.id,
            examId: candidate.examId,
            studentId: candidate.studentId,
            hasEssay: result.hasEssay,
          });
        } else if (result.kind === "ALREADY_FINALIZED") {
          // A concurrent finalizer (a live client, or the /start
          // backstop) already handled this row — correct, idempotent,
          // not a failure.
          alreadyFinalized += 1;
        }
      } catch (err) {
        failed += 1;
        console.error("[finalize-overdue-submissions] row failed", { submissionId: candidate.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return NextResponse.json({ scanned, eligible, finalized, alreadyFinalized, failed });
  } catch (err) {
    console.error("[finalize-overdue-submissions] sweep failed", err);
    return NextResponse.json({ error: "Sweep failed", scanned, eligible, finalized, alreadyFinalized, failed }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
