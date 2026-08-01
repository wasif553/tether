/**
 * Tether launch/install flow v1 — Production start-protection. See
 * src/app/api/exams/[id]/start/route.ts and
 * src/app/api/submissions/[id]/route.ts.
 *
 * Pure, dependency-free: no Prisma, no Next.js. This is the ONE place
 * that decides whether an ordinary-browser student may proceed into a
 * TETHER_CLIENT_REQUIRED attempt versus being sent to the Tether launch
 * page — callers resolve `hasVerifiedTetherSession` from the database
 * (a live, non-terminal SecureClientSession with verificationStatus
 * VERIFIED — see getCurrentSessionForSubmission in secureClientRunner.ts)
 * and `devBypassAllowed` from isTetherSecureClientBypassAllowed
 * (secureClientAvailability.ts); this function never touches either
 * itself and never trusts a user-agent string as a substitute for either.
 *
 * Deliberately scoped to TETHER_CLIENT_REQUIRED only — never
 * SEB_REQUIRED (which has its own, separate, unchanged
 * SEB_NOT_CONFIGURED gate) and never STANDARD_WEB/MONITORED_WEB, so this
 * can never retroactively affect any exam the lecturer hasn't explicitly
 * set to TETHER_CLIENT_REQUIRED.
 */
import type { DeliveryMode } from "@/lib/secureClientPolicy";

export type SecureClientStartGateResult = { kind: "ALLOW" } | { kind: "REDIRECT_TO_TETHER_LAUNCH" };

export function resolveSecureClientStartGate(input: {
  effectiveDeliveryMode: DeliveryMode;
  hasVerifiedTetherSession: boolean;
  devBypassAllowed: boolean;
}): SecureClientStartGateResult {
  if (input.effectiveDeliveryMode !== "TETHER_CLIENT_REQUIRED") return { kind: "ALLOW" };
  if (input.hasVerifiedTetherSession) return { kind: "ALLOW" };
  if (input.devBypassAllowed) return { kind: "ALLOW" };
  return { kind: "REDIRECT_TO_TETHER_LAUNCH" };
}

/** The one place the Tether launch page's URL is constructed, so every caller stays in sync. */
export function buildTetherLaunchPagePath(examId: string): string {
  return `/student/exams/${examId}/tether-launch`;
}
