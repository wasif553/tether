/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md.
 *
 * POST /api/secure-client/sessions/[sessionId]/attestation
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { CHECK_STATUSES, ATTESTATION_CHECK_KEYS, MAX_REPORTED_DISPLAY_COUNT, DISPLAY_TOPOLOGIES } from "@/lib/secureClient/attestation";
import { SecureClientError, loadValidatedSecureClientSession, recordAttestation } from "@/lib/secureClientRunner";
import { DISPLAY_DIAGNOSTIC_OUTCOMES } from "@/lib/tetherLaunch";

const checkStatusSchema = z.enum(CHECK_STATUSES);
const checksSchema = z
  .object(Object.fromEntries(ATTESTATION_CHECK_KEYS.map((k) => [k, checkStatusSchema.optional()])))
  .strict();

// P0 runtime display-bridge failure capture — see
// docs/tether-secure-launch-verification-investigation.md. Evidence
// only: this is never read by recordAttestation to decide
// overallStatus/verificationStatus — see that function's own doc
// comment. Bounded server-side too (never trust the client's own
// truncation alone) — matches the exact caps enforced client-side in
// buildDisplayInvokeFailedDiagnostic (tetherLaunch.ts): ~100 chars for
// errorName, ~300 for errorMessage. `.strict()` so no unexpected extra
// field (e.g. a stack trace) can ever be smuggled through.
const displayDiagnosticSchema = z
  .object({
    outcome: z.enum(DISPLAY_DIAGNOSTIC_OUTCOMES),
    errorName: z.string().max(100).optional(),
    errorMessage: z.string().max(300).optional(),
  })
  .strict()
  .optional();

const bodySchema = z.object({
  platform: z.string().max(50).optional(),
  osVersion: z.string().max(50).optional(),
  clientVersion: z.string().max(50).optional(),
  clientBuild: z.string().max(50).optional(),
  checks: checksSchema,
  required: z.record(z.string(), z.boolean()).optional(),
  clientVerificationFailed: z.boolean().optional(),
  configurationInvalid: z.boolean().optional(),
  versionUnsupported: z.boolean().optional(),
  technicalFailure: z.boolean().optional(),
  // Single Display Requirement v1 (Part 6) — bounded and optional; only
  // ever honoured server-side for a client type that actually supports
  // displayCheck (see recordAttestation in secureClientRunner.ts, which
  // silently drops these for a SAFE_EXAM_BROWSER session).
  displayCount: z.number().int().min(1).max(MAX_REPORTED_DISPLAY_COUNT).optional(),
  displayTopology: z.enum(DISPLAY_TOPOLOGIES).optional(),
  displayDiagnostic: displayDiagnosticSchema,
});

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { sessionId } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let loaded;
  try {
    loaded = await loadValidatedSecureClientSession(sessionId, session.user.id);
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  const result = await recordAttestation({
    sessionId,
    clientType: loaded.session.clientType,
    platform: parsed.data.platform ?? null,
    osVersion: parsed.data.osVersion ?? null,
    clientVersion: parsed.data.clientVersion ?? null,
    clientBuild: parsed.data.clientBuild ?? null,
    checks: parsed.data.checks,
    required: (parsed.data.required as Record<string, boolean>) ?? {},
    clientVerificationFailed: parsed.data.clientVerificationFailed ?? false,
    configurationInvalid: parsed.data.configurationInvalid ?? false,
    versionUnsupported: parsed.data.versionUnsupported ?? false,
    technicalFailure: parsed.data.technicalFailure ?? false,
    clientReportedAt: new Date(),
    displayCount: parsed.data.displayCount ?? null,
    displayTopology: parsed.data.displayTopology ?? null,
    displayDiagnostic: parsed.data.displayDiagnostic ?? null,
  });

  // Release-blocking server content-boundary audit, follow-up fix — see
  // tetherContentAccessLease.ts. This endpoint MUST NEVER issue the
  // protected-content lease: the request body above (checks, required,
  // displayCount, clientVersion, ...) is entirely client-self-reported —
  // there is no installation private-key signature or any other native
  // possession proof anywhere in this flow. An ordinary authenticated
  // browser can POST a fabricated body straight to this endpoint (e.g.
  // { checks: {}, required: {} }, which always resolves to overallStatus
  // READY — see overallStatusFromChecks) and would otherwise be able to
  // manufacture the lease itself, defeating the entire request-binding
  // guarantee. This route continues to exist ONLY for the legacy
  // SecureClientSession.verificationStatus compatibility decision (see
  // tetherAttestationConfig.ts's LEGACY/DUAL/V2_REQUIRED truth table) —
  // never as a source of proof for protected content access. See
  // src/app/api/tether/exam-session/attestation/verify/route.ts for the
  // ONE place a lease is ever issued (genuine installation-key signature
  // verification), and tether-launch/page.tsx's submitExamSessionAttestationV2
  // for why that v2 step is now REQUIRED (not best-effort) for a real
  // TETHER_SECURE_CLIENT launch.
  return NextResponse.json({ ok: true, overallStatus: result.overallStatus, attestationId: result.attestation.id }, { status: 201 });
}

export const dynamic = "force-dynamic";
