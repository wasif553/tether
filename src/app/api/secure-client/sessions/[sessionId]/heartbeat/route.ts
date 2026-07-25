/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 10 of the spec.
 *
 * POST /api/secure-client/sessions/[sessionId]/heartbeat
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { SecureClientError, loadValidatedSecureClientSession, recordHeartbeat } from "@/lib/secureClientRunner";

export async function POST(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sessionId } = await params;

  let loaded;
  try {
    loaded = await loadValidatedSecureClientSession(sessionId, session.user.id);
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
  if (!loaded.context) {
    return NextResponse.json({ error: "This attempt is no longer active" }, { status: 409 });
  }

  const updated = await recordHeartbeat(sessionId, loaded.context.policy);
  return NextResponse.json({ ok: true, status: updated.status, lastHeartbeatAt: updated.lastHeartbeatAt });
}

export const dynamic = "force-dynamic";
