import bcrypt from "bcryptjs";
import { seedCanvasPlatform } from "../src/lib/lti/seedPlatform";
import { DEFAULT_INSTITUTION_SLUG } from "../src/lib/institutionScope";
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
