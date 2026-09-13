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
 *
 * Pre-deployment audit finding: a single fixed
 * `findMany({ orderBy: startedAt asc, take: N })` re-fetches the EXACT
 * SAME oldest-N window on every invocation. If those N rows are all
 * ineligible (autoSubmitOnTimerEnd=false, or still within their own
 * deadline) and the (N+1)th row IS eligible, that row would never be
 * reached by any future sweep — a real starvation bug, not merely a
 * scale edge case. Fixed with bounded KEYSET pagination: this handler
 * pages forward through IN_PROGRESS rows ordered by (startedAt, id) —
 * `id` as a stable tie-break — continuing past an ineligible page into
 * the next one, within ONE invocation, until either the true end of the
 * IN_PROGRESS set is reached or a hard SCAN_ROW_CEILING/TIME_BUDGET_MS
 * is hit. This is bounded work (never an unbounded full-table scan) that
 * still guarantees every IN_PROGRESS row is eventually examined, not
 * just a static prefix — at this project's actual and realistically
 * foreseeable scale (a small pilot deployment), SCAN_ROW_CEILING
 * comfortably covers the entire IN_PROGRESS backlog in a single
 * invocation. If the total live IN_PROGRESS backlog ever exceeds
 * SCAN_ROW_CEILING, this invocation alone no longer guarantees reaching
 * every row (no cursor is persisted across invocations) — a genuinely
 * unbounded-scale guarantee would need a persisted cross-invocation
 * cursor (a new, small piece of durable state), which was deliberately
 * NOT added here to avoid an unreviewed schema change; flagged instead
 * as a known, documented scale limit.
 *
 * Precedence fix (pre-release audit follow-up, the confirmed "Browser"
 * incident) — a technically-invalid attempt (current exam now
 * TETHER_CLIENT_REQUIRED, but this attempt's own frozen policy cannot
 * satisfy that requirement — see isSecurePolicyMismatchForResume in
 * secureClientPolicy.ts) must NEVER be auto-finalized here, however
 * overdue it is. That class of row belongs to the lecturer VOIDED
 * recovery workflow, not the deadline backstop. See
 * evaluateServerBackstopEligibility in submissionFinalization.ts, the
 * ONE shared decision this route and POST /api/exams/[id]/start's
 * existing-attempt resume both consult — never duplicated independently.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { parseSecureSettings } from "@/lib/secureExam";
import { resolveSubmissionTimingPolicy, submissionDeadline } from "@/lib/assessmentLifecycle";
import { finalizeSubmission, runPostFinalizationEffects, evaluateServerBackstopEligibility } from "@/lib/submissionFinalization";
import { parseSecureClientPolicy } from "@/lib/secureClientPolicy";

const PAGE_SIZE = 200;
/** Hard ceiling on rows EXAMINED per invocation — bounds work regardless of how large the ineligible prefix is. Comfortably covers this project's entire current/near-term IN_PROGRESS backlog in one call. */
const SCAN_ROW_CEILING = 2000;
/** Hard ceiling on rows actually FINALIZED per invocation — a coarse sweep, never a bulk migration. */
const FINALIZE_CEILING = 200;
/** Wall-clock safety valve, comfortably under this route's own maxDuration below, so a slow run returns its partial counts instead of being killed mid-batch by the platform. */
const TIME_BUDGET_MS = 20_000;

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
  // Precedence fix (pre-release audit follow-up) — a technically-invalid
  // attempt (isSecurePolicyMismatchForResume) must never be
  // auto-finalized by this sweep; it belongs to the lecturer VOIDED
  // recovery workflow instead. Counted separately (never touched, never
  // scored, never audited as server-finalized) so this is observable in
  // the response/logs without exposing which submission it was.
  let skippedTechnicalMismatch = 0;
  const startedAtMs = Date.now();

  try {
    let cursor: { startedAt: Date; id: string } | null = null;

    while (scanned < SCAN_ROW_CEILING && finalized < FINALIZE_CEILING && Date.now() - startedAtMs < TIME_BUDGET_MS) {
      // Keyset pagination — strictly "after" the last row processed in
      // cursor order, so this page can never re-examine a row already
      // looked at earlier in this same invocation. Ordering by
      // (startedAt, id) both ways keeps the cursor comparison and the
      // ORDER BY consistent with each other. Built as its own
      // explicitly-typed variable (rather than inline) — an inline
      // conditional-spread `where` here otherwise defeats TypeScript's
      // inference of `findMany`'s own result type.
      const where: Prisma.SubmissionWhereInput = {
        status: "IN_PROGRESS",
        ...(cursor
          ? {
              OR: [
                { startedAt: { gt: cursor.startedAt } },
                { startedAt: cursor.startedAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      };
      const page = await prisma.submission.findMany({
        where,
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
        take: PAGE_SIZE,
        select: {
          id: true,
          examId: true,
          studentId: true,
          startedAt: true,
          examPolicySnapshotJson: true,
          secureClientPolicySnapshotJson: true,
          exam: { select: { durationMins: true, secureSettings: true } },
        },
      });

      if (page.length === 0) break; // reached the true end of the IN_PROGRESS set

      for (const candidate of page) {
        if (scanned >= SCAN_ROW_CEILING || finalized >= FINALIZE_CEILING || Date.now() - startedAtMs >= TIME_BUDGET_MS) break;
        scanned += 1;
        try {
          const settings = parseSecureSettings(candidate.exam.secureSettings);
          const timingPolicy = resolveSubmissionTimingPolicy({
            examPolicySnapshotJson: candidate.examPolicySnapshotJson,
            currentExamDurationMins: candidate.exam.durationMins,
            currentSecureSettings: settings,
          });
          const deadline = submissionDeadline(candidate.startedAt, timingPolicy.durationMins);
          const frozenPolicy = parseSecureClientPolicy(candidate.secureClientPolicySnapshotJson);
          const eligibility = evaluateServerBackstopEligibility({
            status: "IN_PROGRESS",
            now: new Date(),
            deadline,
            autoSubmitOnTimerEnd: timingPolicy.autoSubmitOnTimerEnd,
            currentExamDeliveryMode: settings.deliveryMode,
            frozenPolicy,
          });
          if (!eligibility.eligible) {
            if (eligibility.reason === "SECURE_POLICY_MISMATCH") skippedTechnicalMismatch += 1;
            continue;
          }
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

      const last = page[page.length - 1];
      cursor = { startedAt: last.startedAt, id: last.id };
      if (page.length < PAGE_SIZE) break; // short page — no more rows beyond this one
    }

    return NextResponse.json({ scanned, eligible, finalized, alreadyFinalized, skippedTechnicalMismatch, failed });
  } catch (err) {
    console.error("[finalize-overdue-submissions] sweep failed", err);
    return NextResponse.json({ error: "Sweep failed", scanned, eligible, finalized, alreadyFinalized, skippedTechnicalMismatch, failed }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 30;
