/**
 * Screen-share Evidence Mode v1. See docs/screen-share-evidence-v1.md.
 *
 * POST /api/submissions/[id]/screen-evidence
 *
 * Accepts a single, already-downscaled/re-encoded screen-share still
 * frame (multipart/form-data: `file`, `clientRequestId`, optional
 * `trigger`) and stores it privately, creating BOTH a new
 * SCREEN_SHARE_EVIDENCE_CAPTURED IntegrityEvent AND its
 * IntegrityEvidenceAsset atomically — unlike the camera evidence route
 * (POST .../integrity-events/[eventId]/evidence-frame), which attaches
 * to an ALREADY-existing detection event, screen evidence is periodic/
 * interruption-triggered rather than detection-triggered, so there is no
 * pre-existing event to attach to.
 *
 * Concurrency (Part 2 hardening pattern, reused from
 * src/lib/aiAssistanceRunner.ts): the count-check-then-create sequence
 * runs inside a single Postgres transaction guarded by a
 * transaction-scoped advisory lock keyed on submissionId
 * (`pg_advisory_xact_lock`, safe under Supabase's PgBouncer
 * transaction-mode pooler) — two concurrent uploads for the same
 * submission can never both slip past the max-frames check.
 *
 * Idempotency: `clientRequestId` (client-generated, one per logical
 * capture action) has a unique index on IntegrityEvidenceAsset — a
 * retried/duplicated request replays the original result instead of
 * creating a second asset and consuming a second slot.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseSecureSettings, severityFor } from "@/lib/secureExam";
import {
  parseScreenSharePolicy,
  isScreenShareEvidenceEnabled,
  hasReachedMaxEvidenceFrames,
  isWithinScreenEvidenceRateLimit,
  isWithinMinCaptureGap,
  isValidScreenShareCaptureTrigger,
  type ScreenSharePolicy,
} from "@/lib/screenSharePolicy";
import {
  SCREEN_SHARE_EVIDENCE_KIND,
  SCREEN_SHARE_EVIDENCE_EVENT_TYPE,
  SCREEN_SHARE_EVIDENCE_REDACTION_MODE,
  generateScreenEvidenceStorageKey,
  validateScreenEvidenceUpload,
} from "@/lib/screenShareEvidence";
import { randomStorageSuffix, resolveEvidenceStorageAdapter } from "@/lib/evidenceStorage";

type ReservationOutcome =
  | { kind: "reserved"; eventId: string; assetId: string }
  | { kind: "replay"; assetId: string }
  | { kind: "max_reached" }
  | { kind: "rate_limited" }
  | { kind: "too_soon" };

async function reserveAndCreateEvidence(params: {
  submissionId: string;
  examId: string;
  studentId: string;
  institutionId: string;
  policy: ScreenSharePolicy;
  settings: ReturnType<typeof parseSecureSettings>;
  trigger: string;
  clientRequestId: string | null;
  storageProvider: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}): Promise<ReservationOutcome> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.submissionId}))`;

    if (params.clientRequestId) {
      const existing = await tx.integrityEvidenceAsset.findUnique({
        where: { clientRequestId: params.clientRequestId },
        select: { id: true },
      });
      if (existing) return { kind: "replay", assetId: existing.id };
    }

    const existingAssets = await tx.integrityEvidenceAsset.findMany({
      where: { submissionId: params.submissionId, kind: SCREEN_SHARE_EVIDENCE_KIND },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { createdAt: true },
    });
    const totalCount = await tx.integrityEvidenceAsset.count({
      where: { submissionId: params.submissionId, kind: SCREEN_SHARE_EVIDENCE_KIND },
    });

    if (hasReachedMaxEvidenceFrames(totalCount, params.policy)) {
      return { kind: "max_reached" };
    }

    const now = Date.now();
    const recentTimestamps = existingAssets.map((a) => a.createdAt.getTime());
    if (!isWithinScreenEvidenceRateLimit(recentTimestamps, now)) {
      return { kind: "rate_limited" };
    }
    if (isWithinMinCaptureGap(recentTimestamps[0] ?? null, now, params.policy)) {
      return { kind: "too_soon" };
    }

    const event = await tx.integrityEvent.create({
      data: {
        submissionId: params.submissionId,
        examId: params.examId,
        studentId: params.studentId,
        eventType: SCREEN_SHARE_EVIDENCE_EVENT_TYPE,
        severity: severityFor(SCREEN_SHARE_EVIDENCE_EVENT_TYPE, params.settings),
        message: "A screen-share evidence frame was captured for review.",
        // Non-sensitive, minimal metadata only — never screen content,
        // titles, or application names (Part — "keep event metadata
        // minimal and non-sensitive").
        metadataJson: { trigger: params.trigger, captureIndex: totalCount + 1 },
        occurredAt: new Date(),
      },
    });

    const asset = await tx.integrityEvidenceAsset.create({
      data: {
        integrityEventId: event.id,
        submissionId: params.submissionId,
        examId: params.examId,
        institutionId: params.institutionId,
        kind: SCREEN_SHARE_EVIDENCE_KIND,
        eventType: SCREEN_SHARE_EVIDENCE_EVENT_TYPE,
        storageProvider: params.storageProvider,
        storageKey: params.storageKey,
        contentType: params.contentType,
        byteSize: params.byteSize,
        sha256: params.sha256,
        redactionMode: SCREEN_SHARE_EVIDENCE_REDACTION_MODE,
        clientRequestId: params.clientRequestId,
      },
    });

    return { kind: "reserved", eventId: event.id, assetId: asset.id };
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const submission = await prisma.submission.findUnique({ where: { id }, include: { exam: true } });
  if (!submission || submission.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (submission.status !== "IN_PROGRESS") {
    return NextResponse.json({ error: "This submission is no longer active" }, { status: 409 });
  }

  const policy = parseScreenSharePolicy(submission.screenSharePolicySnapshotJson);
  if (!isScreenShareEvidenceEnabled(policy)) {
    return NextResponse.json({ error: "Screen-share evidence capture is not enabled for this exam" }, { status: 403 });
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

  const rawClientRequestId = formData.get("clientRequestId");
  const clientRequestId =
    typeof rawClientRequestId === "string" && rawClientRequestId.trim().length > 0
      ? rawClientRequestId.trim().slice(0, 100)
      : null;

  const rawTrigger = formData.get("trigger");
  const trigger = typeof rawTrigger === "string" && isValidScreenShareCaptureTrigger(rawTrigger) ? rawTrigger : "PERIODIC";

  const contentType = file.type;
  const byteSize = file.size;
  const validation = validateScreenEvidenceUpload({ contentType, byteSize });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // Idempotency fast path — before ever touching storage, so a
  // resubmitted request with the same key never re-uploads bytes.
  if (clientRequestId) {
    const existing = await prisma.integrityEvidenceAsset.findUnique({
      where: { clientRequestId },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json({ ok: true, evidenceAssetId: existing.id, replay: true }, { status: 200 });
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = generateScreenEvidenceStorageKey({ submissionId: submission.id, contentType }, randomStorageSuffix());

  const adapter = resolveEvidenceStorageAdapter();
  try {
    await adapter.put(storageKey, bytes, contentType);
  } catch (err) {
    console.error("Screen evidence storage write failed", err);
    // Fail closed for AUTHORISATION, but a temporarily-unavailable
    // storage backend must never destroy the student's attempt — this
    // is purely "this one capture could not be saved," the exam
    // continues normally.
    return NextResponse.json({ error: "Evidence storage is currently unavailable" }, { status: 503 });
  }

  const settings = parseSecureSettings(submission.exam.secureSettings);

  let outcome: ReservationOutcome;
  try {
    outcome = await reserveAndCreateEvidence({
      submissionId: submission.id,
      examId: submission.examId,
      studentId: submission.studentId,
      institutionId,
      policy,
      settings,
      trigger,
      clientRequestId,
      storageProvider: adapter.provider,
      storageKey,
      contentType,
      byteSize,
      sha256,
    });
  } catch (err) {
    await adapter.delete(storageKey).catch(() => {});
    console.error("Screen evidence DB write failed", err);
    return NextResponse.json(
      { error: "Evidence frame could not be recorded — evidence storage may not be fully configured" },
      { status: 500 },
    );
  }

  if (outcome.kind !== "reserved" && outcome.kind !== "replay") {
    // The slot was not granted — clean up the just-written file so
    // storage never accumulates orphaned objects with no DB row.
    await adapter.delete(storageKey).catch(() => {});
    if (outcome.kind === "max_reached") {
      return NextResponse.json({ error: "Maximum screen evidence frames already recorded for this attempt" }, { status: 409 });
    }
    if (outcome.kind === "rate_limited") {
      return NextResponse.json({ error: "Too many evidence uploads in a short period" }, { status: 429 });
    }
    return NextResponse.json({ error: "Another evidence frame was captured too recently" }, { status: 429 });
  }

  if (outcome.kind === "replay") {
    // A genuine race: another request with the same clientRequestId won
    // between our idempotency fast-path check and this transaction. The
    // bytes we just wrote are redundant — the original upload's object
    // is already the one referenced by the DB row.
    await adapter.delete(storageKey).catch(() => {});
    return NextResponse.json({ ok: true, evidenceAssetId: outcome.assetId, replay: true }, { status: 200 });
  }

  return NextResponse.json({ ok: true, evidenceAssetId: outcome.assetId }, { status: 201 });
}

export const dynamic = "force-dynamic";
