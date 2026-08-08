/**
 * Pilot operations + distribution readiness v1 — see
 * docs/tether-release-management.md.
 *
 * GET /api/tether/release-metadata — the one client-safe surface for
 * `resolveTetherReleaseMetadata()` (src/lib/tetherReleaseMetadata.ts),
 * for the few "use client" pages (tether-launch's installer-fallback
 * link) that need this server-only, env-driven data and can't call the
 * resolver directly. Mirrors the existing
 * GET /api/tether/system-check/config route's own auth/shape
 * conventions exactly.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveTetherReleaseMetadata } from "@/lib/tetherReleaseMetadata";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(resolveTetherReleaseMetadata());
}

export const dynamic = "force-dynamic";
