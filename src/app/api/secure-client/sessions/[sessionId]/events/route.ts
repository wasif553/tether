/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 3/14 of the spec.
 *
 * POST /api/secure-client/sessions/[sessionId]/events
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SECURE_CLIENT_EVENT_TYPES, isValidSecureClientEventType } from "@/lib/secureClient/secureClientEvents";
import { SecureClientError, loadValidatedSecureClientSession, recordSecureClientEvent } from "@/lib/secureClientRunner";

const bodySchema = z.object({
  eventType: z.enum(SECURE_CLIENT_EVENT_TYPES),
  clientRequestId: z.string().max(100).optional(),
  sequenceNumber: z.number().int().nonnegative().optional(),
  clientElapsedMs: z.number().int().nonnegative().optional(),
  metadata: z.unknown().optional(),
});

const RATE_LIMIT_WINDOW_MS = 20_000;
const RATE_LIMIT_MAX_EVENTS = 20;

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sessionId } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (!isValidSecureClientEventType(parsed.data.eventType)) {
    return NextResponse.json({ error: "Invalid eventType" }, { status: 400 });
  }

  let loaded;
  try {
    loaded = await loadValidatedSecureClientSession(sessionId, session.user.id);
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  const recentCount = await prisma.secureClientEvent.count({
    where: { secureClientSessionId: sessionId, serverReceivedAt: { gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) } },
  });
  if (recentCount >= RATE_LIMIT_MAX_EVENTS) {
    return NextResponse.json({ error: "Too many event requests in a short period" }, { status: 429 });
  }

  const result = await recordSecureClientEvent({
    secureClientSessionId: sessionId,
    submissionId: loaded.session.submissionId,
    examId: loaded.session.examId,
    institutionId: loaded.session.institutionId,
    eventType: parsed.data.eventType,
    clientRequestId: parsed.data.clientRequestId?.trim() || null,
    sequenceNumber: parsed.data.sequenceNumber ?? null,
    clientElapsedMs: parsed.data.clientElapsedMs ?? null,
    metadata: parsed.data.metadata,
  });

  return NextResponse.json({ ok: true, eventId: result.id, replay: result.replay }, { status: result.replay ? 200 : 201 });
}

export const dynamic = "force-dynamic";
