/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md,
 * "Multi-device support".
 *
 * GET /api/tether/installation/list — the authenticated student's own
 * registered devices (ACTIVE, REVOKED, and REPLACED), by creation date,
 * last-attested date, and status only. Privacy-preserving by
 * construction: never the public key or its fingerprint, never any
 * hardware identifier. Pairs with the existing self-service
 * POST /api/tether/installation/[id]/revoke — this route is read-only.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listOwnedInstallations } from "@/lib/systemCheck/tetherAttestationRunner";
import { resolveMaxActiveInstallationsPerUser } from "@/lib/tetherAttestationConfig";

export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const installations = await listOwnedInstallations(session.user.id);
  return NextResponse.json({
    installations: installations.map((i) => ({
      id: i.id,
      status: i.status,
      keyProtectionLevel: i.keyProtectionLevel,
      clientVersion: i.clientVersion,
      platform: i.platform,
      installedAt: i.installedAt,
      lastAttestedAt: i.lastAttestedAt,
      revokedAt: i.revokedAt,
    })),
    maxActiveInstallations: resolveMaxActiveInstallationsPerUser(),
  });
}

export const dynamic = "force-dynamic";
