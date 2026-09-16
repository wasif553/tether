/**
 * Institution Entitlement & Access Control v1 — see
 * docs/institution-entitlement-v1.md.
 *
 * PLATFORM_ADMIN-only read/write for one institution's
 * InstitutionEntitlement row. This is NOT a billing API — it records the
 * result of a commercial decision Platform Admin already made manually;
 * no payment provider is contacted here.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin, createPlatformAuditLog } from "@/lib/platformAdmin";
import {
  getInstitutionEntitlement,
  getInstitutionUsage,
  evaluateInstitutionEntitlement,
  upsertInstitutionEntitlement,
  defaultInstitutionEntitlementInput,
  validateEntitlementInput,
  type UpsertInstitutionEntitlementInput,
} from "@/lib/institutionEntitlement";

const nullableDateTime = z
  .string()
  .datetime()
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null ? null : new Date(v)));

const entitlementInputSchema = z.object({
  accessType: z.enum(["INTERNAL", "TRIAL", "FREE", "PAID"]),
  status: z.enum(["ACTIVE", "SUSPENDED", "EXPIRED", "GRACE"]),
  startsAt: nullableDateTime,
  endsAt: nullableDateTime,
  graceEndsAt: nullableDateTime,
  // null = unlimited — see UpsertInstitutionEntitlementInput's own doc comment.
  candidateLimit: z.number().int().positive().nullable().optional(),
  attemptLimit: z.number().int().positive().nullable().optional(),
  secureBrowserEnabled: z.boolean(),
  aiBrainstormingEnabled: z.boolean(),
  aiMarkingEnabled: z.boolean(),
  analyticsEnabled: z.boolean(),
  advancedReportingEnabled: z.boolean(),
  internalNotes: z.string().nullable().optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const { id } = await params;
  const institution = await prisma.institution.findUnique({ where: { id } });
  if (!institution) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [entitlement, usage] = await Promise.all([getInstitutionEntitlement(id), getInstitutionUsage(id)]);
  const evaluated = evaluateInstitutionEntitlement(entitlement, new Date());

  return NextResponse.json({
    institutionId: id,
    entitlement,
    effectiveStatus: evaluated.effectiveStatus,
    usage,
    // A brand-new institution with no row yet: hand the caller a
    // ready-to-edit default (TRIAL/ACTIVE, no expiry, unlimited,
    // everything enabled — section 20) rather than making the UI invent
    // one client-side.
    suggestedDefault: entitlement ? null : defaultInstitutionEntitlementInput(),
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const denied = requirePlatformAdmin(session);
  if (denied) return denied;

  const { id } = await params;
  const institution = await prisma.institution.findUnique({ where: { id } });
  if (!institution) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const parsed = entitlementInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const input: UpsertInstitutionEntitlementInput = {
    accessType: d.accessType,
    status: d.status,
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
    graceEndsAt: d.graceEndsAt ?? null,
    candidateLimit: d.candidateLimit ?? null,
    attemptLimit: d.attemptLimit ?? null,
    secureBrowserEnabled: d.secureBrowserEnabled,
    aiBrainstormingEnabled: d.aiBrainstormingEnabled,
    aiMarkingEnabled: d.aiMarkingEnabled,
    analyticsEnabled: d.analyticsEnabled,
    advancedReportingEnabled: d.advancedReportingEnabled,
    internalNotes: d.internalNotes ?? null,
  };

  // Hardening pass, section 9 — cross-field logical validation beyond
  // zod's per-field type checks (endsAt-before-startsAt, GRACE with no
  // graceEndsAt, graceEndsAt-before-endsAt, non-positive limits). Never
  // relies on the Platform Admin form's own HTML validation alone.
  const validationErrors = validateEntitlementInput(input);
  if (validationErrors.length > 0) {
    return NextResponse.json({ error: "Invalid entitlement values", validationErrors }, { status: 400 });
  }

  const previous = await getInstitutionEntitlement(id);
  const updated = await upsertInstitutionEntitlement(id, input);

  // Audit action — section 15. Suspension/reactivation get their own
  // named actions (still with the full before/after payload) so a
  // reviewer scanning the audit log by action alone can find every
  // access-affecting change without opening every UPDATED row.
  const action = !previous
    ? "INSTITUTION_ENTITLEMENT_CREATED"
    : previous.status !== "SUSPENDED" && input.status === "SUSPENDED"
      ? "INSTITUTION_ENTITLEMENT_SUSPENDED"
      : previous.status === "SUSPENDED" && input.status !== "SUSPENDED"
        ? "INSTITUTION_ENTITLEMENT_REACTIVATED"
        : "INSTITUTION_ENTITLEMENT_UPDATED";

  await createPlatformAuditLog({
    actorId: session!.user.id,
    action,
    targetType: "InstitutionEntitlement",
    targetId: updated.id,
    institutionId: id,
    metadata: { previous, new: input },
  });

  const evaluated = evaluateInstitutionEntitlement(updated, new Date());
  return NextResponse.json({ entitlement: updated, effectiveStatus: evaluated.effectiveStatus });
}

export const dynamic = "force-dynamic";
