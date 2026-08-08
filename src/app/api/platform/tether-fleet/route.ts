/**
 * Production administration hardening v1, Part C — Tether version fleet
 * visibility. See docs/tether-broad-rollout-readiness.md.
 *
 * GET /api/platform/tether-fleet — PLATFORM_ADMIN only, same gating
 * pattern as GET /api/platform/operational-health. Does NOT change
 * minimum-supported-version enforcement — read-only visibility into what
 * versions are actually installed, classified against the EXISTING
 * minimumSupportedTetherVersion() resolver (see
 * src/lib/tetherFleetVisibility.ts's own doc comment).
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { requirePlatformAdmin } from "@/lib/platformAdmin";
import { summarizeTetherFleet } from "@/lib/tetherFleetVisibility";

export async function GET(req: Request) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const url = new URL(req.url);
  const institutionId = url.searchParams.get("institutionId") ?? undefined;

  const summary = await summarizeTetherFleet(institutionId);
  return NextResponse.json(summary);
}

export const dynamic = "force-dynamic";
