/**
 * Tether System Check and Exam Readiness v1 — see
 * docs/tether-system-check-v1.md.
 *
 * GET /api/tether/system-check/config — server-configured values the
 * check-runner page needs before it can evaluate anything: enforcement
 * mode, result validity window, and the minimum supported Tether client
 * version (never hard-coded in the page itself). Also returns the
 * server's own clock so the client can compute the clock-difference
 * check (Part I) without a second round trip.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { systemCheckMode, systemCheckValidityHours, minimumSupportedTetherVersion } from "@/lib/systemCheckConfig";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    mode: systemCheckMode(),
    validityHours: systemCheckValidityHours(),
    minimumSupportedVersion: minimumSupportedTetherVersion(),
    serverTimeMs: Date.now(),
  });
}

export const dynamic = "force-dynamic";
