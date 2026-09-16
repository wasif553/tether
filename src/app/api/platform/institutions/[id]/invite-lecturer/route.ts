import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin, createPlatformAuditLog, validateInviteLecturerPayload } from "@/lib/platformAdmin";
import { requireInstitutionEntitlement } from "@/lib/institutionEntitlement";

/**
 * Creates a LECTURER user directly inside a target institution. There is
 * no email-sending flow yet (see docs/platform-admin-onboarding.md) — the
 * platform admin must share the temporary password with the lecturer out
 * of band.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const { id } = await params;
  const institution = await prisma.institution.findUnique({ where: { id } });
  if (!institution) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await req.json();
  const parsed = validateInviteLecturerPayload(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Institution Entitlement & Access Control v1 — general status/date
  // gate only (lecturers are never counted against candidateLimit).
  // Supersedes the old raw `institution.active` check — see
  // invite-student's matching comment.
  const entitlementDenied = await requireInstitutionEntitlement({
    institutionId: institution.id,
    action: "INVITE_LECTURER",
  });
  if (entitlementDenied) return entitlementDenied;

  const existing = await prisma.user.findUnique({ where: { email: parsed.email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(parsed.password, 12);
  const lecturer = await prisma.user.create({
    data: {
      name: parsed.name,
      email: parsed.email,
      passwordHash,
      role: "LECTURER",
      institutionId: institution.id,
    },
    select: { id: true, name: true, email: true, role: true, institutionId: true, createdAt: true },
  });

  await createPlatformAuditLog({
    actorId: session!.user.id,
    action: "lecturer.invite",
    targetType: "User",
    targetId: lecturer.id,
    institutionId: institution.id,
    metadata: { email: lecturer.email },
  });

  return NextResponse.json(lecturer, { status: 201 });
}

export const dynamic = "force-dynamic";
