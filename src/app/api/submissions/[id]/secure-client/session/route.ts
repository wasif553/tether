/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * POST /api/submissions/[id]/secure-client/session
 *
 * Returns the current secure-client session for this submission (created
 * by consuming a launch manifest), reconciling interruption state at
 * this touchpoint (Part 10: "when start/resume is attempted"). Does not
 * create a session on its own — a session only ever comes from
 * consuming a signed launch manifest.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { SecureClientError, loadValidatedSecureClientSubmission, getCurrentSessionForSubmission, reconcileSessionInterruption } from "@/lib/secureClientRunner";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let context;
  try {
    context = await loadValidatedSecureClientSubmission(id, session.user.id);
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  const current = await getCurrentSessionForSubmission(id);
  if (!current) {
    return NextResponse.json({ session: null }, { status: 200 });
  }
  const reconciled = await reconcileSessionInterruption(current.id, context.policy);

  return NextResponse.json({
    session: {
      id: (reconciled ?? current).id,
      status: (reconciled ?? current).status,
      verificationStatus: current.verificationStatus,
      clientType: current.clientType,
      lastHeartbeatAt: current.lastHeartbeatAt,
    },
  });
}

export const dynamic = "force-dynamic";
