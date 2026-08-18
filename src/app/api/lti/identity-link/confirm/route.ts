/**
 * Canvas/LTI identity-collision browser-flow hardening — see
 * docs/lti-identity-collision-hardening-v1.md.
 *
 * POST /api/lti/identity-link/confirm — the same-site request that
 * actually confirms account ownership and performs the Canvas identity
 * link. Called from /lti/identity-link (a normal Tether page), never
 * from Canvas directly — this is what lets `auth()` reliably see the
 * student's session, unlike the cross-site LTI launch POST.
 *
 * Trusts nothing from the client except the signed handoff token: every
 * identifier used for linking (existingUserId, canvasUserId,
 * platformId, derivedRole) comes from that token, verified server-side,
 * never from an independent request body field. `resolveLtiEmailCollision`
 * — the exact same resolver the (now cross-site-unsafe) launch route
 * used to call directly — still performs every safety check (role
 * match, institution compatibility, canvasUserId ownership, atomic
 * claims); this route's only job is to supply it a trustworthy
 * currentSessionUserId.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { verifyIdentityLinkHandoff } from "@/lib/lti/identityLinkHandoff";
import { resolveLtiEmailCollision } from "@/lib/lti/identityCollision";
import { createPlatformAuditLog } from "@/lib/platformAdmin";

const confirmSchema = z.object({ handoff: z.string().min(1) });

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || (session.user.role !== "STUDENT" && session.user.role !== "LECTURER")) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }

  const handoff = await verifyIdentityLinkHandoff(parsed.data.handoff);
  if (!handoff) {
    return NextResponse.json({ ok: false, reason: "invalid" });
  }

  const platform = await prisma.ltiPlatform.findUnique({ where: { id: handoff.platformId } });
  if (!platform) {
    return NextResponse.json({ ok: false, reason: "invalid" });
  }

  // The core ownership proof: the CURRENT authenticated Tether session
  // (a normal same-site request) must belong to the exact candidate
  // account the handoff named. Email alone was never sufficient to
  // reach this point, and the handoff alone is not sufficient either —
  // this equality check is what makes forwarding a handoff URL to a
  // different account harmless.
  if (session.user.id !== handoff.existingUserId) {
    return NextResponse.json({ ok: false, reason: "wrong_account" });
  }

  const outcome = await resolveLtiEmailCollision({
    existingUserId: handoff.existingUserId,
    canvasUserId: handoff.canvasUserId,
    derivedRole: handoff.derivedRole,
    platformInstitutionId: platform.institutionId,
    currentSessionUserId: session.user.id,
  });

  if (outcome.kind !== "linked") {
    createPlatformAuditLog({
      actorId: session.user.id,
      action: "lti.identity_link_blocked",
      targetType: "User",
      targetId: handoff.existingUserId,
      institutionId: platform.institutionId,
      // Never plaintext email/id_token/session cookie — only the safe,
      // already-non-secret reason code and platform id.
      metadata: { platformId: platform.id, reason: outcome.kind },
    }).catch(() => {});
    return NextResponse.json({ ok: false, reason: outcome.kind });
  }

  createPlatformAuditLog({
    actorId: session.user.id,
    action: "lti.identity_linked",
    targetType: "User",
    targetId: handoff.existingUserId,
    institutionId: platform.institutionId,
    metadata: { platformId: platform.id },
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
