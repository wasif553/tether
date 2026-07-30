/**
 * Tether System Check and Exam Readiness v1 — see
 * docs/tether-system-check-v1.md.
 *
 * GET /api/tether/system-check/latest — the current student's most
 * recent readiness record, if any, with server-computed expiry. Never
 * returns another student's record (scoped to the authenticated user's
 * id only) and never returns resultsJson's raw shape beyond the bounded
 * per-check {status, reasonCode} pairs already stored — there is nothing
 * else in that column to leak.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isRunExpired } from "@/lib/systemCheck/readiness";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const run = await prisma.tetherSystemCheckRun.findFirst({
    where: { userId: session.user.id },
    orderBy: { checkedAt: "desc" },
  });

  if (!run) {
    return NextResponse.json({ run: null, nowMs: Date.now() });
  }

  const nowMs = Date.now();
  return NextResponse.json({
    run: {
      id: run.id,
      overallStatus: run.overallStatus,
      sourceClientType: run.sourceClientType,
      clientVersion: run.clientVersion,
      operatingSystem: run.operatingSystem,
      operatingSystemVersion: run.operatingSystemVersion,
      checkedAt: run.checkedAt,
      expiresAt: run.expiresAt,
      expired: isRunExpired(run.expiresAt.getTime(), nowMs),
      results: run.resultsJson,
    },
    nowMs,
  });
}

export const dynamic = "force-dynamic";
