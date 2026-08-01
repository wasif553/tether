import { NextResponse } from "next/server";

/**
 * Tether System Check and Exam Readiness v1 — see
 * docs/tether-system-check-v1.md.
 *
 * GET /api/tether/system-check/ping — the dedicated lightweight
 * round-trip target for the network/service connectivity check (Part
 * H), alongside the existing /api/auth/session, /api/version, and
 * /api/readiness endpoints. Deliberately unauthenticated and trivial —
 * this exists only so the client can measure one request/response
 * round trip against THIS deployment with no other work in the
 * response path.
 */
export async function GET() {
  return NextResponse.json({ ok: true, serverTimeMs: Date.now() });
}

export const dynamic = "force-dynamic";
