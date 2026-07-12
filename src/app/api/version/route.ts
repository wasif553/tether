import { NextResponse } from "next/server";
import packageJson from "../../../../package.json";

/**
 * Debug-only endpoint to confirm which build is actually deployed —
 * added to diagnose a "production shows stale behavior" report where
 * local source and Supabase data both looked correct. No secrets: only
 * a commit hash (public in git history), a build timestamp, and the
 * app version from package.json.
 *
 * `VERCEL_GIT_COMMIT_SHA` is populated automatically by Vercel at build
 * time — no manual configuration needed there. `GIT_COMMIT_SHA` is a
 * fallback for other hosts that don't set the Vercel-specific var.
 */
export async function GET() {
  return NextResponse.json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null,
    builtAt: process.env.VERCEL_BUILD_TIMESTAMP ?? null,
    version: packageJson.version,
    checkedAt: new Date().toISOString(),
  });
}

export const dynamic = "force-dynamic";
