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
    // Single Display Requirement v1 — see docs/secure-client-foundation-seb-v1.md,
    // "Display requirement". Non-secret CAPABILITY status only — never a
    // per-institution live availability check (that depends on
    // VERCEL_ENV/institution allowlists, see
    // src/lib/secureClientAvailability.ts, and is deliberately not
    // exposed on this unauthenticated endpoint), and never any SEB key,
    // encryption key, signing key, or display/hardware data.
    displayPolicy: {
      standardWeb: "unsupported_in_standard_web",
      sebRequired: "supported_by_seb",
      sebOptional: "supported_by_seb",
      nativeTetherClient: "native_detection_not_available",
    },
  });
}

export const dynamic = "force-dynamic";
