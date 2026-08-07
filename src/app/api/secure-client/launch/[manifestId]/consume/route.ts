/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * POST /api/secure-client/launch/[manifestId]/consume
 *
 * One-time consumption of a signed launch manifest. A second attempt for
 * the same manifest is a replay and is rejected (and recorded) — never
 * silently succeeds.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { consumeLaunchManifest } from "@/lib/secureClientRunner";
import type { SecureLaunchManifest } from "@/lib/secureClient/secureLaunchManifest";
import { logServerTetherDiagnostic } from "@/lib/tetherDiagnosticLog";

const manifestSchema = z.object({
  schemaVersion: z.number(),
  manifestId: z.string(),
  keyId: z.string(),
  issuer: z.string(),
  audience: z.string(),
  institutionId: z.string(),
  examId: z.string(),
  submissionId: z.string(),
  studentSubjectHash: z.string(),
  configurationId: z.string().nullable(),
  clientType: z.string(),
  policyHash: z.string(),
  canonicalExamOrigin: z.string(),
  launchPath: z.string(),
  issuedAt: z.string(),
  notBefore: z.string(),
  expiresAt: z.string(),
  nonce: z.string(),
  minimumClientVersion: z.string().nullable(),
  allowedPlatform: z.array(z.string()),
  heartbeatIntervalSeconds: z.number(),
  heartbeatGraceSeconds: z.number(),
  requiredChecks: z.array(z.string()),
  permittedCapabilities: z.array(z.string()),
});

const bodySchema = z.object({ manifest: manifestSchema, signature: z.string() });

export async function POST(req: Request, { params }: { params: Promise<{ manifestId: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { manifestId } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.manifest.manifestId !== manifestId) {
    return NextResponse.json({ error: "Manifest id mismatch" }, { status: 400 });
  }
  if (parsed.data.manifest.submissionId === "" || parsed.data.manifest.studentSubjectHash === "") {
    return NextResponse.json({ error: "Malformed manifest" }, { status: 400 });
  }

  const owning = await prisma.submission.findUnique({
    where: { id: parsed.data.manifest.submissionId },
    select: { studentId: true },
  });
  if (!owning || owning.studentId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const outcome = await consumeLaunchManifest(parsed.data.manifest as SecureLaunchManifest, parsed.data.signature, parsed.data.manifest.nonce);

  if (outcome.outcome === "CONSUMED") {
    await prisma.secureClientEvent.create({
      data: {
        secureClientSessionId: outcome.sessionId,
        submissionId: parsed.data.manifest.submissionId,
        examId: parsed.data.manifest.examId,
        institutionId: parsed.data.manifest.institutionId,
        eventType: "SECURE_CLIENT_LAUNCH_CONSUMED",
        eventLevel: "INFORMATIONAL",
      },
    }).catch(() => {});
    logServerTetherDiagnostic("launch_manifest_consumed_session_created", {
      manifestId,
      sessionId: outcome.sessionId,
      outcome: outcome.outcome,
    });
    return NextResponse.json({ ok: true, sessionId: outcome.sessionId }, { status: 200 });
  }

  if (outcome.outcome === "REPLAY") {
    await prisma.secureClientEvent.create({
      data: {
        submissionId: parsed.data.manifest.submissionId,
        examId: parsed.data.manifest.examId,
        institutionId: parsed.data.manifest.institutionId,
        eventType: "SECURE_CLIENT_LAUNCH_REPLAY_REJECTED",
        eventLevel: "REVIEW_CONTEXT",
      },
    }).catch(() => {});
    return NextResponse.json({ error: "This launch has already been used", code: "REPLAY" }, { status: 409 });
  }

  if (outcome.outcome === "TRANSIENT_FAILURE") {
    // URGENT fix — a failed transaction (P2028 timeout or similar) must
    // fail closed with a controlled, generic response — never an opaque
    // Next.js 500 exposing internal Prisma error details to the student.
    // The actual diagnostic (error name/code) was already recorded
    // server-side inside consumeLaunchManifest. 503 (not 500) — this is a
    // transient infrastructure condition the student can reasonably
    // retry, not a defect in their request.
    logServerTetherDiagnostic("launch_manifest_consume_transient_failure", { manifestId });
    return NextResponse.json(
      { error: "Your secure exam could not be opened. Please try again. If the problem continues, contact support.", code: "TRANSIENT_FAILURE" },
      { status: 503 },
    );
  }

  const statusByOutcome: Record<string, number> = {
    NOT_FOUND: 404,
    EXPIRED: 410,
    REVOKED: 410,
    INVALID_NONCE: 400,
    INVALID_SIGNATURE: 400,
  };
  return NextResponse.json({ error: "Launch could not be verified", code: outcome.outcome }, { status: statusByOutcome[outcome.outcome] ?? 400 });
}

export const dynamic = "force-dynamic";
