/**
 * Tether Secure Client Foundation v1 â€” see
 * docs/secure-client-foundation-seb-v1.md and Part 4 of the spec.
 *
 * POST /api/lecturer/exams/[id]/secure-client/seb-keys
 *
 * Adds an allowed Browser Exam Key or Config Key. The raw key value is
 * accepted here, once, then never returned again in any response â€”
 * subsequent reads only ever see a masked fingerprint.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { addSebAllowedExamKey, maskSebKey, SecureClientError } from "@/lib/secureClientRunner";
import { SebKeyEncryptionConfigError } from "@/lib/secureClient/sebKeyEncryption";

const bodySchema = z.object({
  configurationId: z.string(),
  keyType: z.enum(["BROWSER_EXAM_KEY", "CONFIG_KEY"]),
  rawKey: z.string().min(8).max(500),
  platform: z.string().max(50).optional(),
  clientVersion: z.string().max(50).optional(),
  label: z.string().max(100).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ examId: string }> }) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { examId: id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const exam = await prisma.exam.findUnique({ where: { id }, select: { createdById: true, institutionId: true } });
  if (!exam || (!isPlatformAdmin(session) && exam.createdById !== session.user.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertSameInstitution(session, exam.institutionId);
  } catch (err) {
    const response = institutionErrorResponse(err);
    if (response) return response;
    throw err;
  }

  const config = await prisma.secureClientConfiguration.findUnique({ where: { id: parsed.data.configurationId } });
  if (!config || config.examId !== id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const key = await addSebAllowedExamKey(
      { configurationId: parsed.data.configurationId, keyType: parsed.data.keyType, rawKey: parsed.data.rawKey, platform: parsed.data.platform, clientVersion: parsed.data.clientVersion, label: parsed.data.label },
      session.user.id,
    );
    // Audited without the raw key value â€” never logged, never included in metadata.
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "SEB_ALLOWED_EXAM_KEY_ADDED",
      targetType: "SebAllowedExamKey",
      targetId: key.id,
      institutionId: exam.institutionId,
      metadata: { examId: id, keyType: parsed.data.keyType, platform: parsed.data.platform ?? null },
    }).catch(() => {});
    return NextResponse.json({ ok: true, id: key.id, fingerprint: maskSebKey(key.keyHash) }, { status: 201 });
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    // Fails closed without ever echoing the raw key or encryption
    // configuration state â€” see sebKeyEncryption.ts.
    if (err instanceof SebKeyEncryptionConfigError) {
      return NextResponse.json({ error: "Key encryption is not available. Contact your platform administrator.", code: "SEB_KEY_ENCRYPTION_UNAVAILABLE" }, { status: 503 });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
