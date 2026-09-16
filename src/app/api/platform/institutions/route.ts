import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  requirePlatformAdmin,
  createPlatformAuditLog,
  validateInstitutionPayload,
} from "@/lib/platformAdmin";
import {
  upsertInstitutionEntitlement,
  defaultInstitutionEntitlementInput,
  getInstitutionEntitlement,
  getInstitutionUsage,
  evaluateInstitutionEntitlement,
} from "@/lib/institutionEntitlement";

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

  // Institution Entitlement & Access Control v1, section 21 — enough of
  // an at-a-glance summary for Platform Admin (access type, effective
  // status, expiry, candidate/attempt usage vs limit) without turning
  // this into a billing dashboard. One usage query pair per institution
  // (getInstitutionUsage) — acceptable for a platform-admin-only,
  // typically-small institution list; not attempted as a single grouped
  // query because Submission has no institutionId scalar column of its
  // own to group by (see docs/multi-tenant-migration.md).
  const withEntitlement = await Promise.all(
    institutions.map(async (inst) => {
      const [entitlement, usage] = await Promise.all([getInstitutionEntitlement(inst.id), getInstitutionUsage(inst.id)]);
      const evaluated = evaluateInstitutionEntitlement(entitlement, new Date());
      return {
        ...inst,
        entitlement: entitlement
          ? {
              accessType: entitlement.accessType,
              status: entitlement.status,
              endsAt: entitlement.endsAt,
              graceEndsAt: entitlement.graceEndsAt,
            }
          : null,
        effectiveStatus: evaluated.effectiveStatus,
        usage,
      };
    }),
  );

  return NextResponse.json(withEntitlement);
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

  // Institution Entitlement & Access Control v1, section 20 — every
  // newly-created institution gets an explicit entitlement row in the
  // SAME workflow: TRIAL/ACTIVE, no expiry (Platform Admin sets one
  // explicitly later), unlimited, every feature enabled (preserves
  // current pilot behaviour — see defaultInstitutionEntitlementInput's
  // own doc comment). Never blocks institution creation if this fails.
  const defaultEntitlement = defaultInstitutionEntitlementInput();
  try {
    const entitlement = await upsertInstitutionEntitlement(institution.id, defaultEntitlement);
    await createPlatformAuditLog({
      actorId: session!.user.id,
      action: "INSTITUTION_ENTITLEMENT_CREATED",
      targetType: "InstitutionEntitlement",
      targetId: entitlement.id,
      institutionId: institution.id,
      metadata: { previous: null, new: defaultEntitlement },
    });
  } catch (err) {
    console.error("Failed to create default entitlement for new institution", { institutionId: institution.id, err });
  }

  return NextResponse.json(institution, { status: 201 });
}

export const dynamic = "force-dynamic";
