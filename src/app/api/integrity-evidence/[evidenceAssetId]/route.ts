/**
 * On-Device AI Camera Integrity Detection v1 — Evidence Frames. See
 * docs/on-device-ai-integrity-detection-v1.md.
 *
 * GET /api/integrity-evidence/[evidenceAssetId]
 *
 * The ONLY way to view an evidence frame's bytes. Lecturer (owner of the
 * exam) or PLATFORM_ADMIN, same institution — the same access rule
 * `buildEvidenceReport()` already enforces for the rest of a submission's
 * evidence. A student can never reach this route for any role check to
 * even apply (STUDENT is not in the allowed-role set at all). The raw
 * `storageKey` is never sent to the browser — only the resolved image
 * bytes and content type. Every successful view is recorded to
 * PlatformAuditLog (never including the image itself).
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSameInstitution, institutionErrorResponse, isPlatformAdmin } from "@/lib/institutionScope";
import { createPlatformAuditLog } from "@/lib/platformAdmin";
import { resolveEvidenceStorageAdapter } from "@/lib/evidenceStorage";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ evidenceAssetId: string }> },
) {
  const session = await auth();
  if (!session || (session.user.role !== "LECTURER" && session.user.role !== "PLATFORM_ADMIN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { evidenceAssetId } = await params;

  const asset = await prisma.integrityEvidenceAsset.findUnique({
    where: { id: evidenceAssetId },
    include: { exam: { select: { createdById: true, institutionId: true } } },
  });
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!isPlatformAdmin(session) && asset.exam.createdById !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    assertSameInstitution(session, asset.exam.institutionId);
  } catch (err) {
    const res = institutionErrorResponse(err);
    if (res) return res;
    throw err;
  }

  const adapter = resolveEvidenceStorageAdapter();
  let bytes: Buffer | null;
  try {
    bytes = await adapter.get(asset.storageKey);
  } catch (err) {
    console.error("Evidence frame storage read failed", err);
    return NextResponse.json({ error: "Evidence storage is currently unavailable" }, { status: 503 });
  }
  if (!bytes) {
    return NextResponse.json({ error: "Evidence frame is no longer available" }, { status: 404 });
  }

  // Audit every successful view — never logs the image itself, only who/
  // what/when. Best-effort: a logging failure must not silently deny a
  // legitimate reviewer access, but it is logged loudly server-side so an
  // operator can investigate rather than access going unrecorded unnoticed.
  createPlatformAuditLog({
    actorId: session.user.id,
    action: "VIEW_AI_CAMERA_EVIDENCE_FRAME",
    targetType: "IntegrityEvidenceAsset",
    targetId: asset.id,
    institutionId: asset.institutionId,
    metadata: {
      role: session.user.role,
      submissionId: asset.submissionId,
      examId: asset.examId,
    },
  }).catch((err) => {
    console.error("Failed to write evidence-access audit log", err);
  });

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
    },
  });
}

export const dynamic = "force-dynamic";
