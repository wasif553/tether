/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md.
 *
 * POST /api/tether/system-check/secure-client/challenge — issues a
 * short-lived, signed, purpose=SYSTEM_CHECK, installation-bound
 * challenge for the authenticated student's registered, ACTIVE
 * installation. No database write happens here (the challenge is a
 * stateless, self-contained signed artifact). Never logs the full
 * signed challenge or its raw nonce.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { issueAttestationChallenge } from "@/lib/systemCheck/tetherAttestationRunner";

const bodySchema = z.object({ installationId: z.string().min(1).max(100) });

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Malformed request" }, { status: 400 });
  }

  const result = await issueAttestationChallenge({ userId: session.user.id, purpose: "SYSTEM_CHECK", installationId: parsed.data.installationId });
  if (result.outcome === "INSTALLATION_NOT_FOUND") {
    return NextResponse.json({ error: "Installation not found." }, { status: 404 });
  }
  if (result.outcome === "INSTALLATION_NOT_ACTIVE") {
    return NextResponse.json({ error: "This installation is no longer active." }, { status: 409 });
  }

  return NextResponse.json({ challenge: result.challenge, signature: result.signature });
}

export const dynamic = "force-dynamic";
