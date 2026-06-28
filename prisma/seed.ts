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
  const adminEmail = "admin@ses-platform.com";
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? "SESAdmin2025!";
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await prisma.user.create({
      data: {
        name: "Platform Admin",
        email: adminEmail,
        passwordHash,
        role: "PLATFORM_ADMIN",
        institutionId: defaultInstitution.id,
      },
    });
    console.log("PLATFORM_ADMIN created:", adminEmail);
    console.log("Password from PLATFORM_ADMIN_PASSWORD env var or default");
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
