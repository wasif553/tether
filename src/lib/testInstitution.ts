import { prisma } from "@/lib/prisma";
import { getInstitutionEntitlement, upsertInstitutionEntitlement, defaultInstitutionEntitlementInput } from "@/lib/institutionEntitlement";

/**
 * Shared test-only institution so route-level tests (which mock sessions
 * directly rather than going through real login) have a valid
 * institutionId to stamp onto fixture users/exams and embed in mocked
 * sessions. See docs/multi-tenant-migration.md.
 *
 * Institution Entitlement & Access Control v1 (section 24) — also
 * creates an explicit, fully-permissive InstitutionEntitlement row
 * (TRIAL/ACTIVE, no expiry, unlimited, every feature enabled) so the
 * hundreds of existing DB-backed tests that call this helper exercise
 * the REAL entitlement-evaluation code path with an explicit row,
 * rather than only ever hitting institutionEntitlement.ts's "no row
 * found" migration-safety fallback. Only ever CREATES the row (never
 * overwrites one that already exists) — a test that deliberately
 * customizes its institution's entitlement (e.g. to test a suspended or
 * expired institution) and later calls this helper again with the same
 * slug can never have that customization silently reset back to the
 * default. Same "create, never clobber" safety property the production
 * backfill in prisma/seed.ts uses.
 */
export async function getOrCreateTestInstitution(slug: string) {
  const institution = await prisma.institution.upsert({
    where: { slug },
    update: {},
    create: { name: `Test Institution (${slug})`, slug, plan: "pilot", active: true },
  });
  const existingEntitlement = await getInstitutionEntitlement(institution.id);
  if (!existingEntitlement) {
    await upsertInstitutionEntitlement(institution.id, defaultInstitutionEntitlementInput());
  }
  return institution;
}
