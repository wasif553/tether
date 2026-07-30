/**
 * Tether System Check and Exam Readiness v1 — corrective pass (first-time
 * verification). See docs/tether-system-check-v1.md.
 *
 * POST /api/tether/system-check/secure-client/challenge — issues a
 * short-lived, signed SYSTEM_CHECK challenge for the authenticated
 * student. No database write happens here (the challenge is a
 * stateless, self-contained signed artifact) — see
 * systemCheckSecureClientRunner.ts. Never logs the full signed challenge
 * or its raw nonce.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { issueSystemCheckChallenge } from "@/lib/systemCheck/systemCheckSecureClientRunner";

export async function POST() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { challenge, signature } = issueSystemCheckChallenge({ userId: session.user.id });
  return NextResponse.json({ challenge, signature });
}

export const dynamic = "force-dynamic";
