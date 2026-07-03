import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin, createPlatformAuditLog, validateInviteStudentPayload } from "@/lib/platformAdmin";

/**
 * Creates a STUDENT user directly inside a target institution. Same
 * no-email-sending caveat as invite-lecturer (see
 * docs/platform-admin-onboarding.md) — the platform admin must share the
 * temporary password with the student out of band.
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
  if (!institution.active) {
    return NextResponse.json({ error: "Institution is not active" }, { status: 400 });
  }

  const body = await req.json();
  const parsed = validateInviteStudentPayload(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email: parsed.email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(parsed.password, 12);
  const student = await prisma.user.create({
    data: {
      name: parsed.name,
      email: parsed.email,
      passwordHash,
      role: "STUDENT",
      institutionId: institution.id,
      institutionStudentId: parsed.institutionStudentId,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      institutionId: true,
      institutionStudentId: true,
      createdAt: true,
    },
  });

  await createPlatformAuditLog({
    actorId: session!.user.id,
    action: "student.invite",
    targetType: "User",
    targetId: student.id,
    institutionId: institution.id,
    metadata: { email: student.email },
  });

  return NextResponse.json(student, { status: 201 });
}

export const dynamic = "force-dynamic";
