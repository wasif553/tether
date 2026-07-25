/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * POST /api/secure-client/sessions/[sessionId]/end
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { SecureClientError, loadValidatedSecureClientSession, endSession, recordSecureClientEvent } from "@/lib/secureClientRunner";

const bodySchema = z.object({ endReason: z.string().max(200).default("CLIENT_REQUESTED") });

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sessionId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  const endReason = parsed.success ? parsed.data.endReason : "CLIENT_REQUESTED";

  let loaded;
  try {
    loaded = await loadValidatedSecureClientSession(sessionId, session.user.id);
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  const updated = await endSession(sessionId, endReason);
  await recordSecureClientEvent({
    secureClientSessionId: sessionId,
    submissionId: loaded.session.submissionId,
    examId: loaded.session.examId,
    institutionId: loaded.session.institutionId,
    eventType: "SECURE_CLIENT_ENDED",
    clientRequestId: null,
    sequenceNumber: null,
    clientElapsedMs: null,
    metadata: { endReason },
  }).catch(() => {});

  return NextResponse.json({ ok: true, status: updated.status });
}

export const dynamic = "force-dynamic";
