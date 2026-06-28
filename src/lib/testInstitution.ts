import { prisma } from "@/lib/prisma";

/**
 * Shared test-only institution so route-level tests (which mock sessions
 * directly rather than going through real login) have a valid
 * institutionId to stamp onto fixture users/exams and embed in mocked
 * sessions. See docs/multi-tenant-migration.md.
 */
export async function getOrCreateTestInstitution(slug: string) {
  return prisma.institution.upsert({
    where: { slug },
    update: {},
    create: { name: `Test Institution (${slug})`, slug, plan: "pilot", active: true },
  });
}
