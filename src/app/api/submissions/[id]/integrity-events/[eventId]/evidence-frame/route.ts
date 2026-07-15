/**
 * On-Device AI Camera Integrity Detection v1 — Evidence Frames. See
 * docs/on-device-ai-integrity-detection-v1.md.
 *
 * POST /api/submissions/[id]/integrity-events/[eventId]/evidence-frame
 *
 * Accepts a single, already-downscaled/re-encoded still frame
 * (multipart/form-data, field `file`) and stores it privately, linked to
 * one existing IntegrityEvent. Student-only, own submission only, and
 * only for the two event types evidence capture supports in v1
 * (POSSIBLE_PHONE_VISIBLE / POSSIBLE_SECOND_PERSON_VISIBLE) with
 * captureAiViolationEvidence explicitly enabled on the exam. At most one
 * evidence asset per event (enforced by a DB unique constraint, not just
 * this route). Never accepts or stores raw base64/data-URL metadata on
 * the IntegrityEvent itself — this is a wholly separate table/route from
 * POST .../integrity-events, which keeps rejecting any image-like
 * metadata exactly as before.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { parseSecureSettings } from "@/lib/secureExam";
import {
  EVIDENCE_FRAME_KIND,
  EVIDENCE_FRAME_REDACTION_MODE,
  generateEvidenceFrameStorageKey,
  isEvidenceCaptureEligibleEventType,
  shouldCaptureEvidenceFrame,
  validateEvidenceFrameUpload,
} from "@/lib/aiCameraEvidenceFrame";
import { randomStorageSuffix, resolveEvidenceStorageAdapter } from "@/lib/evidenceStorage";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, eventId } = await params;

  const submission = await prisma.submission.findUnique({
    where: { id },
    include: { exam: true },
  });
  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.status === "GRADED") {
    return NextResponse.json({ error: "This submission is no longer active" }, { status: 409 });
  }

  const event = await prisma.integrityEvent.findUnique({ where: { id: eventId } });
  if (!event || event.submissionId !== submission.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!isEvidenceCaptureEligibleEventType(event.eventType)) {
    return NextResponse.json(
      { error: "Evidence frames are not supported for this event type" },
      { status: 400 },
    );
  }

  const secureSettings = parseSecureSettings(submission.exam.secureSettings);
  if (!shouldCaptureEvidenceFrame(event.eventType, secureSettings)) {
    return NextResponse.json(
      { error: "Evidence frame capture is not enabled for this exam" },
      { status: 403 },
    );
  }

  const institutionId = submission.exam.institutionId;
  if (!institutionId) {
    return NextResponse.json({ error: "Exam is missing institution scoping" }, { status: 500 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Request must be multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "A file field is required" }, { status: 400 });
  }

  const contentType = file.type;
  const byteSize = file.size;
  const validation = validateEvidenceFrameUpload({ contentType, byteSize });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const storageKey = generateEvidenceFrameStorageKey(
    {
      examId: submission.examId,
      submissionId: submission.id,
      integrityEventId: eventId,
      contentType,
    },
    randomStorageSuffix(),
  );

  const adapter = resolveEvidenceStorageAdapter();
  try {
    await adapter.put(storageKey, bytes);
  } catch (err) {
    console.error("Evidence frame storage write failed", err);
    return NextResponse.json({ error: "Evidence storage is currently unavailable" }, { status: 503 });
  }

  try {
    const asset = await prisma.integrityEvidenceAsset.create({
      data: {
        integrityEventId: eventId,
        submissionId: submission.id,
        examId: submission.examId,
        institutionId,
        kind: EVIDENCE_FRAME_KIND,
        eventType: event.eventType,
        storageProvider: adapter.provider,
        storageKey,
        contentType,
        byteSize,
        sha256,
        redactionMode: EVIDENCE_FRAME_REDACTION_MODE,
      },
    });
    return NextResponse.json({ ok: true, evidenceAssetId: asset.id }, { status: 201 });
  } catch (err) {
    // Clean up the just-written file if the DB insert failed (e.g. a race
    // where two uploads for the same event both passed the pre-check).
    await adapter.delete(storageKey).catch(() => {});
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "Evidence frame already exists for this event" }, { status: 409 });
    }
    throw err;
  }
}

export const dynamic = "force-dynamic";
