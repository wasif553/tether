/**
 * Production administration hardening v1 — see
 * docs/tether-production-observability.md.
 *
 * GET /api/platform/operational-health — PLATFORM_ADMIN only (see
 * requirePlatformAdmin, the single choke-point used by every other
 * /api/platform/* route — e.g. GET /api/platform/audit-logs). Never
 * exposes cross-institution data to anyone but a platform admin: an
 * institution-scoped view is available via `?institutionId=`, but the
 * route itself is gated identically regardless of whether that param is
 * present — there is no institution-admin-level access to this endpoint
 * in this pass (see docs/tether-broad-rollout-readiness.md for why a
 * lower-privilege "institution admin" role is out of scope here).
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { requirePlatformAdmin } from "@/lib/platformAdmin";
import { summarizeOperationalHealth, resolveOperationalHealthWindowHours } from "@/lib/operationalHealth";

export async function GET(req: Request) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const url = new URL(req.url);
  const institutionId = url.searchParams.get("institutionId") ?? undefined;
  const windowHours = resolveOperationalHealthWindowHours(url.searchParams.get("windowHours"));

  const summary = await summarizeOperationalHealth({ institutionId }, windowHours);
  return NextResponse.json(summary);
}

export const dynamic = "force-dynamic";
