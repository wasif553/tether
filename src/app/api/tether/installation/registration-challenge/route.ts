/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md.
 *
 * POST /api/tether/installation/registration-challenge — issues a
 * short-lived, signed registration challenge for the authenticated
 * student. No database write (stateless, self-contained signed
 * artifact). Never logs the full signed challenge.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { issueRegistrationChallenge } from "@/lib/systemCheck/tetherAttestationRunner";

export async function POST() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { challenge, signature } = issueRegistrationChallenge({ userId: session.user.id });
  return NextResponse.json({ challenge, signature });
}

export const dynamic = "force-dynamic";
