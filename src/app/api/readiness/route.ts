import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRequiredEnvStatus, getLtiEnvStatus, getAiEnvStatus } from "@/lib/env/readiness";

export async function GET() {
  let databaseConnected = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseConnected = false;
  }

  const required = getRequiredEnvStatus();
  const lti = getLtiEnvStatus();
  const ai = getAiEnvStatus();

  return NextResponse.json({
    databaseConnected,
    ltiKeysConfigured: lti.allPresent,
    appUrlConfigured: required.checks.find((c) => c.key === "APP_URL")?.present ?? false,
    aiKeyConfigured: ai.allPresent,
    authSecretConfigured: required.checks.find((c) => c.key === "AUTH_SECRET")?.present ?? false,
  });
}

export const dynamic = "force-dynamic";
