/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md,
 * "Installation revocation".
 *
 * POST /api/tether/installation/[id]/revoke — student self-service "log
 * out this device": the owning student may revoke their own
 * installation (e.g. a shared/lab computer, or a lost/stolen device). A
 * revoked installation can never again produce a VERIFIED attestation,
 * even with an otherwise-valid outstanding challenge. Administrative
 * (lecturer/platform-admin) revocation is out of scope for this pass —
 * see "Known limitations".
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { revokeInstallation } from "@/lib/systemCheck/tetherAttestationRunner";

const bodySchema = z.object({ reason: z.string().min(1).max(200).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const rawBody = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(rawBody);
  const reason = parsed.success && parsed.data.reason ? parsed.data.reason : "Revoked by student";

  const result = await revokeInstallation(id, session.user.id, reason);
  if (result.outcome === "NOT_FOUND") {
    return NextResponse.json({ error: "Installation not found." }, { status: 404 });
  }
  if (result.outcome === "ACTIVE_EXAM_IN_PROGRESS") {
    return NextResponse.json({ revoked: false, reason: "ACTIVE_EXAM_IN_PROGRESS" }, { status: 409 });
  }
  if (result.outcome === "ACTIVE_EXAM_IN_PROGRESS_ACCOUNT_WIDE") {
    return NextResponse.json({ revoked: false, reason: "ACTIVE_EXAM_IN_PROGRESS_ACCOUNT_WIDE" }, { status: 409 });
  }
  return NextResponse.json({ revoked: true, installationId: result.installation.id });
}

export const dynamic = "force-dynamic";
