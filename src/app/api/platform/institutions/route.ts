import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  requirePlatformAdmin,
  createPlatformAuditLog,
  validateInstitutionPayload,
} from "@/lib/platformAdmin";

/**
 * Platform Admin Onboarding v2 — see docs/platform-admin-onboarding.md.
 */
export async function GET() {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const institutions = await prisma.institution.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      domain: true,
      plan: true,
      active: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { users: true, exams: true, ltiPlatforms: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(institutions);
}

export async function POST(req: Request) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const body = await req.json();
  const parsed = validateInstitutionPayload(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const existing = await prisma.institution.findUnique({ where: { slug: parsed.slug } });
  if (existing) {
    return NextResponse.json({ error: "An institution with this slug already exists" }, { status: 409 });
  }

  const institution = await prisma.institution.create({
    data: {
      name: parsed.name,
      slug: parsed.slug,
      domain: parsed.domain,
      plan: parsed.plan,
    },
    select: {
      id: true,
      name: true,
      slug: true,
      domain: true,
      plan: true,
      active: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  await createPlatformAuditLog({
    actorId: session!.user.id,
    action: "institution.create",
    targetType: "Institution",
    targetId: institution.id,
    institutionId: institution.id,
    metadata: { name: institution.name, slug: institution.slug },
  });

  return NextResponse.json(institution, { status: 201 });
}

export const dynamic = "force-dynamic";
