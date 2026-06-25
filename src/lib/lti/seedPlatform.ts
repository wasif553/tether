import { prisma } from "@/lib/prisma";

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function seedCanvasPlatform(): Promise<void> {
  const existing = await prisma.ltiPlatform.findFirst();
  if (existing) {
    console.log(`LTI platform already seeded (issuer: ${existing.issuer}) — skipping.`);
    return;
  }

  const issuer = readRequiredEnv("LTI_PLATFORM_ISSUER");
  const clientId = readRequiredEnv("LTI_CLIENT_ID");
  const authEndpoint = readRequiredEnv("LTI_PLATFORM_OIDC_AUTH");
  const tokenEndpoint = readRequiredEnv("LTI_TOKEN_ENDPOINT");
  const jwksUrl = readRequiredEnv("LTI_PLATFORM_JWKS");
  const deploymentId = readRequiredEnv("LTI_DEPLOYMENT_ID");

  const platform = await prisma.ltiPlatform.create({
    data: {
      issuer,
      clientId,
      authEndpoint,
      tokenEndpoint,
      jwksUrl,
      deploymentId,
    },
  });

  console.log(`Created LtiPlatform ${platform.id} for issuer ${platform.issuer}`);
}

const entrypoint = process.argv[1]?.replace(/\\/g, "/") ?? "";
const isDirectExecution = entrypoint.endsWith("seedPlatform.ts") || entrypoint.endsWith("seedPlatform.js");

if (isDirectExecution) {
  seedCanvasPlatform()
    .catch((err) => {
      console.error("Failed to seed Canvas LTI platform:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
