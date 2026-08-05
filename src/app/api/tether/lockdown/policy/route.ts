/**
 * Tether Windows Lockdown Hardening v1 — GET /api/tether/lockdown/policy.
 * See docs/tether-windows-lockdown-hardening-v1.md, "Configuration".
 *
 * Serves the four TETHER_BLOCK_* security toggles (Part 12), resolved
 * server-side (src/lib/tetherLockdownConfig.ts) — never read from
 * Electron's own local environment. The hosted page fetches this once
 * and relays it to Electron main via
 * window.sesLockdown.setLockdownPolicyToggles(...), exactly like
 * setSecureClientEnforcementState already does for display policy — see
 * that bridge method's own doc comment in apps/lockdown/src/preload.ts
 * for why policy must always flow server -> page -> Electron, never the
 * reverse.
 *
 * Deliberately global (no exam/submission scoping) — every field here is
 * an institution-wide operational setting, not anything specific to one
 * exam or student.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveLockdownPolicyToggles } from "@/lib/tetherLockdownConfig";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(resolveLockdownPolicyToggles());
}

export const dynamic = "force-dynamic";
