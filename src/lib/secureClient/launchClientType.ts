/**
 * Tether launch/install flow v1 — pure helper for deciding which client
 * type a launch manifest should be issued for. See
 * src/app/api/submissions/[id]/secure-client/launch/route.ts.
 *
 * Pure, dependency-free: no Prisma, no Next.js. Fixes a bug where a
 * TETHER_CLIENT_REQUIRED/OPTIONAL exam with no SecureClientConfiguration
 * row (Tether needs none — there is no key/config management, unlike
 * SEB) silently fell through to the SAFE_EXAM_BROWSER default. The
 * effective delivery mode (already resolved server-side, never trusted
 * from the client) is the authoritative signal; the active
 * configuration's provider is only consulted as a fallback for the SEB
 * modes, exactly like before this fix.
 */
import type { DeliveryMode, ClientType } from "@/lib/secureClientPolicy";

export function resolveLaunchClientType(policy: { deliveryMode: DeliveryMode }, activeConfigProvider: string | null): ClientType {
  if (policy.deliveryMode === "TETHER_CLIENT_REQUIRED" || policy.deliveryMode === "TETHER_CLIENT_OPTIONAL") {
    return "TETHER_SECURE_CLIENT";
  }
  return activeConfigProvider === "TETHER_SECURE_CLIENT" ? "TETHER_SECURE_CLIENT" : "SAFE_EXAM_BROWSER";
}
