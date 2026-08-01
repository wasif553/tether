/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md.
 *
 * POST /api/tether/installation/registration-challenge — issues a
 * short-lived, signed registration challenge for the authenticated
 * student, bound to the SPECIFIC public key the client already
 * generated locally (see "Single-use registration challenges" — the
 * renderer always calls ensureInstallationKey() before requesting this).
 * No database write at issuance (stateless, self-contained signed
 * artifact) — single-use is enforced atomically at consumption time
 * (POST .../register). Never logs the full signed challenge or the
 * public key.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { issueRegistrationChallenge } from "@/lib/systemCheck/tetherAttestationRunner";

const bodySchema = z.object({ publicKey: z.string().min(1).max(4096) });

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

  const { challenge, signature } = issueRegistrationChallenge({ userId: session.user.id, publicKey: parsed.data.publicKey });
  return NextResponse.json({ challenge, signature });
}

export const dynamic = "force-dynamic";
