import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRequiredEnvStatus, getLtiEnvStatus, getAiEnvStatus, getSecureLaunchSigningEnvStatus, getEvidenceStorageEnvStatus, detectDangerousEnvCombinations } from "@/lib/env/readiness";
import { deploymentEnvironment } from "@/lib/secureClientAvailability";
import { resolveTetherReleaseMetadata } from "@/lib/tetherReleaseMetadata";

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
  // Production administration hardening v1, Part J — see
  // docs/production-environment-register.md. secureLaunchSigning and
  // evidenceStorage are core-to-Tether checks, deliberately reported
  // separately from `lti`/`ai` (which are genuinely OPTIONAL
  // integrations — see the doc comments on getLtiEnvStatus/getAiEnvStatus)
  // so a Canvas/LTI misconfiguration can never read as "Tether itself is
  // unavailable," and vice versa.
  const secureLaunchSigning = getSecureLaunchSigningEnvStatus();
  const evidenceStorage = getEvidenceStorageEnvStatus();
  const releaseMetadata = resolveTetherReleaseMetadata();
  const dangerousCombinations = detectDangerousEnvCombinations(deploymentEnvironment());

  return NextResponse.json({
    databaseConnected,
    ltiKeysConfigured: lti.allPresent,
    appUrlConfigured: required.checks.find((c) => c.key === "APP_URL")?.present ?? false,
    aiKeyConfigured: ai.allPresent,
    authSecretConfigured: required.checks.find((c) => c.key === "AUTH_SECRET")?.present ?? false,
    secureLaunchSigningConfigured: secureLaunchSigning.allPresent,
    evidenceStorageConfigured: evidenceStorage.allPresent,
    // Non-secret, already-safe-to-expose fields only (see
    // resolveTetherReleaseMetadata's own doc comment) — never the
    // installer URL's internal validity details or anything beyond what
    // /api/tether/release-metadata already exposes to students.
    tetherReleaseStatus: releaseMetadata.releaseStatus,
    tetherDownloadsEnabled: releaseMetadata.downloadsEnabled,
    // Bounded reason codes + severity only — see detectDangerousEnvCombinations's own doc comment for why two commonly-named combinations are intentionally absent (structurally impossible, not merely unchecked).
    dangerousEnvCombinations: dangerousCombinations,
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
