/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 10 of the spec.
 *
 * POST /api/secure-client/sessions/[sessionId]/interrupt
 *
 * Explicit client-reported interruption (e.g. the client is closing).
 * Never automatically submits the attempt — autosaved answers remain
 * available exactly as before.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { SecureClientError, loadValidatedSecureClientSession, markSessionInterrupted, recordSecureClientEvent } from "@/lib/secureClientRunner";

const bodySchema = z.object({ reasonCode: z.string().max(100).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sessionId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);

  let loaded;
  try {
    loaded = await loadValidatedSecureClientSession(sessionId, session.user.id);
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  const updated = await markSessionInterrupted(sessionId, parsed.success ? parsed.data.reasonCode : undefined);
  await recordSecureClientEvent({
    secureClientSessionId: sessionId,
    submissionId: loaded.session.submissionId,
    examId: loaded.session.examId,
    institutionId: loaded.session.institutionId,
    eventType: "SECURE_CLIENT_INTERRUPTED",
    clientRequestId: null,
    sequenceNumber: null,
    clientElapsedMs: null,
    metadata: parsed.success && parsed.data.reasonCode ? { reasonCode: parsed.data.reasonCode } : {},
  }).catch(() => {});

  return NextResponse.json({ ok: true, status: updated.status });
}

export const dynamic = "force-dynamic";
