import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin, createPlatformAuditLog } from "@/lib/platformAdmin";

const updateInstitutionSchema = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().min(1).nullable().optional(),
  plan: z.string().min(1).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const { id } = await params;
  const existing = await prisma.institution.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = updateInstitutionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Slug is intentionally not updatable in v2 — changing it would break
  // existing references and isn't yet tested (see docs/platform-admin-onboarding.md).
  const institution = await prisma.institution.update({
    where: { id },
    data: parsed.data,
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
    action: "institution.update",
    targetType: "Institution",
    targetId: institution.id,
    institutionId: institution.id,
    metadata: parsed.data,
  });

  return NextResponse.json(institution);
}

export const dynamic = "force-dynamic";
