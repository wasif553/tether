/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md.
 *
 * GET /api/tether/installation/current — the authenticated student's
 * current ACTIVE installation, if any (never REVOKED/REPLACED ones).
 * Lets the renderer decide whether it needs to register a new
 * installation before attempting an attestation. Returns only bounded,
 * non-secret fields — never the public key itself (not needed
 * client-side) and never anything installation-fingerprint-adjacent
 * beyond what is already visible to the owning student.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const installation = await prisma.tetherClientInstallation.findFirst({
    where: { userId: session.user.id, status: "ACTIVE" },
    orderBy: { installedAt: "desc" },
  });

  if (!installation) {
    return NextResponse.json({ installation: null });
  }

  return NextResponse.json({
    installation: {
      id: installation.id,
      keyProtectionLevel: installation.keyProtectionLevel,
      clientVersion: installation.clientVersion,
      platform: installation.platform,
      installedAt: installation.installedAt,
      lastAttestedAt: installation.lastAttestedAt,
    },
  });
}

export const dynamic = "force-dynamic";
