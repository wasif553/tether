/**
 * Production administration hardening v1, Part E — see
 * docs/tether-evidence-retention-plan.md.
 *
 * GET /api/platform/evidence-retention-preview — PLATFORM_ADMIN only,
 * same gating pattern as every other /api/platform/* route. ALWAYS a
 * read-only preview (previewEvidenceRetention never deletes anything —
 * see its own doc comment). There is deliberately no POST/DELETE on this
 * route: actually executing a retention sweep remains the CLI-only
 * `npm run evidence:retention -- --execute` path (see
 * scripts/run-evidence-retention.ts) — this task explicitly does not add
 * a web-UI deletion capability.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { requirePlatformAdmin } from "@/lib/platformAdmin";
import { previewEvidenceRetention } from "@/lib/evidenceRetentionPreview";

export async function GET(req: Request) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const url = new URL(req.url);
  const institutionId = url.searchParams.get("institutionId") ?? undefined;
  const retentionDaysRaw = url.searchParams.get("retentionDays");
  const retentionDays = retentionDaysRaw != null && Number.isFinite(Number(retentionDaysRaw)) && Number(retentionDaysRaw) > 0 ? Number(retentionDaysRaw) : undefined;

  const preview = await previewEvidenceRetention({ retentionDays, institutionId });
  return NextResponse.json(preview);
}

export const dynamic = "force-dynamic";
