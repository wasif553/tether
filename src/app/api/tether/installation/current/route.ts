/**
 * Secure Client Attestation v2 — see docs/tether-system-check-v1.md.
 *
 * POST /api/tether/installation/current — does THIS device (identified by
 * the public key its local Electron main process already holds) have a
 * currently-ACTIVE registered installation? Lets the renderer decide
 * whether it needs to register a new one before attempting an
 * attestation.
 *
 * Multi-device support (TETHER_MAX_ACTIVE_INSTALLATIONS_PER_USER) means a
 * student may have more than one ACTIVE installation at once — this route
 * MUST therefore be looked up by the exact public-key fingerprint of the
 * device asking, never merely "any" active installation for this user
 * (findFirst-by-user-only would non-deterministically return a DIFFERENT
 * device's installationId, which this device cannot actually sign for —
 * a real functional bug, not merely a UX one, once more than one active
 * installation exists). The renderer always calls
 * window.sesLockdown.ensureInstallationKey() first to obtain its own
 * public key before calling this route — see
 * src/lib/secureClient/installationClient.ts.
 *
 * Returns only bounded, non-secret fields — never the public key itself
 * back to the client (it already knows its own; there is no need to echo
 * it), and never anything installation-fingerprint-adjacent beyond what
 * is already visible to the owning student.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { computePublicKeyFingerprint } from "@/lib/secureClient/tetherAttestation";

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

  const publicKeyFingerprint = computePublicKeyFingerprint(parsed.data.publicKey);
  const installation = await prisma.tetherClientInstallation.findFirst({
    where: { userId: session.user.id, publicKeyFingerprint, status: "ACTIVE" },
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
