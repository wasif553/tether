import { seedCanvasPlatform } from "../src/lib/lti/seedPlatform";
import { prisma } from "../src/lib/prisma";

async function main() {
  await seedCanvasPlatform();
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
