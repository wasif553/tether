import bcrypt from "bcryptjs";
import { seedCanvasPlatform } from "../src/lib/lti/seedPlatform";
import { DEFAULT_INSTITUTION_SLUG } from "../src/lib/institutionScope";
import { upsertInstitutionEntitlement, mapLegacyInstitutionToEntitlementInput } from "../src/lib/institutionEntitlement";
import { prisma } from "../src/lib/prisma";

async function main() {
  await seedCanvasPlatform();

  // --- Multi-Tenant Architecture v1: default institution + backfill ---
  // See docs/multi-tenant-migration.md. Idempotent — safe to re-run.
  const defaultInstitution = await prisma.institution.upsert({
    where: { slug: DEFAULT_INSTITUTION_SLUG },
    update: {},
    create: {
      name: "Default Institution",
      slug: DEFAULT_INSTITUTION_SLUG,
      plan: "pilot",
      active: true,
    },
  });

  await prisma.user.updateMany({
    where: { institutionId: null },
    data: { institutionId: defaultInstitution.id },
  });

  const examsWithoutInstitution = await prisma.exam.findMany({
    where: { institutionId: null },
    include: { createdBy: true },
  });
  for (const exam of examsWithoutInstitution) {
    await prisma.exam.update({
      where: { id: exam.id },
      data: { institutionId: exam.createdBy.institutionId ?? defaultInstitution.id },
    });
  }

  await prisma.ltiPlatform.updateMany({
    where: { institutionId: null },
    data: { institutionId: defaultInstitution.id },
  });

  // --- Institution Entitlement & Access Control v1: backfill ---
  // See docs/institution-entitlement-v1.md, "Migration & backfill".
  // Hardening pass correction: this is a LOCAL/DEV convenience only —
  // it is NOT how Preview/Production ever gets backfilled, since
  // prisma/seed.ts is never automatically run against those databases
  // (unlike the disposable release-validate database, which does run
  // it). The real production backfill is the INSERT ... SELECT block
  // inside docs/institution-entitlement-v1-migration.sql, applied
  // manually alongside the schema change itself — see that file's own
  // header for the exact procedure. Kept here anyway because it's
  // genuinely useful for any fresh local/dev database seeded from
  // scratch, and running it is always safe even after the SQL backfill
  // has already run elsewhere: idempotent — only ever creates a row for
  // an institution that doesn't already have one; never overwrites an
  // entitlement Platform Admin has already saved (via
  // PUT /api/platform/institutions/[id]/entitlement or a previous run of
  // either backfill mechanism). Every legacy institution maps
  // conservatively from its own plan/active fields — see
  // mapLegacyInstitutionToEntitlementInput's own doc comment for exactly
  // why this can never lock out an existing customer.
  const institutionsMissingEntitlement = await prisma.institution.findMany({
    where: { entitlement: null },
    select: { id: true, plan: true, active: true },
  });
  for (const inst of institutionsMissingEntitlement) {
    await upsertInstitutionEntitlement(inst.id, mapLegacyInstitutionToEntitlementInput(inst));
  }
  console.log(`Institution entitlement backfill: created ${institutionsMissingEntitlement.length} row(s) for previously-unmigrated institutions.`);

  // --- Platform admin account ---
  // Requires both PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD to be
  // set explicitly — there is no fallback default password. See
  // docs/platform-admin-onboarding.md.
  const adminEmailRaw = process.env.PLATFORM_ADMIN_EMAIL;
  const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD;
  if (adminEmailRaw && adminPassword) {
    const adminEmail = adminEmailRaw.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: {
        passwordHash,
        role: "PLATFORM_ADMIN",
        institutionId: defaultInstitution.id,
      },
      create: {
        name: "Platform Admin",
        email: adminEmail,
        passwordHash,
        role: "PLATFORM_ADMIN",
        institutionId: defaultInstitution.id,
      },
    });
    console.log("PLATFORM_ADMIN created/updated:", adminEmail);
  } else {
    console.log(
      "PLATFORM_ADMIN not created because PLATFORM_ADMIN_EMAIL or PLATFORM_ADMIN_PASSWORD is missing",
    );
  }

  const remainingNullUsers = await prisma.user.count({ where: { institutionId: null } });
  const remainingNullExams = await prisma.exam.count({ where: { institutionId: null } });
  const remainingNullPlatforms = await prisma.ltiPlatform.count({ where: { institutionId: null } });
  console.log(
    `Backfill complete. Remaining null institutionId — User: ${remainingNullUsers}, Exam: ${remainingNullExams}, LtiPlatform: ${remainingNullPlatforms}`,
  );
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
