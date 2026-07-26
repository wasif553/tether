/**
 * Tether Secure Client Foundation v1 — see
 * docs/secure-client-foundation-seb-v1.md and Part 8 of the spec.
 *
 * POST /api/submissions/[id]/secure-client/preflight
 *
 * A lightweight, pre-session compatibility check — lets the student
 * compatibility page show a live status before actually starting a
 * secure-client session. Checks SEB header-based verification if the
 * SEB request-hash headers are present; a technical failure is never
 * represented as student misconduct.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { candidateOriginFromHeaders, resolveCanonicalOrigin, buildOriginAllowlist } from "@/lib/secureClient/canonicalOrigin";
import { buildCanonicalRequestUrl, SEB_REQUEST_HASH_HEADER, SEB_CONFIG_KEY_HASH_HEADER } from "@/lib/secureClient/sebBrowserExamKey";
import { overallStatusFromChecks, type AttestationChecks, type RequiredChecks } from "@/lib/secureClient/attestation";
import { describeDisplayRequirement } from "@/lib/secureClientPolicy";
import { SecureClientError, loadValidatedSecureClientSubmission, validateSebKeyForConfiguration } from "@/lib/secureClientRunner";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let context;
  try {
    context = await loadValidatedSecureClientSubmission(id, session.user.id);
  } catch (err) {
    if (err instanceof SecureClientError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }

  // Single Display Requirement v1 — messaging-only, never a live
  // pass/fail check (there is no trustworthy browser signal for actual
  // display state — see docs/secure-client-foundation-seb-v1.md). Built
  // before the SEB-only early return below so STANDARD_WEB/MONITORED_WEB
  // exams still get an honest "not enforceable" status rather than no
  // field at all.
  const displayRequirement = describeDisplayRequirement(context.policy);

  if (context.policy.deliveryMode !== "SEB_REQUIRED" && context.policy.deliveryMode !== "SEB_OPTIONAL") {
    return NextResponse.json({
      overallStatus: "NOT_SUPPORTED",
      reason: "This exam does not use Safe Exam Browser.",
      deliveryMode: context.policy.deliveryMode,
      displayRequirement,
    });
  }

  const config = await prisma.secureClientConfiguration.findFirst({
    where: { examId: context.submission.examId, provider: "SAFE_EXAM_BROWSER", status: "ACTIVE" },
  });

  const checks: AttestationChecks = {};
  const required: RequiredChecks = {};
  let configurationInvalid = false;
  let clientVerificationFailed = false;

  if (!config) {
    configurationInvalid = true;
  } else {
    const url = new URL(req.url);
    const allowlist = buildOriginAllowlist(process.env.APP_URL);
    const canonicalOrigin = resolveCanonicalOrigin(candidateOriginFromHeaders(req.headers), allowlist);
    const canonicalUrl = buildCanonicalRequestUrl(canonicalOrigin, url.pathname, url.search);

    if (context.policy.requireSebBrowserExamKey) {
      required.clientSignature = true;
      const supplied = req.headers.get(SEB_REQUEST_HASH_HEADER);
      if (!supplied) {
        checks.clientSignature = "FAIL";
        clientVerificationFailed = true;
      } else {
        const result = await validateSebKeyForConfiguration(config.id, "BROWSER_EXAM_KEY", supplied, canonicalUrl);
        checks.clientSignature = result.status === "VALID" ? "PASS" : "FAIL";
        if (result.status !== "VALID") clientVerificationFailed = true;
      }
    }
    if (context.policy.requireSebConfigKey) {
      required.configurationVerification = true;
      const supplied = req.headers.get(SEB_CONFIG_KEY_HASH_HEADER);
      if (!supplied) {
        checks.configurationVerification = "FAIL";
        clientVerificationFailed = true;
      } else {
        const result = await validateSebKeyForConfiguration(config.id, "CONFIG_KEY", supplied, canonicalUrl);
        checks.configurationVerification = result.status === "VALID" ? "PASS" : "FAIL";
        if (result.status !== "VALID") clientVerificationFailed = true;
      }
    }
  }

  const overallStatus = overallStatusFromChecks({
    checks,
    required,
    clientVerificationFailed,
    configurationInvalid,
    versionUnsupported: false,
    technicalFailure: false,
  });

  return NextResponse.json({ overallStatus, checks, deliveryMode: context.policy.deliveryMode, displayRequirement });
}

export const dynamic = "force-dynamic";
