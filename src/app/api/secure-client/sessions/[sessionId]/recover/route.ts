/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 10 of the spec.
 *
 * POST /api/secure-client/sessions/[sessionId]/recover
 *
 * A soft INTERRUPTED session self-recovers with no grant required. A
 * harder RECOVERY_REQUIRED session needs a valid, one-time, lecturer-
 * issued recovery grant — an expired or already-consumed grant fails
 * safely (never silently succeeds).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { SecureClientError, loadValidatedSecureClientSession, requestSessionRecovery, consumeRecoveryGrant, recordSecureClientEvent } from "@/lib/secureClientRunner";

const bodySchema = z.object({ recoveryToken: z.string().max(200).optional() });

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

  await recordSecureClientEvent({
    secureClientSessionId: sessionId,
    submissionId: loaded.session.submissionId,
    examId: loaded.session.examId,
    institutionId: loaded.session.institutionId,
    eventType: "SECURE_CLIENT_RECOVERY_REQUESTED",
    clientRequestId: null,
    sequenceNumber: null,
    clientElapsedMs: null,
    metadata: {},
  }).catch(() => {});

  if (loaded.session.status === "RECOVERY_REQUIRED") {
    const token = parsed.success ? parsed.data.recoveryToken : undefined;
    if (!token) {
      return NextResponse.json({ error: "A recovery grant from your lecturer is required", code: "GRANT_REQUIRED" }, { status: 403 });
    }
    const outcome = await consumeRecoveryGrant(token, loaded.session.submissionId);
    if (outcome !== "RECOVERED") {
      return NextResponse.json({ error: "Recovery grant is invalid or has expired", code: outcome }, { status: 403 });
    }
    await recordSecureClientEvent({
      secureClientSessionId: sessionId,
      submissionId: loaded.session.submissionId,
      examId: loaded.session.examId,
      institutionId: loaded.session.institutionId,
      eventType: "SECURE_CLIENT_RECOVERED",
      clientRequestId: null,
      sequenceNumber: null,
      clientElapsedMs: null,
      metadata: {},
    }).catch(() => {});
    return NextResponse.json({ ok: true, status: "ACTIVE" });
  }

  const updated = await requestSessionRecovery(sessionId);
  if (updated.status === "ACTIVE") {
    await recordSecureClientEvent({
      secureClientSessionId: sessionId,
      submissionId: loaded.session.submissionId,
      examId: loaded.session.examId,
      institutionId: loaded.session.institutionId,
      eventType: "SECURE_CLIENT_RECOVERED",
      clientRequestId: null,
      sequenceNumber: null,
      clientElapsedMs: null,
      metadata: {},
    }).catch(() => {});
  }
  return NextResponse.json({ ok: true, status: updated.status });
}

export const dynamic = "force-dynamic";
